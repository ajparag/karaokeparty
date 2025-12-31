import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Maximum audio size: 25MB
const MAX_AUDIO_SIZE = 25 * 1024 * 1024;

// Decode base64 safely in chunks (avoids huge intermediate strings)
function decodeBase64ToBytes(base64: string, chunkSize = 32768) {
  const chunks: Uint8Array[] = [];
  let position = 0;

  while (position < base64.length) {
    const chunk = base64.slice(position, position + chunkSize);
    const binaryChunk = atob(chunk);
    const bytes = new Uint8Array(binaryChunk.length);
    for (let i = 0; i < binaryChunk.length; i++) {
      bytes[i] = binaryChunk.charCodeAt(i);
    }
    chunks.push(bytes);
    position += chunkSize;
  }

  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header provided");
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the JWT token
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      console.error("Invalid authentication:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Invalid authentication" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Authenticated user: ${user.id}`);

    const { audio } = await req.json();

    // Input validation: check audio exists and is a string
    if (!audio || typeof audio !== "string") {
      console.error("Invalid audio data provided");
      return new Response(JSON.stringify({ error: "Invalid audio data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check estimated size before decoding (base64 is ~4/3 the size of binary)
    const estimatedSize = (audio.length * 3) / 4;
    if (estimatedSize > MAX_AUDIO_SIZE) {
      console.error(`Audio too large: estimated ${Math.round(estimatedSize / 1024 / 1024)}MB`);
      return new Response(
        JSON.stringify({ error: `Audio too large (max ${MAX_AUDIO_SIZE / 1024 / 1024}MB)` }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const openAIApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAIApiKey) {
      console.error("OPENAI_API_KEY not configured");
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Processing audio for transcription...");

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64ToBytes(audio);
    } catch (decodeError) {
      console.error("Failed to decode base64 audio:", decodeError);
      return new Response(JSON.stringify({ error: "Invalid base64 audio data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Final size check after decoding
    if (bytes.length > MAX_AUDIO_SIZE) {
      console.error(`Audio size exceeds limit: ${bytes.length} bytes`);
      return new Response(JSON.stringify({ error: "Audio size exceeds limit" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Audio size: ${bytes.length} bytes`);

    const formData = new FormData();
    // Create a new ArrayBuffer copy to ensure compatibility
    const arrayBuffer = new ArrayBuffer(bytes.length);
    new Uint8Array(arrayBuffer).set(bytes);
    const blob = new Blob([arrayBuffer], { type: "audio/webm" });
    formData.append("file", blob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAIApiKey}`,
      },
      body: formData,
    });

    // IMPORTANT: avoid returning 402/429 from this function because it can surface as a runtime error
    // in some environments; instead return 200 with an error payload so the app can gracefully disable
    // transcription while continuing the karaoke session.
    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);

      let message = `Transcription provider error (${response.status})`;
      try {
        const parsed = JSON.parse(errorText);
        const apiMsg = parsed?.error?.message;
        if (typeof apiMsg === "string" && apiMsg.trim()) message = apiMsg;
      } catch {
        // ignore non-JSON error bodies
      }

      // Quota/rate-limit: return 200 with a structured error so the frontend can disable transcription
      if (response.status === 402 || response.status === 429) {
        return new Response(JSON.stringify({
          error: message,
          provider_status: response.status,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Other upstream errors: forward status
      return new Response(JSON.stringify({ error: message }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    console.log("Transcription result:", result.text?.substring(0, 100));

    return new Response(JSON.stringify({ text: result.text || "" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Transcription error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
