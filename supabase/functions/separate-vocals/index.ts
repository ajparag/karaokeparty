import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { audioUrl } = await req.json();

    if (!audioUrl) {
      return new Response(
        JSON.stringify({ error: "audioUrl is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const HF_TOKEN = Deno.env.get("HF_TOKEN");
    if (!HF_TOKEN) {
      console.error("HF_TOKEN not configured");
      return new Response(
        JSON.stringify({ error: "HF_TOKEN not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[separate-vocals] Connecting to Demucs Space...");
    
    // Connect to the Demucs v4 Space using Gradio client
    const client = await Client.connect("abidlabs/music-separation", {
      hf_token: HF_TOKEN as `hf_${string}`,
    });

    console.log("[separate-vocals] Fetching audio from URL...");
    
    // Fetch the audio file from the URL
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
    }
    
    const audioBlob = await audioResponse.blob();
    console.log(`[separate-vocals] Audio fetched: ${audioBlob.size} bytes, type: ${audioBlob.type}`);

    console.log("[separate-vocals] Submitting to Demucs for separation...");
    
    // Call the predict endpoint with the audio blob
    // Demucs v4 Space typically returns [vocals, drums, bass, other] or similar
    const result = await client.predict("/predict", {
      audio: audioBlob,
    });

    console.log("[separate-vocals] Separation complete, processing result...");

    // The result.data contains the separated tracks
    // For abidlabs/music-separation, it returns { vocals: url, no_vocals: url } or similar
    const data = result.data as any;
    
    // Different Spaces have different output formats
    // abidlabs/music-separation typically returns instrumental (no_vocals) and vocals separately
    let instrumentalUrl: string | null = null;
    let vocalsUrl: string | null = null;

    if (Array.isArray(data)) {
      // Some Spaces return [instrumental, vocals] as array of objects with url
      for (const item of data) {
        if (item && typeof item === 'object' && 'url' in item) {
          // First one is typically instrumental/no-vocals
          if (!instrumentalUrl) {
            instrumentalUrl = item.url;
          } else if (!vocalsUrl) {
            vocalsUrl = item.url;
          }
        }
      }
    } else if (data && typeof data === 'object') {
      // Some Spaces return { no_vocals: {url}, vocals: {url} }
      if (data.no_vocals?.url) instrumentalUrl = data.no_vocals.url;
      if (data.vocals?.url) vocalsUrl = data.vocals.url;
      // Or direct URLs
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
