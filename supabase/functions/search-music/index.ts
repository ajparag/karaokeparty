import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Input validation limits
const MAX_QUERY_LENGTH = 500;

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

// Decode HTML entities like &quot; &amp; etc.
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// Common Hindi/English word mappings and synonyms for fuzzy matching
const wordMappings: Record<string, string[]> = {
  'tum': ['tum', 'tu', 'tujhe'],
  'tu': ['tu', 'tum', 'tujhe'],
  'dil': ['dil', 'dill', 'heart'],
  'pyar': ['pyar', 'pyaar', 'love', 'mohabbat'],
  'pyaar': ['pyaar', 'pyar', 'love', 'mohabbat'],
  'ishq': ['ishq', 'ishk', 'love', 'pyar'],
  'song': ['song', 'gana', 'gaana'],
  'songs': ['songs', 'gane', 'gaane'],
  'love': ['love', 'pyar', 'pyaar', 'ishq', 'mohabbat'],
  'sad': ['sad', 'dard', 'dukh', 'udaas'],
  'happy': ['happy', 'khushi', 'khush'],
  'romantic': ['romantic', 'romance', 'pyar', 'love'],
  'party': ['party', 'dance', 'club', 'dj'],
  'old': ['old', 'purana', 'classic', 'retro'],
  'new': ['new', 'naya', 'latest', 'recent'],
  'bollywood': ['bollywood', 'hindi', 'filmi'],
  'hindi': ['hindi', 'bollywood', 'indian'],
  'arijit': ['arijit', 'arijit singh'],
  'srk': ['srk', 'shah rukh khan', 'shahrukh'],
  'shahrukh': ['shahrukh', 'shah rukh khan', 'srk'],
  'salman': ['salman', 'salman khan', 'bhai'],
  'aamir': ['aamir', 'aamir khan'],
  'hit': ['hit', 'hits', 'popular', 'famous'],
  'hits': ['hits', 'hit', 'popular', 'famous'],
  'best': ['best', 'top', 'greatest', 'superhit'],
  'top': ['top', 'best', 'hit', 'popular'],
  '2024': ['2024', 'latest', 'new'],
  '2023': ['2023', 'recent', 'new'],
  'mashup': ['mashup', 'mix', 'remix'],
  'remix': ['remix', 'mix', 'mashup'],
  'unplugged': ['unplugged', 'acoustic', 'live'],
  'acoustic': ['acoustic', 'unplugged'],
  'cover': ['cover', 'version'],
  'female': ['female', 'lady', 'woman'],
  'male': ['male', 'man'],
  'duet': ['duet', 'duo', 'couple'],
};

// Normalize query - fix common typos and standardize spelling
function normalizeQuery(query: string): string {
  let normalized = query.toLowerCase().trim();
  
  // Remove extra spaces
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Common typo fixes
  const typoFixes: Record<string, string> = {
    'arjit': 'arijit',
    'arjith': 'arijit',
    'arijith': 'arijit',
    'shreya ghosal': 'shreya ghoshal',
    'shreya goshal': 'shreya ghoshal',
    'atif aslaam': 'atif aslam',
    'neha kakar': 'neha kakkar',
    'badsha': 'badshah',
    'jubin nautiyal': 'jubin nautiyal',
    'tanishk bagchi': 'tanishk bagchi',
    'kesaria': 'kesariya',
    'kesarya': 'kesariya',
    'tum hi ho': 'tum hi ho',
    'tumhi ho': 'tum hi ho',
    'tumhiho': 'tum hi ho',
    'gerua': 'gerua',
    'channa mereya': 'channa mereya',
    'channamereya': 'channa mereya',
  };
  
  for (const [typo, fix] of Object.entries(typoFixes)) {
    if (normalized.includes(typo)) {
      normalized = normalized.replace(typo, fix);
    }
  }
  
  return normalized;
}

// Generate alternative search queries for better matching
function generateAlternativeQueries(query: string): string[] {
  const normalized = normalizeQuery(query);
  const alternatives: Set<string> = new Set([normalized]);
  
  // Split into words
  const words = normalized.split(' ');
  
  // Try expanding each word with its synonyms
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const mappings = wordMappings[word];
    if (mappings) {
      for (const alt of mappings) {
        if (alt !== word) {
          const newQuery = [...words.slice(0, i), alt, ...words.slice(i + 1)].join(' ');
          alternatives.add(newQuery);
        }
      }
    }
  }
  
  // If query has "songs" or "song", try without it
  if (normalized.includes(' songs') || normalized.includes(' song')) {
    alternatives.add(normalized.replace(/ songs?/g, ''));
  }
  
  // If query is short, try adding common suffixes
  if (words.length <= 2 && !normalized.includes('song')) {
    alternatives.add(normalized + ' song');
  }
  
  return Array.from(alternatives).slice(0, 3); // Limit to 3 alternatives
}

