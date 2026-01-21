import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Retry with exponential backoff for HF cold starts
async function connectWithRetry(spaceId: string, hfToken: string, maxRetries = 3): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[separate-vocals] Connection attempt ${attempt}/${maxRetries}...`);
      const client = await Client.connect(spaceId, {
        hf_token: hfToken as `hf_${string}`,
      });
      console.log(`[separate-vocals] Connected on attempt ${attempt}`);
      return client;
    } catch (error) {
      console.error(`[separate-vocals] Attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[separate-vocals] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let audioBlob: Blob;
    const contentType = req.headers.get("content-type") || "";

    // Handle FormData (streaming - preferred) or JSON (legacy base64)
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
      
      audioBlob = audioFile;
      console.log(`[separate-vocals] Received audio: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
    } else {
      // Legacy JSON/base64 handling
      const { audioUrl, audioBase64 } = await req.json();

      if (!audioUrl && !audioBase64) {
        return new Response(
          JSON.stringify({ error: "audioUrl or audioBase64 is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (audioBase64) {
        console.log("[separate-vocals] Using client-provided base64 audio data...");
        const binaryString = atob(audioBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        audioBlob = new Blob([bytes], { type: 'audio/mp4' });
        console.log(`[separate-vocals] Audio blob created: ${audioBlob.size} bytes`);
      } else {
        console.log("[separate-vocals] Fetching audio from URL:", audioUrl);
        const audioResponse = await fetch(audioUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'audio/*, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.jiosaavn.com/',
            'Origin': 'https://www.jiosaavn.com',
          },
        });
        
        if (!audioResponse.ok) {
          console.error(`[separate-vocals] Audio fetch failed: ${audioResponse.status} ${audioResponse.statusText}`);
          throw new Error(`Failed to fetch audio: ${audioResponse.status} ${audioResponse.statusText}`);
        }
        
        audioBlob = await audioResponse.blob();
        console.log(`[separate-vocals] Audio fetched: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
      }
    }

    const HF_TOKEN = Deno.env.get("HF_TOKEN");
    if (!HF_TOKEN) {
      console.error("HF_TOKEN not configured");
      return new Response(
        JSON.stringify({ error: "HF_TOKEN not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[separate-vocals] Connecting to Demucs Space with retry...");
    
    // Connect with retry for cold starts
    const client = await connectWithRetry("abidlabs/music-separation", HF_TOKEN);

    console.log("[separate-vocals] Submitting to Demucs for separation...");
    
    // Call the predict endpoint with the audio blob
    const result = await client.predict("/predict", {
      audio: audioBlob,
    });

    console.log("[separate-vocals] Separation complete, processing result...");

    const data = result.data as any;
    console.log("[separate-vocals] Raw result data:", JSON.stringify(data, null, 2));
    
    let instrumentalUrl: string | null = null;
    let vocalsUrl: string | null = null;

    if (Array.isArray(data)) {
      // Check filenames to determine which is which
      for (const item of data) {
        if (item && typeof item === 'object' && 'url' in item) {
          const url = item.url as string;
          if (url.includes('no_vocals') || url.includes('instrumental') || url.includes('accompaniment')) {
            instrumentalUrl = url;
          } else if (url.includes('vocals')) {
            vocalsUrl = url;
          }
        }
      }
      
      // Fallback: positional assignment [vocals, no_vocals]
      if (!instrumentalUrl && !vocalsUrl && data.length >= 2) {
        if (data[0]?.url && data[1]?.url) {
          vocalsUrl = data[0].url;
          instrumentalUrl = data[1].url;
          console.log("[separate-vocals] Using positional assignment: vocals first, instrumental second");
        }
      }
    } else if (data && typeof data === 'object') {
      if (data.no_vocals?.url) instrumentalUrl = data.no_vocals.url;
      if (data.vocals?.url) vocalsUrl = data.vocals.url;
      if (typeof data.no_vocals === 'string') instrumentalUrl = data.no_vocals;
      if (typeof data.vocals === 'string') vocalsUrl = data.vocals;
    }

    if (!instrumentalUrl) {
      console.error("[separate-vocals] Could not find instrumental URL in result:", JSON.stringify(data));
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

  } catch (error) {
    console.error("[separate-vocals] Error:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Unknown error",
        details: String(error)
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
