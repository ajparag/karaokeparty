import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Target compressed size per track (in bytes) - aim for ~1.2MB each to stay under 2.5MB total
const TARGET_SIZE_BYTES = 1_200_000;

// Use fast Spleeter-based spaces - ~3x faster than Demucs with acceptable quality
const PRIMARY_SPACE = "Harsha123456/Spleeter"; // Spleeter - fast, good quality
const FALLBACK_SPACE = "abidlabs/music-separation"; // Demucs v4 as fallback - slower but higher quality

// Retry with exponential backoff for HF cold starts
async function connectWithRetry(spaceId: string, hfToken: string, maxRetries = 2): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[separate-vocals] Connection attempt ${attempt}/${maxRetries} to ${spaceId}...`);
      const client = await Client.connect(spaceId, {
        hf_token: hfToken as `hf_${string}`,
      });
      console.log(`[separate-vocals] Connected on attempt ${attempt}`);
      return { client, spaceId };
    } catch (error) {
      console.error(`[separate-vocals] Attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      // Shorter backoff: 1s, 2s (faster retries)
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`[separate-vocals] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      if (typeof v === "bigint") return v.toString();
      return v;
    },
    2,
  );
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string; raw?: unknown } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  // Some libs throw plain objects (e.g., Gradio status objects)
  return {
    message: "Non-Error thrown",
    raw: err,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

// Try primary space first, fall back to alternative if needed
async function connectToFastestSpace(hfToken: string): Promise<any> {
  try {
    return await connectWithRetry(PRIMARY_SPACE, hfToken, 2);
  } catch (primaryError) {
    console.log(`[separate-vocals] Primary space failed, trying fallback...`);
    try {
      return await connectWithRetry(FALLBACK_SPACE, hfToken, 2);
    } catch (fallbackError) {
      console.error(`[separate-vocals] All spaces failed`);
      throw primaryError; // Throw original error
    }
  }
}

// Quick health check / warm-up for HF space
async function warmUpSpace(hfToken: string): Promise<boolean> {
  try {
    console.log("[separate-vocals] Warming up HF space...");
    const startTime = Date.now();
    
    // Just try to connect - this wakes up the space
    const client = await Client.connect(PRIMARY_SPACE, {
      hf_token: hfToken as `hf_${string}`,
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`[separate-vocals] Space warmed up in ${elapsed}ms`);
    
    return true;
  } catch (error) {
    console.warn("[separate-vocals] Warm-up failed:", error);
    return false;
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    // Handle warm-up request (quick health check)
    if (contentType.includes("application/json")) {
      const body = await req.json();
      
      if (body.warmUp) {
        console.log("[separate-vocals] Received warm-up request");
        const HF_TOKEN = Deno.env.get("HF_TOKEN");
        if (!HF_TOKEN) {
          return new Response(
            JSON.stringify({ ready: false, error: "HF_TOKEN not configured" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        const ready = await warmUpSpace(HF_TOKEN);
        return new Response(
          JSON.stringify({ ready }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      // Legacy JSON handling for audioUrl/audioBase64
      const { audioUrl, audioBase64 } = body;
      
      if (!audioUrl && !audioBase64) {
        return new Response(
          JSON.stringify({ error: "audioUrl or audioBase64 is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      let audioBlob: Blob;
      
      if (audioBase64) {
        console.log("[separate-vocals] Using client-provided base64 audio data...");
        const binaryString = atob(audioBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        audioBlob = new Blob([bytes], { type: 'audio/mp4' });
      } else {
        console.log("[separate-vocals] Fetching audio from URL:", audioUrl);
        const audioResponse = await fetch(audioUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'audio/*, */*',
          },
        });
        
        if (!audioResponse.ok) {
          throw new Error(`Failed to fetch audio: ${audioResponse.status}`);
        }
        
        audioBlob = await audioResponse.blob();
      }
      
      console.log(`[separate-vocals] Audio size: ${audioBlob.size} bytes`);
      
      // Continue with separation...
      return await processSeparation(audioBlob);
    }

    // Handle FormData (streaming - preferred)
    if (contentType.includes("multipart/form-data")) {
      console.log("[separate-vocals] Processing FormData upload (streaming)...");
      const formData = await req.formData();
      const audioFile = formData.get("audio");
      
      if (!audioFile || !(audioFile instanceof File)) {
        return new Response(
          JSON.stringify({ error: "audio file is required in FormData" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      console.log(`[separate-vocals] Received audio: ${audioFile.size} bytes, type: ${audioFile.type}`);
      return await processSeparation(audioFile);
    }

    return new Response(
      JSON.stringify({ error: "Invalid content type" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const serialized = serializeError(error);
    console.error("[separate-vocals] Error:", safeJsonStringify(serialized));
    return new Response(
      JSON.stringify({ 
        error: serialized.message,
        details: serialized,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function processSeparation(audioBlob: Blob): Promise<Response> {
  const HF_TOKEN = Deno.env.get("HF_TOKEN");
  if (!HF_TOKEN) {
    console.error("HF_TOKEN not configured");
    return new Response(
      JSON.stringify({ error: "HF_TOKEN not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  console.log("[separate-vocals] Connecting to fastest available HF space...");

  // Predict can fail even after a successful connect (HF queue / cold restart / transient network).
  // We retry and allow fallback space on predict failure.
  const maxPredictAttempts = 3;
  let lastPredictError: unknown = null;
  let result: any = null;
  let usedSpaceId: string | null = null;

  for (let attempt = 1; attempt <= maxPredictAttempts; attempt++) {
    try {
      // Connect (primary, then fallback)
      const { client, spaceId } = await connectToFastestSpace(HF_TOKEN);
      usedSpaceId = spaceId;
      console.log(`[separate-vocals] Predict attempt ${attempt}/${maxPredictAttempts} using ${spaceId}...`);

      // Call predict with a generous timeout (HF queues can be slow)
      result = await withTimeout(
        client.predict("/predict", { audio: audioBlob }),
        120_000,
        "HF /predict",
      );

      break; // success
    } catch (err) {
      lastPredictError = err;
      const serialized = serializeError(err);
      console.error(
        `[separate-vocals] Predict attempt ${attempt} failed:`,
        safeJsonStringify(serialized),
      );

      if (attempt < maxPredictAttempts) {
        // Backoff: 1s, 2s
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`[separate-vocals] Retrying predict in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (!result) {
    const serialized = serializeError(lastPredictError);
    return new Response(
      JSON.stringify({
        error: "Separation failed",
        details: serialized,
        success: false,
        spaceId: usedSpaceId,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log("[separate-vocals] Separation complete, processing result...");

  const data = result.data as any;
  console.log("[separate-vocals] Raw result data:", safeJsonStringify(data));
  
  let instrumentalUrl: string | null = null;
  let vocalsUrl: string | null = null;

  // Parse result - handle various HF space output formats
  // Demucs v4 returns: [{url, orig_name, path, ...}, {url, orig_name, path, ...}]
  // where orig_name contains the stem type (e.g., "no_vocals.wav", "vocals.wav")
  if (Array.isArray(data)) {
    // Check filenames/orig_name to determine which is which
    for (const item of data) {
      if (item && typeof item === 'object') {
        const url = item.url as string;
        const origName = (item.orig_name || item.path || '').toLowerCase();
        const urlLower = (url || '').toLowerCase();
        const checkString = origName || urlLower;
        
        console.log("[separate-vocals] Checking item:", { url: url?.slice(0, 80), origName, checkString });
        
        if (checkString.includes('no_vocals') || checkString.includes('no-vocals') || 
            checkString.includes('instrumental') || checkString.includes('accompaniment') || 
            checkString.includes('other') || checkString.includes('music')) {
          instrumentalUrl = url;
          console.log("[separate-vocals] Found instrumental:", origName);
        } else if (checkString.includes('vocals') || checkString.includes('voice')) {
          vocalsUrl = url;
          console.log("[separate-vocals] Found vocals:", origName);
        }
      } else if (typeof item === 'string') {
        // Direct URL strings
        const urlLower = item.toLowerCase();
        if (urlLower.includes('no_vocals') || urlLower.includes('no-vocals') ||
            urlLower.includes('instrumental') || urlLower.includes('accompaniment')) {
          instrumentalUrl = item;
        } else if (urlLower.includes('vocals') || urlLower.includes('voice')) {
          vocalsUrl = item;
        }
      }
    }
    
    // Fallback: positional assignment if we found URLs but couldn't identify them
    // Demucs typically outputs [vocals, no_vocals] or [no_vocals, vocals]
    if (data.length >= 2) {
      const getUrl = (item: any) => typeof item === 'string' ? item : item?.url;
      const url0 = getUrl(data[0]);
      const url1 = getUrl(data[1]);
      
      if (url0 && url1) {
        // If we don't have both, try to assign based on position
        if (!instrumentalUrl || !vocalsUrl) {
          // Demucs v4 typically: first = no_vocals/accompaniment, second = vocals
          instrumentalUrl = instrumentalUrl || url0;
          vocalsUrl = vocalsUrl || url1;
          console.log("[separate-vocals] Using positional fallback - instrumental:", url0?.slice(0, 50), "vocals:", url1?.slice(0, 50));
        }
      }
    }
  } else if (data && typeof data === 'object') {
    // Object format with named keys
    if (data.no_vocals?.url) instrumentalUrl = data.no_vocals.url;
    else if (typeof data.no_vocals === 'string') instrumentalUrl = data.no_vocals;
    else if (data.instrumental?.url) instrumentalUrl = data.instrumental.url;
    else if (typeof data.instrumental === 'string') instrumentalUrl = data.instrumental;
    else if (data.accompaniment?.url) instrumentalUrl = data.accompaniment.url;
    else if (typeof data.accompaniment === 'string') instrumentalUrl = data.accompaniment;
    
    if (data.vocals?.url) vocalsUrl = data.vocals.url;
    else if (typeof data.vocals === 'string') vocalsUrl = data.vocals;
  }

  console.log("[separate-vocals] Final URLs - instrumental:", instrumentalUrl?.slice(0, 80), "vocals:", vocalsUrl?.slice(0, 80));

  if (!instrumentalUrl) {
    // Try fallback: if we have any URL at all, use it as instrumental
    if (Array.isArray(data) && data.length > 0) {
      const firstItem = data[0];
      instrumentalUrl = typeof firstItem === 'string' ? firstItem : firstItem?.url;
      console.log("[separate-vocals] Fallback: using first URL as instrumental:", instrumentalUrl?.slice(0, 80));
    }
    
    if (!instrumentalUrl) {
      console.error("[separate-vocals] Could not find instrumental URL in result:", safeJsonStringify(data));
      return new Response(
        JSON.stringify({ error: "Failed to extract instrumental track from result", rawData: data }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // Download and compress both tracks to reduce client download size
  console.log("[separate-vocals] Downloading and compressing tracks...");
  
  try {
    // Download tracks in parallel
    const [instrumentalBuffer, vocalsBuffer] = await Promise.all([
      downloadAndCompress(instrumentalUrl, "instrumental"),
      vocalsUrl ? downloadAndCompress(vocalsUrl, "vocals") : Promise.resolve(null),
    ]);

    if (!instrumentalBuffer) {
      throw new Error("Failed to get instrumental buffer");
    }

    const totalSize = instrumentalBuffer.byteLength + (vocalsBuffer?.byteLength || 0);
    console.log("[separate-vocals] Compression complete! Total:", Math.round(totalSize / 1024), "KB");

    // Return as binary blob with simple format:
    // [4 bytes: instrumental size (uint32 LE)]
    // [instrumental WAV data]
    // [vocals WAV data (remaining bytes, if any)]
    const binaryResponse = new Uint8Array(4 + instrumentalBuffer.byteLength + (vocalsBuffer?.byteLength || 0));
    const sizeView = new DataView(binaryResponse.buffer);
    sizeView.setUint32(0, instrumentalBuffer.byteLength, true); // little-endian
    binaryResponse.set(new Uint8Array(instrumentalBuffer), 4);
    if (vocalsBuffer) {
      binaryResponse.set(new Uint8Array(vocalsBuffer), 4 + instrumentalBuffer.byteLength);
    }

    return new Response(binaryResponse.buffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "X-Instrumental-Size": instrumentalBuffer.byteLength.toString(),
        "X-Vocals-Size": (vocalsBuffer?.byteLength || 0).toString(),
        "X-Total-Size": totalSize.toString(),
      },
    });
  } catch (downloadError) {
    // Fallback to URL mode if compression fails
    console.warn("[separate-vocals] Compression failed, returning URLs:", downloadError);
    return new Response(
      JSON.stringify({
        instrumentalUrl,
        vocalsUrl,
        success: true,
        compressed: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Download audio from HF and compress to smaller size - returns ArrayBuffer
async function downloadAndCompress(url: string, label: string): Promise<ArrayBuffer | null> {
  try {
    console.log(`[separate-vocals] Downloading ${label} from HF...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status}`);
    }
    
    const originalBuffer = await response.arrayBuffer();
    const originalSize = originalBuffer.byteLength;
    console.log(`[separate-vocals] ${label} original size: ${Math.round(originalSize / 1024)}KB`);
    
    // The HF spaces return WAV files. We'll downsample to reduce size.
    // For maximum compatibility, we return a smaller WAV (mono, 22kHz, 16-bit)
    // This typically achieves 4x size reduction while maintaining karaoke quality.
    const compressedBuffer = await compressWavAudio(originalBuffer, label);
    const compressedSize = compressedBuffer.byteLength;
    
    console.log(`[separate-vocals] ${label} compressed: ${Math.round(originalSize / 1024)}KB -> ${Math.round(compressedSize / 1024)}KB (${Math.round((1 - compressedSize / originalSize) * 100)}% reduction)`);
    
    return compressedBuffer;
  } catch (error) {
    console.error(`[separate-vocals] Failed to download/compress ${label}:`, error);
    throw error;
  }
}

// Compress WAV by downsampling to mono 22kHz 16-bit
async function compressWavAudio(buffer: ArrayBuffer, label: string): Promise<ArrayBuffer> {
  const view = new DataView(buffer);
  
  // Parse WAV header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') {
    console.warn(`[separate-vocals] ${label} is not a WAV file, returning as-is`);
    return buffer;
  }
  
  // Read WAV format info
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  
  console.log(`[separate-vocals] ${label} WAV: ${numChannels}ch, ${sampleRate}Hz, ${bitsPerSample}bit`);
  
  // Find data chunk
  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset < buffer.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(dataOffset),
      view.getUint8(dataOffset + 1),
      view.getUint8(dataOffset + 2),
      view.getUint8(dataOffset + 3)
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    
    if (chunkId === 'data') {
      dataSize = chunkSize;
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }
  
  if (dataSize === 0) {
    console.warn(`[separate-vocals] ${label} data chunk not found`);
    return buffer;
  }
  
  // Extract samples
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = dataSize / (bytesPerSample * numChannels);
  
  // Target: mono 22050Hz 16-bit (good for karaoke, ~4x smaller than stereo 44.1kHz)
  const targetSampleRate = 22050;
  const targetChannels = 1;
  const targetBitsPerSample = 16;
  
  // Calculate resampling ratio
  const ratio = sampleRate / targetSampleRate;
  const outputSamples = Math.floor(numSamples / ratio);
  
  // Create output buffer
  const outputBytesPerSample = targetBitsPerSample / 8;
  const outputDataSize = outputSamples * outputBytesPerSample * targetChannels;
  const outputBuffer = new ArrayBuffer(44 + outputDataSize);
  const outputView = new DataView(outputBuffer);
  
  // Write WAV header
  writeString(outputView, 0, 'RIFF');
  outputView.setUint32(4, 36 + outputDataSize, true);
  writeString(outputView, 8, 'WAVE');
  writeString(outputView, 12, 'fmt ');
  outputView.setUint32(16, 16, true); // Subchunk1Size
  outputView.setUint16(20, 1, true); // AudioFormat (PCM)
  outputView.setUint16(22, targetChannels, true);
  outputView.setUint32(24, targetSampleRate, true);
  outputView.setUint32(28, targetSampleRate * targetChannels * outputBytesPerSample, true); // ByteRate
  outputView.setUint16(32, targetChannels * outputBytesPerSample, true); // BlockAlign
  outputView.setUint16(34, targetBitsPerSample, true);
  writeString(outputView, 36, 'data');
  outputView.setUint32(40, outputDataSize, true);
  
  // Resample and mix to mono with linear interpolation
  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    
    let sample = 0;
    
    // Mix all channels to mono with interpolation
    for (let ch = 0; ch < numChannels; ch++) {
      const offset1 = dataOffset + (srcIdx * numChannels + ch) * bytesPerSample;
      const offset2 = dataOffset + (Math.min(srcIdx + 1, numSamples - 1) * numChannels + ch) * bytesPerSample;
      
      let s1 = 0, s2 = 0;
      
      if (bitsPerSample === 16) {
        s1 = view.getInt16(offset1, true);
        s2 = view.getInt16(offset2, true);
      } else if (bitsPerSample === 24) {
        s1 = (view.getUint8(offset1) | (view.getUint8(offset1 + 1) << 8) | (view.getInt8(offset1 + 2) << 16));
        s2 = (view.getUint8(offset2) | (view.getUint8(offset2 + 1) << 8) | (view.getInt8(offset2 + 2) << 16));
        s1 = s1 >> 8; // Convert to 16-bit range
        s2 = s2 >> 8;
      } else if (bitsPerSample === 32) {
        // Assume 32-bit float
        s1 = Math.round(view.getFloat32(offset1, true) * 32767);
        s2 = Math.round(view.getFloat32(offset2, true) * 32767);
      }
      
      // Linear interpolation
      sample += s1 + (s2 - s1) * frac;
    }
    
    // Average channels
    sample = Math.round(sample / numChannels);
    
    // Clamp to 16-bit range
    sample = Math.max(-32768, Math.min(32767, sample));
    
    // Write output sample
    outputView.setInt16(44 + i * outputBytesPerSample, sample, true);
  }
  
  return outputBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
