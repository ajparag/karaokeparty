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
  source: 'jiosaavn' | 'gaana';
  streamUrl?: string;
}

// JioSaavn API (using the public API)
async function searchJioSaavn(query: string): Promise<Track[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://saavn.dev/api/search/songs?query=${encodedQuery}&limit=20`
    );
    
    if (!response.ok) {
      console.error('JioSaavn API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.success || !data.data?.results) {
      return [];
    }
    
    return data.data.results.map((song: any) => ({
      id: `jiosaavn_${song.id}`,
      title: song.name || song.title || 'Unknown',
      artist: song.artists?.primary?.map((a: any) => a.name).join(', ') || 
              song.primaryArtists || 
              'Unknown Artist',
      album: song.album?.name || song.album || '',
      thumbnail: song.image?.[2]?.url || song.image?.[1]?.url || song.image?.[0]?.url || '',
      duration: song.duration || 0,
      language: song.language || 'Hindi',
      source: 'jiosaavn' as const,
      streamUrl: song.downloadUrl?.[4]?.url || song.downloadUrl?.[3]?.url || song.downloadUrl?.[2]?.url || '',
    }));
  } catch (error) {
    console.error('JioSaavn search error:', error);
    return [];
  }
}

// Fallback: Search with karaoke/instrumental keywords
async function searchInstrumental(query: string): Promise<Track[]> {
  const instrumentalQueries = [
    `${query} karaoke`,
    `${query} instrumental`,
  ];
  
  const allTracks: Track[] = [];
  
  for (const q of instrumentalQueries) {
    const tracks = await searchJioSaavn(q);
    allTracks.push(...tracks);
  }
  
  // Also search the original query
  const originalTracks = await searchJioSaavn(query);
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

    console.log('Searching for:', query);
    
    // Search for tracks
    const tracks = await searchInstrumental(query);
    
    console.log(`Found ${tracks.length} tracks`);

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
