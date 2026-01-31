import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Use reliable Demucs-based spaces - better quality and more stable
const PRIMARY_SPACE = "abidlabs/music-separation"; // Demucs v4 - stable, high quality
const FALLBACK_SPACE = "r3gm/Audio_separator"; // Alternative Demucs - also stable

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
    console.error("[separate-vocals] Could not find instrumental URL in result:", safeJsonStringify(data));
    return new Response(
      JSON.stringify({ error: "Failed to extract instrumental track from result", rawData: data }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  console.log("[separate-vocals] Success! Instrumental URL:", instrumentalUrl);

  return new Response(
    JSON.stringify({
      instrumentalUrl,
      vocalsUrl,
      success: true,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