// Calculate fuzzy match score between query and track
function calculateRelevanceScore(query: string, track: Track): number {
  const queryLower = query.toLowerCase();
  const titleLower = track.title.toLowerCase();
  const artistLower = track.artist.toLowerCase();
  
  let score = 0;
  
  // Exact title match (highest priority)
  if (titleLower === queryLower) {
    score += 100;
  } else if (titleLower.includes(queryLower)) {
    score += 70;
  } else if (queryLower.includes(titleLower)) {
    score += 50;
  }
  
  // Check individual words from query in title
  const queryWords = queryLower.split(' ').filter(w => w.length > 1);
  let matchedWords = 0;
  for (const word of queryWords) {
    if (titleLower.includes(word)) {
      matchedWords++;
      score += 15;
    } else if (artistLower.includes(word)) {
      matchedWords++;
      score += 10;
    }
  }
  
  // Bonus for matching most words
  if (queryWords.length > 0 && matchedWords / queryWords.length >= 0.5) {
    score += 20;
  }
  
  // Artist match
  if (artistLower.includes(queryLower) || queryLower.includes(artistLower.split(',')[0])) {
    score += 30;
  }
  
  // Play count as tiebreaker (normalized to 0-10)
  if (track.playCount) {
    score += Math.min(10, Math.log10(track.playCount + 1));
  }
  
  return score;
}

// JioSaavn API search
async function searchSaavn(query: string): Promise<Track[]> {
  try {
    const searchQuery = encodeURIComponent(query);
    console.log('Searching Saavn for:', query);
    
    const response = await fetch(
      `https://jiosaavn.rajputhemant.dev/api/search/songs?query=${searchQuery}&page=1&limit=20`,
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
      // Get audio URL (prefer 160kbps for faster loading, exclude 320kbps)
      const downloadUrls = song.downloadUrl || [];
      const audioUrl = downloadUrls.find((d: any) => d.quality === '160kbps')?.url 
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
        title: decodeHtmlEntities(song.name || 'Unknown'),
        artist: decodeHtmlEntities(artists),
        thumbnail: thumbnail,
        duration: formatDuration(song.duration || 0),
        source: 'saavn' as const,
        audioUrl: audioUrl,
        album: decodeHtmlEntities(song.album?.name || ''),
        playCount: playCount,
      };
    });

    console.log(`Found ${tracks.length} tracks from Saavn`);
    return tracks;
  } catch (error) {
    console.error('Saavn search error:', error);
    return [];
  }
}

// Search with multiple queries and deduplicate/rank results
async function searchWithFuzzyMatching(originalQuery: string): Promise<Track[]> {
  const alternativeQueries = generateAlternativeQueries(originalQuery);
  console.log('Searching with queries:', alternativeQueries);
  
  // Search with primary query first
  let allTracks = await searchSaavn(alternativeQueries[0]);
  
  // If we got few results, try alternative queries
  if (allTracks.length < 5 && alternativeQueries.length > 1) {
    for (let i = 1; i < alternativeQueries.length; i++) {
      const additionalTracks = await searchSaavn(alternativeQueries[i]);
      allTracks = [...allTracks, ...additionalTracks];
    }
  }
  
  // Deduplicate by ID
  const seen = new Set<string>();
  const uniqueTracks: Track[] = [];
  for (const track of allTracks) {
    if (!seen.has(track.id)) {
      seen.add(track.id);
      uniqueTracks.push(track);
    }
  }
  
  // Score and sort by relevance to original query
  const normalizedQuery = normalizeQuery(originalQuery);
  const scoredTracks = uniqueTracks.map(track => ({
    track,
    score: calculateRelevanceScore(normalizedQuery, track)
  }));
  
  scoredTracks.sort((a, b) => b.score - a.score);
  
  console.log(`Returning ${scoredTracks.length} unique tracks (sorted by relevance)`);
  return scoredTracks.map(st => st.track).slice(0, 20);
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { query } = body;
    
    // Input validation: check query exists and is a string
    if (!query || typeof query !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Query is required and must be a string' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Trim and validate query length
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Query cannot be empty' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    if (trimmedQuery.length > MAX_QUERY_LENGTH) {
      console.error(`Query too long: ${trimmedQuery.length} characters`);
      return new Response(
        JSON.stringify({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('Original search query:', trimmedQuery);
    
    // Use fuzzy matching search
    const tracks = await searchWithFuzzyMatching(trimmedQuery);
    
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
