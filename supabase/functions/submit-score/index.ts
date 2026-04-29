import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_RATINGS = new Set(["L", "S", "A", "B", "C", "D", "F"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new Error("Invalid text field");
    return null;
  }

  const cleaned = value.trim().replace(/[<>]/g, "").slice(0, maxLength);
  if (required && cleaned.length === 0) throw new Error("Missing required text field");
  return cleaned.length ? cleaned : null;
}

function cleanInteger(value: unknown, min: number, max: number, fallback: number | null = null) {
  if (value === null || value === undefined) {
    if (fallback === null) throw new Error("Missing numeric field");
    return fallback;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Invalid numeric field");
  return Math.max(min, Math.min(max, Math.round(n)));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(token);
    const userId = claimsData?.claims?.sub;

    if (claimsError || !userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const score = cleanInteger(body.score, 0, 1000);
    const rating = cleanText(body.rating, 1, true)!;

    if (!ALLOWED_RATINGS.has(rating)) {
      return json({ error: "Invalid score rating" }, 400);
    }

    const durationSeconds = cleanInteger(body.durationSeconds, 0, 24 * 60 * 60, 0);
    const minimumSessionSeconds = Math.min(20, Math.max(5, Math.floor(durationSeconds * 0.25)));
    const playedSeconds = cleanInteger(body.playedSeconds, 0, 24 * 60 * 60, 0);

    if (durationSeconds > 0 && playedSeconds < minimumSessionSeconds) {
      return json({ error: "Song session was too short to submit a score" }, 400);
    }

    const songTitle = cleanText(body.songTitle, 200, true)!;
    const trackId = cleanText(body.trackId, 200, true)!;
    const songArtist = cleanText(body.songArtist, 200);
    const thumbnailUrl = cleanText(body.thumbnailUrl, 1000);
    const displayName = cleanText(body.displayName, 50);
    const city = cleanText(body.city, 50);
    const timingAccuracy = cleanInteger(body.timingAccuracy, 0, 100, 0);
    const rhythmAccuracy = cleanInteger(body.rhythmAccuracy, 0, 100, 0);

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing, error: existingError } = await adminClient
      .from("scores")
      .select("id")
      .eq("user_id", userId)
      .eq("track_id", trackId)
      .gte("created_at", since)
      .limit(1);

    if (existingError) throw existingError;
    if (existing && existing.length > 0) {
      return json({ error: "You already submitted a score for this song in the last 24 hours" }, 409);
    }

    const { data, error } = await adminClient
      .from("scores")
      .insert({
        user_id: userId,
        song_title: songTitle,
        song_artist: songArtist,
        track_id: trackId,
        thumbnail_url: thumbnailUrl,
        score,
        rating,
        rhythm_accuracy: rhythmAccuracy,
        timing_accuracy: timingAccuracy,
        duration_seconds: durationSeconds,
        display_name: displayName,
        city,
      })
      .select("id")
      .single();

    if (error) throw error;

    return json({ id: data.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit score";
    console.error("[submit-score] Error:", message);
    return json({ error: "Failed to submit score" }, 500);
  }
});
