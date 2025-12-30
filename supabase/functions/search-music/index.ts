import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  thumbnail: string;
  duration: number;
  language: string;
  source: 'deezer';
  previewUrl?: string;
}

// Simple in-memory cache to reduce repeat calls & rate limiting
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { ts: number; tracks: Track[] }>();

function getCache(key: string): Track[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.tracks;
}

function setCache(key: string, tracks: Track[]) {
  cache.set(key, { ts: Date.now(), tracks });
}

// Deezer API search
async function searchDeezer(query: string): Promise<Track[]> {
  const q = query.trim();
  const cacheKey = `deezer:${q.toLowerCase()}`;

  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const encodedQuery = encodeURIComponent(q);

    const response = await fetch(
      `https://api.deezer.com/search?q=${encodedQuery}&index=0&limit=30`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'LovableKaraoke/1.0 (+https://lovable.dev)',
        },
      }
    );

    if (!response.ok) {
      console.error('Deezer API error:', response.status);
      return [];
    }

    const raw = await response.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Deezer returned non-JSON response (first 200 chars):', raw.slice(0, 200));
      return [];
    }

    if (data?.error) {
      console.error('Deezer API payload error:', data.error);
      return [];
    }

    if (!data?.data || !Array.isArray(data.data)) {
      console.error('Unexpected Deezer payload (no data array):', data);
      return [];
    }

    const tracks: Track[] = data.data.map((track: any) => ({
      id: `deezer_${track.id}`,
      title: track.title || 'Unknown',
      artist: track.artist?.name || 'Unknown Artist',
      album: track.album?.title || '',
      thumbnail: track.album?.cover_medium || track.album?.cover_small || '',
      duration: track.duration || 0,
      language: 'Unknown',
      source: 'deezer' as const,
      previewUrl: track.preview || '',
    }));

    setCache(cacheKey, tracks);
    return tracks;
  } catch (error) {
    console.error('Deezer search error:', error);
    return [];
  }
}

// Search with minimal extra calls to avoid rate limits
async function searchInstrumental(query: string): Promise<Track[]> {
  const primary = await searchDeezer(query);

  // If we already got decent results, don't spam extra queries.
  if (primary.length >= 8) return primary.slice(0, 30);

  const extraQueries = [`${query} instrumental`, `${query} karaoke`];
  const allTracks: Track[] = [...primary];

  for (const q of extraQueries) {
    const tracks = await searchDeezer(q);
    allTracks.push(...tracks);

    // Early exit once we have enough.
    if (allTracks.length >= 30) break;
  }

  const uniqueTracks = Array.from(new Map(allTracks.map((t) => [t.id, t])).values());
  return uniqueTracks.slice(0, 30);
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query } = await req.json();
    
    if (!query || typeof query !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Query is required' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('Searching Deezer for:', query);
    
    // Search for tracks
    const tracks = await searchInstrumental(query);
    
    console.log(`Found ${tracks.length} tracks from Deezer`);

    return new Response(
      JSON.stringify({ tracks }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Search error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Search failed', details: errorMessage }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
