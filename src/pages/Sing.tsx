import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Save, Volume2, VolumeX, Edit2, Search, RefreshCw, Music, Check } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalAnalysis } from "@/hooks/useVocalAnalysis";
import { useAuth } from "@/hooks/useAuth";
import { Slider } from "@/components/ui/slider";

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

interface LyricsSearchResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  lyrics: LyricLine[];
  synced: boolean;
}

const Sing = () => {
  const { trackId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  
  const [track, setTrack] = useState<Track | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [totalScore, setTotalScore] = useState(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  
  // Lyrics search dialog state
  const [lyricsDialogOpen, setLyricsDialogOpen] = useState(false);
  const [lyricsSearchTitle, setLyricsSearchTitle] = useState("");
  const [lyricsSearchArtist, setLyricsSearchArtist] = useState("");
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [lyricsSearchResults, setLyricsSearchResults] = useState<LyricsSearchResult[]>([]);
  const [selectedLyricsId, setSelectedLyricsId] = useState<string>("");
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scoreAccumulatorRef = useRef({ pitch: 0, rhythm: 0, diction: 0, count: 0 });

  const { 
    isActive: isMicActive, 
    metrics, 
    isTranscriptionDisabled,
    isModelLoading,
    loadProgress,
    isModelReady,
    startAnalysis, 
    stopAnalysis,
    resetScores,
    retryTranscription,
  } = useVocalAnalysis({
    onMetricsUpdate: (m) => {
      // Always update score when playing, even without voice detection
      // This allows diction scores from Whisper to contribute
      if (isPlaying) {
        if (m.isVoiceDetected || m.diction > 0) {
          scoreAccumulatorRef.current.pitch += m.pitchAccuracy;
          scoreAccumulatorRef.current.rhythm += m.rhythm;
          scoreAccumulatorRef.current.diction += m.diction;
          scoreAccumulatorRef.current.count += 1;
        }
        
        if (scoreAccumulatorRef.current.count > 0) {
          const avgPitch = scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count;
          const avgRhythm = scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count;
          const avgDiction = scoreAccumulatorRef.current.diction / scoreAccumulatorRef.current.count;
          const combined = (avgPitch * 0.4 + avgRhythm * 0.35 + avgDiction * 0.25);
          setTotalScore(Math.round(combined * 10));
        }
      }
    }
  });

  // Load track and pre-fetched lyrics from session storage
  useEffect(() => {
    const stored = sessionStorage.getItem('selectedTrack');
    if (stored) {
      const parsed = JSON.parse(stored);
      setTrack(parsed);
      
      // Check for pre-fetched lyrics first
      const prefetchedLyrics = sessionStorage.getItem('prefetchedLyrics');
      if (prefetchedLyrics) {
        try {
          const parsedLyrics = JSON.parse(prefetchedLyrics);
          if (parsedLyrics && parsedLyrics.length > 0) {
            setLyrics(parsedLyrics);
          } else {
            fetchLyrics(parsed.title, parsed.artist);
          }
        } catch {
          fetchLyrics(parsed.title, parsed.artist);
        }
        // Clean up after use
        sessionStorage.removeItem('prefetchedLyrics');
      } else {
        fetchLyrics(parsed.title, parsed.artist);
      }
    } else {
      navigate('/');
    }
  }, [trackId, navigate, toast]);

  // Initialize HTML5 Audio Player - use Saavn URL directly (no proxy needed)
  useEffect(() => {
    if (!track?.audioUrl) return;

    let isMounted = true;
    setIsLoadingAudio(true);
    
    const audio = new Audio();
    audioRef.current = audio;
    
    // Use Saavn audio URL directly - it supports CORS for playback
    audio.src = track.audioUrl;
    audio.preload = "auto";
    
    const onLoadedMetadata = () => {
      if (!isMounted) return;
      setDuration(audio.duration);
      setIsPlayerReady(true);
      setIsLoadingAudio(false);
    };
    
    const onTimeUpdate = () => {
      if (isMounted) setCurrentTime(audio.currentTime);
    };
    
    const onPlay = () => {
      if (isMounted) setIsPlaying(true);
    };
    
    const onPause = () => {
      if (isMounted) setIsPlaying(false);
    };
    
    const onEnded = () => {
      if (isMounted) {
        setIsPlaying(false);
        setShowResults(true);
      }
    };
    
    const onError = () => {
      console.error('Audio error:', audio.error);
      if (isMounted) {
        setIsLoadingAudio(false);
        toast({
          title: "Audio error",
          description: "Failed to load. Try another song.",
          variant: "destructive",
        });
      }
    };
    
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      isMounted = false;
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.src = '';
      audioRef.current = null;
      stopAnalysis();
    };
  }, [track?.audioUrl, toast, stopAnalysis]);

  // Update volume/mute when changed
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume / 100;
      audioRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  const fetchLyrics = async (title: string, artist: string) => {
    try {
      setLyrics([]);
      const { data } = await supabase.functions.invoke('fetch-lyrics', {
        body: { title, artist }
      });
      if (data?.lyrics && data.lyrics.length > 0) {
        setLyrics(data.lyrics);
      } else {
        toast({ 
          title: "No lyrics found", 
          description: "Try editing the title to search again",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
      toast({ 
        title: "Failed to fetch lyrics", 
        description: "Try editing the title to search again",
        variant: "destructive"
      });
    }
  };

  const handleLyricsSearch = async () => {
    if (!lyricsSearchTitle.trim()) {
      toast({ title: "Please enter a song title", variant: "destructive" });
      return;
    }
    
    setIsSearchingLyrics(true);
    setLyricsSearchResults([]);
    setSelectedLyricsId("");
    
    try {
      const { data } = await supabase.functions.invoke('fetch-lyrics', {
        body: { title: lyricsSearchTitle.trim(), artist: lyricsSearchArtist.trim(), searchMultiple: true }
      });
      
      if (data?.results && data.results.length > 0) {
        setLyricsSearchResults(data.results);
        setSelectedLyricsId(String(data.results[0].id));
      } else {
        toast({ 
          title: "No lyrics found", 
          description: "Try a different search term",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Failed to search lyrics:', error);
      toast({ 
        title: "Failed to search lyrics", 
        description: "Please try again",
        variant: "destructive"
      });
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const handleSelectLyrics = () => {
    const selected = lyricsSearchResults.find(r => String(r.id) === selectedLyricsId);
    if (selected) {
      setLyrics(selected.lyrics);
      setLyricsDialogOpen(false);
      setLyricsSearchResults([]);
      toast({ title: "Lyrics loaded", description: `${selected.trackName} by ${selected.artistName}` });
    }
  };

  const openLyricsDialog = () => {
    const cleanTitle = track?.title
      ?.replace(/\(.*?\)/g, '')
      ?.replace(/\[.*?\]/g, '')
      ?.replace(/karaoke|instrumental|lyrics|official|video|audio|hd|4k/gi, '')
      ?.replace(/&quot;|&amp;/g, '')
      ?.trim() || '';
    const cleanArtist = track?.artist?.trim() || '';
    
    setLyricsSearchTitle(cleanTitle);
    setLyricsSearchArtist(cleanArtist);
    setLyricsSearchResults([]);
    setSelectedLyricsId("");
    setLyricsDialogOpen(true);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Update current line based on time
  useEffect(() => {
    if (lyrics.length === 0) return;
    
    const index = lyrics.findIndex((line, i) => {
      const nextLine = lyrics[i + 1];
      return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
    setCurrentLineIndex(index);
  }, [currentTime, lyrics]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !isPlayerReady) return;

    if (isPlaying) {
      audio.pause();
      return;
    }

    // Start mic on first user interaction (keeps mic "default on" without breaking autoplay policies)
    if (!isMicActive) {
      try {
        await startAnalysis();
      } catch (err) {
        console.warn("Microphone permission denied/unavailable:", err);
      }
    }

    try {
      await audio.play();
    } catch (error) {
      console.error("Audio play() failed:", error);
      const name = (error as any)?.name;

      toast({
        title: name === "NotAllowedError" ? "Playback blocked" : "Playback failed",
        description:
          name === "NotSupportedError"
            ? "This track format isn't supported by your browser."
            : name === "NotAllowedError"
              ? "Tap Play again (browser requires a direct user action)."
              : "Unable to start playback. Try another song.",
        variant: "destructive",
      });
    }
  }, [isPlaying, isPlayerReady, isMicActive, startAnalysis, toast]);

  const toggleMic = useCallback(async () => {
    if (isMicActive) {
      stopAnalysis();
    } else {
      await startAnalysis();
    }
  }, [isMicActive, startAnalysis, stopAnalysis]);

  const handleVolumeChange = useCallback((value: number[]) => {
    const newVolume = value[0];
    setVolume(newVolume);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted(!isMuted);
  }, [isMuted]);

  const handleRestart = useCallback(() => {
    setCurrentTime(0);
    setTotalScore(0);
    scoreAccumulatorRef.current = { pitch: 0, rhythm: 0, diction: 0, count: 0 };
    resetScores();
    setShowResults(false);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
  }, [resetScores]);

  const handleSaveScore = async () => {
    if (!user || !track) {
      toast({ title: "Please sign in to save scores", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      const avgPitch = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count : 0;
      const avgRhythm = scoreAccumulatorRef.current.count > 0 
        ? scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count : 0;

      const rating = totalScore >= 900 ? 'S' : totalScore >= 800 ? 'A' : totalScore >= 700 ? 'B' : 
                     totalScore >= 600 ? 'C' : totalScore >= 500 ? 'D' : 'F';

      const { error } = await supabase.from('scores').insert({
        user_id: user.id,
        song_title: track.title,
        song_artist: track.artist,
        track_id: track.id,
        score: totalScore,
        rating,
        timing_accuracy: Math.round(avgPitch),
        rhythm_accuracy: Math.round(avgRhythm),
        duration_seconds: Math.round(duration),
        thumbnail_url: track.thumbnail,
      });

      if (error) throw error;

      toast({ title: "Score saved!" });
      navigate('/history');
    } catch (error) {
      console.error('Failed to save score:', error);
      toast({ title: "Failed to save score", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const getScoreColor = (value: number) => {
    if (value >= 80) return 'bg-score-perfect';
    if (value >= 60) return 'bg-score-great';
    if (value >= 40) return 'bg-score-good';
    return 'bg-score-miss';
  };

  const getRating = (score: number) => {
    if (score >= 900) return { letter: 'S', color: 'text-score-perfect' };
    if (score >= 800) return { letter: 'A', color: 'text-score-great' };
    if (score >= 700) return { letter: 'B', color: 'text-score-good' };
    if (score >= 600) return { letter: 'C', color: 'text-score-ok' };
    if (score >= 500) return { letter: 'D', color: 'text-score-ok' };
    return { letter: 'F', color: 'text-score-miss' };
  };

  const rating = getRating(totalScore);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="glass border-b border-border p-4 flex items-center gap-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-sm text-muted-foreground truncate">{track?.artist}</p>
        </div>
        
        {/* Edit Lyrics Search Button */}
        <Dialog open={lyricsDialogOpen} onOpenChange={setLyricsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" onClick={openLyricsDialog} className="shrink-0">
              <Edit2 className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">Edit Lyrics</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg bg-card max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Search Lyrics</DialogTitle>
              <DialogDescription>
                Search for synced lyrics from LRCLIB and select from the results.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4 flex-1 overflow-y-auto">
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
              
              {/* Search Results */}
              {lyricsSearchResults.length > 0 && (
                <div className="space-y-2 pt-2">
                  <Label>Select Lyrics ({lyricsSearchResults.length} results)</Label>
                  <RadioGroup value={selectedLyricsId} onValueChange={setSelectedLyricsId} className="space-y-2">
                    {lyricsSearchResults.map((result) => (
                      <label
                        key={result.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedLyricsId === String(result.id) 
                            ? 'border-primary bg-primary/10' 
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <RadioGroupItem value={String(result.id)} className="mt-1" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{result.trackName}</p>
                          <p className="text-sm text-muted-foreground truncate">{result.artistName}</p>
                          <div className="flex items-center gap-2 mt-1">
                            {result.albumName && (
                              <span className="text-xs text-muted-foreground truncate max-w-[150px]">
                                {result.albumName}
                              </span>
                            )}
                            {result.duration && (
                              <span className="text-xs text-muted-foreground">
                                {formatDuration(result.duration)}
                              </span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              result.synced 
                                ? 'bg-score-perfect/20 text-score-perfect' 
                                : 'bg-muted text-muted-foreground'
                            }`}>
                              {result.synced ? 'Synced' : 'Plain'}
                            </span>
                          </div>
                        </div>
                        {selectedLyricsId === String(result.id) && (
                          <Check className="w-4 h-4 text-primary mt-1" />
                        )}
                      </label>
                    ))}
                  </RadioGroup>
                </div>
              )}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setLyricsDialogOpen(false)}>
                Cancel
              </Button>
              {lyricsSearchResults.length > 0 ? (
                <Button 
                  onClick={handleSelectLyrics}
                  disabled={!selectedLyricsId}
                  className="gradient-primary text-primary-foreground"
                >
                  <Check className="w-4 h-4 mr-2" />
                  Use Selected
                </Button>
              ) : (
                <Button 
                  onClick={handleLyricsSearch} 
                  disabled={isSearchingLyrics || !lyricsSearchTitle.trim()}
                  className="gradient-primary text-primary-foreground"
                >
                  {isSearchingLyrics ? (
                    <>Searching...</>
                  ) : (
                    <>
                      <Search className="w-4 h-4 mr-2" />
                      Search
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        
        
        {/* Volume Control */}
        <div className="hidden sm:flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={toggleMute}>
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </Button>
          <Slider
            value={[isMuted ? 0 : volume]}
            onValueChange={handleVolumeChange}
            max={100}
            step={1}
            className="w-24"
          />
        </div>
      </header>

      {/* Results Overlay */}
      {showResults && (
        <div className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4 animate-fade-in">
          <div className="text-center max-w-md">
            <p className={`text-8xl font-bold mb-4 animate-scale-in ${rating.color}`}>
              {rating.letter}
            </p>
            <p className="text-5xl font-bold text-gradient-gold mb-8">{totalScore}</p>
            
            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="text-center">
                <p className="text-2xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-sm text-muted-foreground">Pitch</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-sm text-muted-foreground">Rhythm</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.diction / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-sm text-muted-foreground">Diction</p>
              </div>
            </div>
            
            <div className="flex gap-4 justify-center">
              <Button variant="outline" size="lg" onClick={handleRestart}>
                <RotateCcw className="w-5 h-5 mr-2" />
                Try Again
              </Button>
              {user && (
                <Button 
                  size="lg" 
                  className="gradient-primary text-primary-foreground"
                  onClick={handleSaveScore}
                  disabled={isSaving}
                >
                  <Save className="w-5 h-5 mr-2" />
                  {isSaving ? 'Saving...' : 'Save Score'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lyrics Display */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 overflow-hidden">
        {!isPlayerReady ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4 animate-pulse">
              <Play className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground">Loading audio...</p>
          </div>
        ) : (
          <div className="w-full max-w-4xl space-y-3">
            {lyrics.length === 0 ? (
              <div className="text-center py-12">
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg" />
                <p className="text-muted-foreground mt-4">Loading lyrics...</p>
              </div>
            ) : (
              lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 5).map((line, i) => {
                const actualIndex = Math.max(0, currentLineIndex - 1) + i;
                const isCurrent = actualIndex === currentLineIndex;
                const isPast = actualIndex < currentLineIndex;
                const progress = isCurrent && line.duration 
                  ? Math.min(100, ((currentTime - line.time) / line.duration) * 100) 
                  : isPast ? 100 : 0;
                
                return (
                  <div 
                    key={`${actualIndex}-${line.time}`} 
                    className={`singing-bar transition-all duration-300 ${
                      isCurrent ? 'ring-2 ring-primary scale-[1.02]' : isPast ? 'opacity-40' : 'opacity-60'
                    }`}
                  >
                    <div 
                      className="singing-bar-progress" 
                      style={{ width: `${progress}%` }} 
                    />
                    
                    {isCurrent && isMicActive && (
                      <div 
                        className="singing-bar-performance"
                        style={{ width: `${metrics.volume * 100}%` }}
                      />
                    )}
                    
                    <span 
                      className={`relative z-10 text-lg md:text-2xl lg:text-3xl leading-tight transition-colors tracking-wide ${
                        isCurrent ? 'text-foreground font-semibold' : 'text-muted-foreground'
                      }`}
                      style={{ wordSpacing: '0.3em' }}
                    >
                      {line.text || '♪ ♪ ♪'}
                    </span>
                    
                    {isCurrent && isMicActive && metrics.isVoiceDetected && (
                      <span className="absolute right-4 text-sm font-medium text-score-perfect animate-score-pop">
                        +{Math.round(metrics.pitchAccuracy / 10)}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Score Panel */}
      <div className="score-panel p-4 md:p-6 shrink-0">
        <div className="max-w-4xl mx-auto">
          {/* Live Transcription Display - Always visible when mic is on */}
          {isMicActive && (
            <div className="mb-4 p-3 bg-muted/50 rounded-lg border border-border/50">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${metrics.transcribedText ? 'bg-score-perfect' : 'bg-muted-foreground'} animate-pulse`} />
                {isModelLoading ? `Loading Whisper (${loadProgress}%)...` : isModelReady ? 'Live transcription' : 'Waiting for model...'}
              </p>
              <p className="text-sm text-foreground italic truncate">
                {metrics.transcribedText ? `"${metrics.transcribedText}"` : '(listening...)'}
              </p>
            </div>
          )}
          
          {/* Metrics */}
          <div className="grid grid-cols-4 gap-3 md:gap-4 mb-4">
            <ScoreItem 
              label="Pitch" 
              value={metrics.pitchAccuracy} 
              color={getScoreColor(metrics.pitchAccuracy)}
              isActive={metrics.isVoiceDetected}
            />
            <ScoreItem 
              label="Rhythm" 
              value={metrics.rhythm} 
              color={getScoreColor(metrics.rhythm)}
              isActive={metrics.isVoiceDetected}
            />
            <ScoreItem 
              label={isModelLoading ? `Diction (${loadProgress}%)` : "Diction"} 
              value={metrics.diction} 
              color={getScoreColor(metrics.diction)}
              isActive={metrics.isVoiceDetected}
              disabled={isTranscriptionDisabled || isModelLoading}
              onRetry={retryTranscription}
            />
            <div className="text-center">
              <p className={`text-2xl md:text-3xl font-bold ${rating.color}`}>
                {totalScore}
              </p>
              <p className="text-xs text-muted-foreground">Score</p>
            </div>
          </div>
          
          {/* Progress bar */}
          <div className="h-1 bg-muted rounded-full mb-4 overflow-hidden">
            <div 
              className="h-full gradient-primary transition-all duration-100"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
          
          {/* Controls */}
          <div className="flex justify-center items-center gap-4">
            <Button 
              variant="outline" 
              size="lg" 
              onClick={toggleMic} 
              className={`transition-all ${isMicActive ? 'bg-primary text-primary-foreground shadow-glow' : ''}`}
            >
              {isMicActive ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
              <span className="ml-2 hidden sm:inline">{isMicActive ? 'Mic On' : 'Mic Off'}</span>
            </Button>
            
            <Button 
              size="lg" 
              onClick={togglePlay} 
              disabled={!isPlayerReady}
              className={`gradient-primary text-primary-foreground px-8 ${isPlaying ? 'animate-pulse-glow' : ''}`}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              <span className="ml-2">{isPlaying ? 'Pause' : 'Play'}</span>
            </Button>
            
            <Button variant="outline" size="lg" onClick={handleRestart}>
              <RotateCcw className="w-5 h-5" />
              <span className="ml-2 hidden sm:inline">Restart</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ScoreItemProps {
  label: string;
  value: number;
  color: string;
  isActive: boolean;
  disabled?: boolean;
  onRetry?: () => void;
}

const ScoreItem = ({ label, value, color, isActive, disabled, onRetry }: ScoreItemProps) => (
  <div className="text-center relative">
    <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
      <div 
        className={`h-full transition-all duration-200 ${disabled ? 'bg-muted-foreground/30' : color}`} 
        style={{ width: `${value}%` }} 
      />
    </div>
    {disabled ? (
      <button 
        onClick={onRetry}
        className="text-xs text-amber-500 hover:text-amber-400 flex items-center justify-center gap-1 mx-auto transition-colors"
        title="Retry diction scoring"
      >
        <RefreshCw className="w-3 h-3" />
        <span>Retry</span>
      </button>
    ) : (
      <p className={`text-sm font-medium transition-all ${isActive ? 'scale-110' : ''}`}>
        {Math.round(value)}%
      </p>
    )}
    <p className="text-xs text-muted-foreground">{label}</p>
  </div>
);

export default Sing;
