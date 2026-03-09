import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@gradio/client@1.8.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AAC_SPACE = "ajparag/demucs-stem-separation";

/**
 * Connects to the Hugging Face Space to ensure it is awake and ready.
 */
async function warmUpSpace(hfToken: string): Promise<boolean> {
  try {
    console.log("[separate-vocals] Warming up HF space...");
    const startTime = Date.now();
    await Client.connect(AAC_SPACE, {
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
    const body = await req.json();
    const { audioUrl, warmUp } = body;
    const HF_TOKEN = Deno.env.get("HF_TOKEN");

    if (!HF_TOKEN) {
      throw new Error("HF_TOKEN secret is not configured in Supabase.");
    }

    // 1. Handle Warm-up Logic
    if (warmUp) {
      const ready = await warmUpSpace(HF_TOKEN);
      return new Response(
        JSON.stringify({ ready }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Handle Actual Audio Separation
    if (!audioUrl) {
      return new Response(
        JSON.stringify({ error: "audioUrl is required for separation" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[separate-vocals] Initializing connection for separation...");
    const client = await Client.connect(AAC_SPACE, {
      hf_token: HF_TOKEN as `hf_${string}`,
    });

    console.log("[separate-vocals] Processing audio:", audioUrl);
    
    // Call the specific 'predict' endpoint. 
    // Based on standard Demucs Gradio implementations, the endpoint is usually index 0 or "/predict"
    const result = await client.predict("/predict", [
      audioUrl, 
    ]);

    /**
     * The result.data typically returns an array of file objects:
     * result.data[0] = Vocals Audio File
     * result.data[1] = Instrumental Audio File
     */
    const vocals = result.data[0];
    const instrumental = result.data[1];

    console.log("[separate-vocals] Separation complete.");

    return new Response(
      JSON.stringify({
        success: true,
        vocals: vocals?.url || vocals, // Handles both object and string return types
        instrumental: instrumental?.url || instrumental,
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );

  } catch (error) {
    console.error("[separate-vocals] Critical Error:", error);
    return new Response(
      JSON.stringify({ 
        error: error.message,
        details: "Ensure the Hugging Face space is public or the HF_TOKEN has 'read' permissions."
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
