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
  thumbnail: string;
  duration: string;
  source: 'youtube';
  videoId: string;
}

// YouTube Data API search
async function searchYouTube(query: string): Promise<Track[]> {
  const apiKey = Deno.env.get('YOUTUBE_API_KEY');
  
  if (!apiKey) {
    console.error('YOUTUBE_API_KEY not configured');
    return [];
  }

  try {
    const searchQuery = encodeURIComponent(`${query} karaoke OR instrumental`);
    
    // Search for videos
    const searchResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=20&q=${searchQuery}&type=video&videoCategoryId=10&key=${apiKey}`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error('YouTube API error:', searchResponse.status, errorText);
      return [];
    }

    const searchData = await searchResponse.json();

    if (!searchData.items || !Array.isArray(searchData.items)) {
      console.error('No items in YouTube response');
      return [];
    }

    // Get video details for duration
    const videoIds = searchData.items.map((item: any) => item.id.videoId).join(',');
    
    const detailsResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds}&key=${apiKey}`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const detailsData = await detailsResponse.json();
    const detailsMap = new Map<string, any>();
    
    if (detailsData.items) {
      detailsData.items.forEach((item: any) => {
        detailsMap.set(item.id, item);
      });
    }

    const tracks: Track[] = searchData.items.map((item: any) => {
      const videoId = item.id.videoId;
      const details = detailsMap.get(videoId);
      const duration = details?.contentDetails?.duration || 'PT0M0S';
      
      // Parse ISO 8601 duration to readable format
      const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      let formattedDuration = '0:00';
      if (durationMatch) {
        const hours = parseInt(durationMatch[1] || '0');
        const minutes = parseInt(durationMatch[2] || '0');
        const seconds = parseInt(durationMatch[3] || '0');
        if (hours > 0) {
          formattedDuration = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
          formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
      }

      return {
        id: `youtube_${videoId}`,
        title: item.snippet.title || 'Unknown',
        artist: item.snippet.channelTitle || 'Unknown Artist',
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
        duration: formattedDuration,
        source: 'youtube' as const,
        videoId: videoId,
      };
    });

    console.log(`Found ${tracks.length} tracks from YouTube`);
    return tracks;
  } catch (error) {
    console.error('YouTube search error:', error);
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

    console.log('Searching YouTube for:', query);
    
    const tracks = await searchYouTube(query);
    
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
