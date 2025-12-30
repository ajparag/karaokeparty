import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search as SearchIcon, ArrowLeft, Music, Loader2, Play, Youtube } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'youtube';
  videoId: string;
}

const Search = () => {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSearch = async () => {
    if (!query.trim()) return;
    
    setIsLoading(true);
    setHasSearched(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('search-music', {
        body: { query: query.trim() }
      });
      
      if (error) throw error;
      
      setTracks(data?.tracks || []);
      
      if (data?.tracks?.length === 0) {
        toast({
          title: "No tracks found",
          description: "Try a different search term",
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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSelectTrack = (track: Track) => {
    // Store track info in sessionStorage for the sing page
    sessionStorage.setItem('selectedTrack', JSON.stringify(track));
    navigate(`/sing/${track.videoId}`);
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
              placeholder="Search for karaoke tracks... (e.g., 'Tum Hi Ho karaoke')"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              className="flex-1 bg-muted border-border"
            />
            <Button
              onClick={handleSearch}
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
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {!hasSearched ? (
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
              <Youtube className="w-10 h-10 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-semibold mb-2">Find Your Song</h2>
            <p className="text-muted-foreground max-w-md mx-auto">
              Search for Bollywood, Tollywood, or regional karaoke songs from YouTube!
            </p>
            
            {/* Popular searches */}
            <div className="mt-8">
              <p className="text-sm text-muted-foreground mb-3">Popular searches:</p>
              <div className="flex flex-wrap justify-center gap-2">
                {['Tum Hi Ho karaoke', 'Kal Ho Naa Ho karaoke', 'Chaiyya Chaiyya karaoke', 'Kesariya karaoke'].map((term) => (
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
            <p className="text-muted-foreground">Searching YouTube...</p>
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
              Found {tracks.length} track{tracks.length !== 1 ? 's' : ''} on YouTube
            </p>
            
            {tracks.map((track) => (
              <div
                key={track.id}
                className="group p-4 rounded-xl bg-card border border-border hover:border-primary/50 transition-all cursor-pointer"
                onClick={() => handleSelectTrack(track)}
              >
                <div className="flex items-center gap-4">
                  {/* Thumbnail */}
                  <div className="relative w-24 h-16 rounded-lg overflow-hidden bg-muted shrink-0">
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
                    {/* Duration badge */}
                    <div className="absolute bottom-1 right-1 px-1 py-0.5 bg-background/80 rounded text-xs font-medium">
                      {track.duration}
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
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 flex items-center gap-1">
                        <Youtube className="w-3 h-3" />
                        YouTube
                      </span>
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
