import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Mic, Music, Trophy, Sparkles, Loader2, Play, Search, Edit2, Check } from "lucide-react";
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

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

const Index = () => {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Lyrics dialog state
  const [lyricsDialogOpen, setLyricsDialogOpen] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [lyricsSearchTitle, setLyricsSearchTitle] = useState("");
  const [lyricsSearchArtist, setLyricsSearchArtist] = useState("");
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [fetchedLyrics, setFetchedLyrics] = useState<LyricLine[]>([]);
  const [lyricsConfirmed, setLyricsConfirmed] = useState(false);

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

  // Open lyrics dialog when user selects a track
  const handleSelectTrack = (track: Track) => {
    setSelectedTrack(track);
    setFetchedLyrics([]);
    setLyricsConfirmed(false);
    
    // Pre-fill with cleaned track info
    const cleanTitle = track.title
      ?.replace(/\(.*?\)/g, '')
      ?.replace(/\[.*?\]/g, '')
      ?.replace(/karaoke|instrumental|lyrics|official|video|audio|hd|4k/gi, '')
      ?.trim() || '';
    const cleanArtist = track.artist?.trim() || '';
    
    setLyricsSearchTitle(cleanTitle);
    setLyricsSearchArtist(cleanArtist);
    setLyricsDialogOpen(true);
    
    // Auto-fetch lyrics
    fetchLyrics(cleanTitle, cleanArtist);
  };

  const fetchLyrics = async (title: string, artist: string) => {
    setIsSearchingLyrics(true);
    try {
      const { data } = await supabase.functions.invoke('fetch-lyrics', {
        body: { title, artist }
      });
      if (data?.lyrics && data.lyrics.length > 0) {
        setFetchedLyrics(data.lyrics);
        toast({ title: "Lyrics found!", description: `${data.lyrics.length} synced lines loaded` });
      } else {
        setFetchedLyrics([]);
        toast({ 
          title: "No lyrics found", 
          description: "Try editing the title/artist and search again",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
      setFetchedLyrics([]);
      toast({ 
        title: "Failed to fetch lyrics", 
        description: "Try editing the title and search again",
        variant: "destructive"
      });
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const handleLyricsSearch = async () => {
    if (!lyricsSearchTitle.trim()) {
      toast({ title: "Please enter a song title", variant: "destructive" });
      return;
    }
    await fetchLyrics(lyricsSearchTitle.trim(), lyricsSearchArtist.trim());
  };

  const handleStartSinging = () => {
    if (!selectedTrack) return;
    
    // Store track and lyrics in sessionStorage
    sessionStorage.setItem('selectedTrack', JSON.stringify(selectedTrack));
    sessionStorage.setItem('prefetchedLyrics', JSON.stringify(fetchedLyrics));
    
    setLyricsDialogOpen(false);
    navigate(`/sing/${selectedTrack.id}`);
  };

  const handleSkipLyrics = () => {
    if (!selectedTrack) return;
    
    // Store track without lyrics
    sessionStorage.setItem('selectedTrack', JSON.stringify(selectedTrack));
    sessionStorage.removeItem('prefetchedLyrics');
    
    setLyricsDialogOpen(false);
    navigate(`/sing/${selectedTrack.id}`);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Hero Section */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden">
        {/* Background effects */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary/20 rounded-full blur-3xl" />
        </div>
        
        {/* Content */}
        <div className="relative z-10 text-center max-w-4xl mx-auto w-full">
          {/* Logo/Title */}
          <div className="mb-8 flex items-center justify-center gap-3">
            <div className="p-4 rounded-2xl gradient-primary shadow-glow">
              <Mic className="w-10 h-10 text-primary-foreground" />
            </div>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
            <span className="text-gradient">गाओ</span>
            <span className="text-foreground"> Karaoke</span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground mb-4 font-medium">
            Sing Bollywood, Tollywood & More
          </p>
          
          <p className="text-muted-foreground mb-8 max-w-2xl mx-auto">
            Your ultimate Indian karaoke experience. Search instrumental tracks, 
            follow synced lyrics, and get scored on your vocal performance.
          </p>
          
          {/* Search Section */}
          <div className="max-w-xl mx-auto mb-8">
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Search for songs... (e.g., 'Tum Hi Ho', 'Kesariya')"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                className="flex-1 bg-muted border-border h-12 text-base"
              />
              <Button
                onClick={handleSearch}
                disabled={isLoading || !query.trim()}
                size="lg"
                className="gradient-primary text-primary-foreground shadow-glow hover:opacity-90 transition-opacity px-6"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <Music className="w-5 h-5 mr-2" />
                    Start Singing
                  </>
                )}
              </Button>
            </div>
            
            {/* Popular searches */}
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">Popular:</p>
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
                    className="border-border hover:bg-muted text-xs"
                  >
                    {term}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Search Results */}
          {hasSearched && (
            <div className="max-w-2xl mx-auto text-left mb-8">
              {isLoading ? (
                <div className="py-8 text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
                  <p className="text-muted-foreground">Searching JioSaavn...</p>
                </div>
              ) : tracks.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No results found. Try different keywords.</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
                  <p className="text-muted-foreground text-sm mb-3">
                    Found {tracks.length} track{tracks.length !== 1 ? 's' : ''}
                  </p>
                  
                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className="group p-3 rounded-xl bg-card border border-border hover:border-primary/50 transition-all cursor-pointer"
                      onClick={() => handleSelectTrack(track)}
                    >
                      <div className="flex items-center gap-3">
                        {/* Thumbnail */}
                        <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-muted shrink-0">
                          {track.thumbnail ? (
                            <img
                              src={track.thumbnail}
                              alt={track.title}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-5 h-5 text-muted-foreground" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-background/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play className="w-5 h-5 text-primary fill-primary" />
                          </div>
                        </div>
                        
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                            {track.title}
                          </h3>
                          <p className="text-xs text-muted-foreground truncate">
                            {track.artist} • {track.duration}
                          </p>
                        </div>
                        
                        {/* Action */}
                        <Button
                          size="sm"
                          className="gradient-primary text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-xs"
                        >
                          Sing
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {/* Language badges */}
          {!hasSearched && (
            <div className="flex flex-wrap justify-center gap-2 mb-8">
              {['Hindi', 'Marathi', 'Gujarati', 'Punjabi', 'Tamil', 'Telugu', 'Malayalam'].map((lang) => (
                <span key={lang} className="language-badge text-muted-foreground">
                  {lang}
                </span>
              ))}
            </div>
          )}
          
          {/* Secondary CTA */}
          <div className="flex justify-center">
            <Link to="/leaderboard">
              <Button size="lg" variant="outline" className="px-8 py-6 text-lg border-border hover:bg-muted">
                <Trophy className="w-5 h-5 mr-2" />
                Leaderboard
              </Button>
            </Link>
          </div>
        </div>
      </div>
      
      {/* Lyrics Search Dialog */}
      <Dialog open={lyricsDialogOpen} onOpenChange={setLyricsDialogOpen}>
        <DialogContent className="sm:max-w-md bg-card">
          <DialogHeader>
            <DialogTitle>Setup Lyrics</DialogTitle>
            <DialogDescription>
              Search for synced lyrics before you start singing. You can skip this step if you prefer.
            </DialogDescription>
          </DialogHeader>
          
          {selectedTrack && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
              {selectedTrack.thumbnail && (
                <img
                  src={selectedTrack.thumbnail}
                  alt={selectedTrack.title}
                  className="w-12 h-12 rounded-lg object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{selectedTrack.title}</p>
                <p className="text-xs text-muted-foreground truncate">{selectedTrack.artist}</p>
              </div>
            </div>
          )}
          
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="lyrics-title">Song Title</Label>
              <Input
                id="lyrics-title"
                placeholder="e.g., Tum Hi Ho"
                value={lyricsSearchTitle}
                onChange={(e) => setLyricsSearchTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLyricsSearch()}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lyrics-artist">Artist (optional)</Label>
              <Input
                id="lyrics-artist"
                placeholder="e.g., Arijit Singh"
                value={lyricsSearchArtist}
                onChange={(e) => setLyricsSearchArtist(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLyricsSearch()}
              />
            </div>
            
            <Button 
              onClick={handleLyricsSearch} 
              disabled={isSearchingLyrics || !lyricsSearchTitle.trim()}
              variant="outline"
              className="w-full"
            >
              {isSearchingLyrics ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Search Lyrics
                </>
              )}
            </Button>
            
            {/* Lyrics status */}
            {fetchedLyrics.length > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 text-primary">
                <Check className="w-4 h-4" />
                <span className="text-sm font-medium">{fetchedLyrics.length} synced lines ready</span>
              </div>
            )}
          </div>
          
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={handleSkipLyrics} className="w-full sm:w-auto">
              Skip Lyrics
            </Button>
            <Button 
              onClick={handleStartSinging}
              className="gradient-primary text-primary-foreground w-full sm:w-auto"
            >
              <Mic className="w-4 h-4 mr-2" />
              Start Singing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Features Section */}
      <div className="py-16 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
          <FeatureCard
            icon={<Music className="w-8 h-8" />}
            title="Vast Music Library"
            description="Search thousands of Bollywood, Tollywood, and regional instrumental tracks from Gaana & JioSaavn"
          />
          <FeatureCard
            icon={<Sparkles className="w-8 h-8" />}
            title="Real-time Scoring"
            description="Get scored on pitch accuracy, rhythm, and diction as you sing with visual feedback"
          />
          <FeatureCard
            icon={<Trophy className="w-8 h-8" />}
            title="Compete & Share"
            description="Track your performance history, climb the leaderboard, and challenge friends"
          />
        </div>
      </div>
      
      {/* Footer */}
      <footer className="py-6 px-4 border-t border-border text-center text-muted-foreground text-sm">
        <p>Built with ❤️ for Indian music lovers</p>
      </footer>
    </div>
  );
};

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const FeatureCard = ({ icon, title, description }: FeatureCardProps) => (
  <div className="p-6 rounded-xl bg-card border border-border hover:border-primary/50 transition-colors">
    <div className="w-14 h-14 rounded-xl gradient-primary flex items-center justify-center text-primary-foreground mb-4">
      {icon}
    </div>
    <h3 className="text-xl font-semibold mb-2">{title}</h3>
    <p className="text-muted-foreground">{description}</p>
  </div>
);

export default Index;
