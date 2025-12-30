import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search as SearchIcon, ArrowLeft, Music, Loader2, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn';
  audioUrl: string;
  album?: string;
}

type FilterType = 'all' | 'original' | 'instrumental';

const Search = () => {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSearch = async (searchFilter?: FilterType) => {
    if (!query.trim()) return;
    
    const activeFilter = searchFilter ?? filter;
    setIsLoading(true);
    setHasSearched(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('search-music', {
        body: { query: query.trim(), filter: activeFilter }
      });
      
      if (error) throw error;
      
      setTracks(data?.tracks || []);
      
      if (data?.tracks?.length === 0) {
        toast({
          title: "No tracks found",
          description: "Try a different search term or filter",
        });
      }
    } catch (error) {
      console.error('Search error:', error);
      toast({
        title: "Search failed",
        description: "Please try again later",
        variant: "destructive",
      });
      setTracks([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Re-search when filter changes (if we already have a query)
  useEffect(() => {
    if (hasSearched && query.trim()) {
      handleSearch(filter);
    }
  }, [filter]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSelectTrack = (track: Track) => {
    // Store track info in sessionStorage for the sing page
    sessionStorage.setItem('selectedTrack', JSON.stringify(track));
    navigate(`/sing/${track.id}`);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 glass border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          
          <div className="flex-1 flex gap-2">
            <Input
              type="text"
              placeholder="Search for songs... (e.g., 'Tum Hi Ho', 'Kesariya')"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              className="flex-1 bg-muted border-border"
            />
            <Button
              onClick={() => handleSearch()}
              disabled={isLoading || !query.trim()}
              className="gradient-primary text-primary-foreground shrink-0"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <SearchIcon className="w-5 h-5" />
              )}
            </Button>
          </div>
        </div>
        
        {/* Filter Tabs */}
        <div className="flex gap-1 ml-2">
          {(['all', 'original', 'instrumental'] as FilterType[]).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
              className={filter === f ? 'gradient-primary text-primary-foreground' : ''}
            >
              {f === 'all' ? 'All' : f === 'original' ? 'Original' : 'Instrumental'}
            </Button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {!hasSearched ? (
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
              <Music className="w-10 h-10 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-semibold mb-2">Find Your Song</h2>
            <p className="text-muted-foreground max-w-md mx-auto">
              Search for Bollywood, Tollywood, or regional songs from JioSaavn!
            </p>
            
            {/* Popular searches */}
            <div className="mt-8">
              <p className="text-sm text-muted-foreground mb-3">Popular searches:</p>
              <div className="flex flex-wrap justify-center gap-2">
                {['Tum Hi Ho', 'Kal Ho Naa Ho', 'Chaiyya Chaiyya', 'Kesariya', 'Mere Sapno Ki Rani'].map((term) => (
                  <Button
                    key={term}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery(term);
                      setTimeout(() => handleSearch(), 100);
                    }}
                    className="border-border hover:bg-muted"
                  >
                    {term}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        ) : isLoading ? (
          <div className="py-16 text-center">
            <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />
            <p className="text-muted-foreground">Searching JioSaavn...</p>
          </div>
        ) : tracks.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
              <SearchIcon className="w-10 h-10 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-semibold mb-2">No Results Found</h2>
            <p className="text-muted-foreground">
              Try searching with different keywords
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm mb-4">
              Found {tracks.length} track{tracks.length !== 1 ? 's' : ''}
            </p>
            
            {tracks.map((track) => (
              <div
                key={track.id}
                className="group p-4 rounded-xl bg-card border border-border hover:border-primary/50 transition-all cursor-pointer"
                onClick={() => handleSelectTrack(track)}
              >
                <div className="flex items-center gap-4">
                  {/* Thumbnail */}
                  <div className="relative w-16 h-16 rounded-lg overflow-hidden bg-muted shrink-0">
                    {track.thumbnail ? (
                      <img
                        src={track.thumbnail}
                        alt={track.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-background/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Play className="w-6 h-6 text-primary fill-primary" />
                    </div>
                  </div>
                  
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate group-hover:text-primary transition-colors">
                      {track.title}
                    </h3>
                    <p className="text-sm text-muted-foreground truncate">
                      {track.artist}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">{track.duration}</span>
                      {track.album && (
                        <>
                          <span className="text-muted-foreground">•</span>
                          <span className="text-xs text-muted-foreground truncate">{track.album}</span>
                        </>
                      )}
                    </div>
                  </div>
                  
                  {/* Action */}
                  <Button
                    size="sm"
                    className="gradient-primary text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  >
                    Sing
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Search;
