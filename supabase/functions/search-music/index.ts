import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn';
  audioUrl: string;
  album?: string;
  playCount?: number;
}

// Format duration from seconds to mm:ss
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// JioSaavn API search
async function searchSaavn(query: string): Promise<Track[]> {
  try {
    // Append tags to help find instrumental/karaoke versions
    const enhancedQuery = `${query} instrumental original official`;
    const searchQuery = encodeURIComponent(enhancedQuery);
    console.log('Enhanced search query:', enhancedQuery);
    
    const response = await fetch(
      `https://saavn.sumit.co/api/search/songs?query=${searchQuery}&page=0&limit=20`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Saavn API error:', response.status, errorText);
      return [];
    }

    const data = await response.json();

    if (!data.success || !data.data?.results) {
      console.error('No results in Saavn response');
      return [];
    }

    const tracks: Track[] = data.data.results.map((song: any) => {
      // Get the highest quality audio URL (prefer 320kbps)
      const downloadUrls = song.downloadUrl || [];
      const audioUrl = downloadUrls.find((d: any) => d.quality === '320kbps')?.url 
        || downloadUrls.find((d: any) => d.quality === '160kbps')?.url
        || downloadUrls.find((d: any) => d.quality === '96kbps')?.url
        || downloadUrls[downloadUrls.length - 1]?.url
        || '';

      // Get the best image (prefer 500x500)
      const images = song.image || [];
      const thumbnail = images.find((img: any) => img.quality === '500x500')?.url
        || images.find((img: any) => img.quality === '150x150')?.url
        || images[images.length - 1]?.url
        || '';

      // Get artist names
      const artists = song.artists?.primary?.map((a: any) => a.name).join(', ') 
        || song.artists?.all?.map((a: any) => a.name).join(', ')
        || 'Unknown Artist';

      // Get play count for sorting
      const playCount = parseInt(song.playCount, 10) || 0;

      return {
        id: song.id,
        title: song.name || 'Unknown',
        artist: artists,
        thumbnail: thumbnail,
        duration: formatDuration(song.duration || 0),
        source: 'saavn' as const,
        audioUrl: audioUrl,
        album: song.album?.name || '',
        playCount: playCount,
      };
    });

    // Sort by play count (most played first)
    tracks.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));

    console.log(`Found ${tracks.length} tracks from Saavn (sorted by playCount)`);
    return tracks;
  } catch (error) {
    console.error('Saavn search error:', error);
    return [];
  }
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

    console.log('Searching Saavn for:', query);
    
    const tracks = await searchSaavn(query);
    
    console.log(`Returning ${tracks.length} tracks`);

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
