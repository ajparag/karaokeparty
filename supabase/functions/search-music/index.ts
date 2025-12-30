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

// Deezer API search
async function searchDeezer(query: string): Promise<Track[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://api.deezer.com/search?q=${encodedQuery}&limit=30`
    );
    
    if (!response.ok) {
      console.error('Deezer API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.data || !Array.isArray(data.data)) {
      console.log('No results from Deezer');
      return [];
    }
    
    return data.data.map((track: any) => ({
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
  } catch (error) {
    console.error('Deezer search error:', error);
    return [];
  }
}

// Search with karaoke/instrumental keywords for better results
async function searchInstrumental(query: string): Promise<Track[]> {
  const allTracks: Track[] = [];
  
  // Search for karaoke and instrumental versions
  const instrumentalQueries = [
    `${query} karaoke`,
    `${query} instrumental`,
  ];
  
  for (const q of instrumentalQueries) {
    const tracks = await searchDeezer(q);
    allTracks.push(...tracks);
  }
  
  // Also search the original query
  const originalTracks = await searchDeezer(query);
  allTracks.push(...originalTracks);
  
  // Remove duplicates by ID
  const uniqueTracks = Array.from(
    new Map(allTracks.map(t => [t.id, t])).values()
  );
  
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
