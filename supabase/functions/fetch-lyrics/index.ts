import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

interface LyricsResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  lyrics: LyricLine[];
  synced: boolean;
}

interface LyricsResponse {
  lyrics: LyricLine[];
  source: string;
  synced: boolean;
}

interface SearchResultsResponse {
  results: LyricsResult[];
  source: string;
}

// Parse LRC format to structured lyrics
function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const lrcLines = lrc.split('\n');
  
  for (const line of lrcLines) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const milliseconds = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      const text = match[4].trim();
      
      if (text) {
        const time = minutes * 60 + seconds + milliseconds / 1000;
        lines.push({ time, text });
      }
    }
  }
  
  for (let i = 0; i < lines.length; i++) {
    if (i < lines.length - 1) {
      lines[i].duration = lines[i + 1].time - lines[i].time;
    } else {
      lines[i].duration = 5;
    }
  }
  
  return lines.sort((a, b) => a.time - b.time);
}

// Convert plain lyrics to timed format
function convertPlainLyrics(plainLyrics: string): LyricLine[] {
  const lines = plainLyrics.split('\n').filter((l: string) => l.trim());
  const estimatedDuration = 4;
  
  return lines.map((text: string, i: number) => ({
    time: i * estimatedDuration,
    text: text.trim(),
    duration: estimatedDuration,
  }));
}

// Search LRCLIB and return top results
async function searchLRCLIBMultiple(title: string, artist: string): Promise<LyricsResult[]> {
  try {
    const encodedTitle = encodeURIComponent(title);
    const encodedArtist = encodeURIComponent(artist);
    
    // Use search endpoint to get multiple results
    const searchResponse = await fetch(
      `https://lrclib.net/api/search?track_name=${encodedTitle}${artist ? `&artist_name=${encodedArtist}` : ''}`
    );
    
    if (!searchResponse.ok) {
      console.error('LRCLIB search failed:', searchResponse.status);
      return [];
    }
    
    const results = await searchResponse.json();
    
    if (!Array.isArray(results) || results.length === 0) {
      return [];
    }
    
    // Take top 3 results and parse their lyrics
    const top3 = results.slice(0, 3).map((result: any) => {
      let lyrics: LyricLine[] = [];
      let synced = false;
      
      if (result.syncedLyrics) {
        lyrics = parseLRC(result.syncedLyrics);
        synced = true;
      } else if (result.plainLyrics) {
        lyrics = convertPlainLyrics(result.plainLyrics);
        synced = false;
      }
      
      return {
        id: result.id,
        trackName: result.trackName || title,
        artistName: result.artistName || artist,
        albumName: result.albumName,
        duration: result.duration,
        lyrics,
        synced,
      };
    });
    
    return top3.filter((r: LyricsResult) => r.lyrics.length > 0);
  } catch (error) {
    console.error('LRCLIB search error:', error);
    return [];
  }
}

// Search LRCLIB for synced lyrics (single result - legacy)
async function searchLRCLIB(title: string, artist: string): Promise<LyricsResponse | null> {
  try {
    const encodedTitle = encodeURIComponent(title);
    const encodedArtist = encodeURIComponent(artist);
    
    const exactResponse = await fetch(
      `https://lrclib.net/api/get?track_name=${encodedTitle}&artist_name=${encodedArtist}`
    );
    
    if (exactResponse.ok) {
      const data = await exactResponse.json();
      
      if (data.syncedLyrics) {
        return {
          lyrics: parseLRC(data.syncedLyrics),
          source: 'lrclib',
          synced: true,
        };
      }
      
      if (data.plainLyrics) {
        return {
          lyrics: convertPlainLyrics(data.plainLyrics),
          source: 'lrclib',
          synced: false,
        };
      }
    }
    
    const searchResponse = await fetch(
      `https://lrclib.net/api/search?track_name=${encodedTitle}&artist_name=${encodedArtist}`
    );
    
    if (searchResponse.ok) {
      const results = await searchResponse.json();
      
      if (results.length > 0) {
        const best = results[0];
        
        if (best.syncedLyrics) {
          return {
            lyrics: parseLRC(best.syncedLyrics),
            source: 'lrclib',
            synced: true,
          };
        }
        
        if (best.plainLyrics) {
          return {
            lyrics: convertPlainLyrics(best.plainLyrics),
            source: 'lrclib',
            synced: false,
          };
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('LRCLIB error:', error);
    return null;
  }
}

// Fallback: Generate placeholder lyrics
function generatePlaceholderLyrics(title: string, duration: number): LyricsResponse {
  const numLines = Math.max(10, Math.floor(duration / 4));
  const lineDuration = duration / numLines;
  
  const placeholderLines = [
    `♪ ${title} ♪`,
    '🎤 Lyrics not available',
    '🎵 Sing along to the music!',
    '',
    '♪ ♪ ♪',
  ];
  
  const lyrics: LyricLine[] = [];
  
  for (let i = 0; i < numLines; i++) {
    lyrics.push({
      time: i * lineDuration,
      text: placeholderLines[i % placeholderLines.length] || '♪ ♪ ♪',
      duration: lineDuration,
    });
  }
  
  return {
    lyrics,
    source: 'placeholder',
    synced: false,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { title, artist, duration = 180, searchMultiple = false } = await req.json();
    
    if (!title) {
      return new Response(
        JSON.stringify({ error: 'Title is required' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('Fetching lyrics for:', title, 'by', artist, 'searchMultiple:', searchMultiple);
    
    // If searchMultiple is true, return top 3 results for user selection
    if (searchMultiple) {
      const results = await searchLRCLIBMultiple(title, artist || '');
      
      console.log(`Found ${results.length} results from LRCLIB`);
      
      return new Response(
        JSON.stringify({ results, source: 'lrclib' } as SearchResultsResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Default behavior: return first/best match
    const lyricsResult = await searchLRCLIB(title, artist || '');
    
    if (lyricsResult) {
      console.log(`Found ${lyricsResult.lyrics.length} lines from ${lyricsResult.source}`);
      return new Response(
        JSON.stringify(lyricsResult),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Fallback to placeholder
    console.log('No lyrics found, using placeholder');
    const placeholder = generatePlaceholderLyrics(title, duration);
    
    return new Response(
      JSON.stringify(placeholder),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Lyrics fetch error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Failed to fetch lyrics', details: errorMessage }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
