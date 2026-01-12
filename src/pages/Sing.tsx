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
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Save, Volume2, VolumeX, Edit2, Search, RefreshCw, Music, Check, Music2, Loader2, Sparkles } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalAnalysis } from "@/hooks/useVocalAnalysis";
import { useAuth } from "@/hooks/useAuth";
import { Slider } from "@/components/ui/slider";
import { useVocalSeparation } from "@/hooks/useVocalSeparation";

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
  
  // Main instrumental audio
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Vocals audio (plays at 50% volume when enabled)
  const vocalsAudioRef = useRef<HTMLAudioElement | null>(null);
  const timeSyncRafRef = useRef<number | null>(null);
  const scoreAccumulatorRef = useRef({ pitch: 0, rhythm: 0, diction: 0, technique: 0, deductions: 0, count: 0 });
  const lastScoreSampleAtRef = useRef(0);

  // New scoring weights from karaoke formula: Pitch 30%, Diction 30%, Technique 20%, Rhythm 20%
  const SCORE_WEIGHTS = useRef({ pitch: 0.3, diction: 0.3, technique: 0.2, rhythm: 0.2 }).current;

  const {
    isActive: isMicActive,
    metrics,
    isTranscriptionDisabled,
    transcriptionError,
    isModelLoading,
    loadProgress,
    isModelReady,
    startAnalysis,
    stopAnalysis,
    resetScores,
    retryTranscription,
  } = useVocalAnalysis();

  // AI-based vocal separation (Demucs via HuggingFace)
  const {
    isProcessing: isSeparating,
    progress: separationProgress,
    error: separationError,
    separatedAudio,
    separateVocals,
    reset: resetSeparation,
  } = useVocalSeparation();

  // Vocals ON/OFF toggle (plays vocals at 50% volume when ON)
  const [vocalsEnabled, setVocalsEnabled] = useState(true);

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

  // Auto-start AI separation when track loads
  useEffect(() => {
    if (track?.audioUrl && !separatedAudio && !isSeparating && !separationError) {
      separateVocals(track.audioUrl).then((result) => {
        if (result) {
          console.log('[ai-separation] Auto-started and completed successfully');
        }
      });
    }
  }, [track?.audioUrl, separatedAudio, isSeparating, separationError, separateVocals]);

  // Initialize HTML5 Audio Player - Demucs instrumental or fallback to original
  useEffect(() => {
    if (!track?.audioUrl) return;

    let isMounted = true;
    setIsLoadingAudio(true);

    const audio = new Audio();
    audioRef.current = audio;

    // Set audio session type to 'playback' for proper volume button behavior on mobile
    if ('audioSession' in navigator && (navigator as any).audioSession) {
      try {
        (navigator as any).audioSession.type = 'playback';
        console.log('[audio] Set audio session type to playback');
      } catch (e) {
        console.log('[audio] Could not set audio session type:', e);
      }
    }

    const stopTimeSync = () => {
      if (timeSyncRafRef.current != null) {
        cancelAnimationFrame(timeSyncRafRef.current);
        timeSyncRafRef.current = null;
      }
    };

    const startTimeSync = () => {
      if (timeSyncRafRef.current != null) return;
      const tick = () => {
        if (!isMounted || !audioRef.current) return;
        setCurrentTime(audioRef.current.currentTime);
        timeSyncRafRef.current = requestAnimationFrame(tick);
      };
      timeSyncRafRef.current = requestAnimationFrame(tick);
    };

    // Use AI-separated instrumental if available, otherwise original track
    audio.crossOrigin = "anonymous";
    audio.src = separatedAudio?.instrumentalUrl || track.audioUrl;
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
      if (!isMounted) return;
      setIsPlaying(true);
      startTimeSync();
    };

    const onPause = () => {
      if (!isMounted) return;
      setIsPlaying(false);
      stopTimeSync();
    };

    const onEnded = () => {
      if (isMounted) {
        setIsPlaying(false);
        stopTimeSync();
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
      stopTimeSync();
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
  }, [track?.audioUrl, toast, stopAnalysis, separatedAudio?.instrumentalUrl]);

  // Setup vocals audio when separated audio is available
  useEffect(() => {
    if (!separatedAudio?.vocalsUrl) {
      vocalsAudioRef.current = null;
      return;
    }

    const vocalsAudio = new Audio();
    vocalsAudio.crossOrigin = "anonymous";
    vocalsAudio.src = separatedAudio.vocalsUrl;
    vocalsAudio.preload = "auto";
    vocalsAudio.volume = 0.4; // 40% volume
    vocalsAudioRef.current = vocalsAudio;

    return () => {
      vocalsAudio.pause();
      vocalsAudio.src = '';
      vocalsAudioRef.current = null;
    };
  }, [separatedAudio?.vocalsUrl]);

  // Sync vocals audio with main audio
  useEffect(() => {
    const vocalsAudio = vocalsAudioRef.current;
    if (!vocalsAudio || !separatedAudio?.vocalsUrl) return;

    if (isPlaying && vocalsEnabled) {
      vocalsAudio.currentTime = currentTime;
      vocalsAudio.play().catch(console.error);
    } else {
      vocalsAudio.pause();
    }
  }, [isPlaying, vocalsEnabled, separatedAudio?.vocalsUrl]);

  // Sync vocals audio time when main audio seeks
  useEffect(() => {
    const vocalsAudio = vocalsAudioRef.current;
    if (!vocalsAudio) return;
    
    // Only sync if difference is significant (>0.5s)
    if (Math.abs(vocalsAudio.currentTime - currentTime) > 0.5) {
      vocalsAudio.currentTime = currentTime;
    }
  }, [currentTime]);

  // Update volume/mute when changed - instrumental always plays, vocals only when enabled
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume / 100;
      audioRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // Vocals volume is independent - 40% of master, and controlled by vocalsEnabled
  useEffect(() => {
    if (vocalsAudioRef.current) {
      // Vocals at 40% of the master volume, but only if enabled
      const vocalsVolume = vocalsEnabled ? (volume / 100) * 0.4 : 0;
      vocalsAudioRef.current.volume = isMuted ? 0 : vocalsVolume;
      vocalsAudioRef.current.muted = isMuted || !vocalsEnabled;
    }
  }, [volume, isMuted, vocalsEnabled]);

  // Accumulate score from live metrics while audio is playing.
  // NOTE: This lives outside the mic hook so it always sees the latest `isPlaying` state.
  useEffect(() => {
    if (!isPlaying) return;

    // Sample at ~5Hz to keep updates smooth but not overly chatty.
    const now = performance.now();
    if (now - lastScoreSampleAtRef.current < 200) return;
    lastScoreSampleAtRef.current = now;

    if (metrics.isVoiceDetected || metrics.diction > 0) {
      scoreAccumulatorRef.current.pitch += metrics.pitchAccuracy;
      scoreAccumulatorRef.current.rhythm += metrics.rhythm;
      scoreAccumulatorRef.current.diction += metrics.diction;
      scoreAccumulatorRef.current.technique += metrics.technique;
      scoreAccumulatorRef.current.deductions += metrics.deductions;
      scoreAccumulatorRef.current.count += 1;
    }

    if (scoreAccumulatorRef.current.count > 0) {
      const avgPitch = scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count;
      const avgRhythm = scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count;
      const avgDiction = scoreAccumulatorRef.current.diction / scoreAccumulatorRef.current.count;
      const avgTechnique = scoreAccumulatorRef.current.technique / scoreAccumulatorRef.current.count;
      const avgDeductions = scoreAccumulatorRef.current.deductions / scoreAccumulatorRef.current.count;

      // Formula: Score = (Wp · P) + (Wr · R) + (Wt · T) + (Wd · D) - E
      const combined =
        avgPitch * SCORE_WEIGHTS.pitch +
        avgDiction * SCORE_WEIGHTS.diction +
        avgTechnique * SCORE_WEIGHTS.technique +
        avgRhythm * SCORE_WEIGHTS.rhythm;
      
      // Apply deductions (E in the formula) - scale to max 20% of score
      const deductionPenalty = (avgDeductions / 100) * 0.2 * combined;
      const finalScore = Math.max(0, combined - deductionPenalty);

      setTotalScore(Math.round(finalScore * 10));
    }
  }, [isPlaying, metrics, SCORE_WEIGHTS]);

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
      vocalsAudioRef.current?.pause();
      return;
    }

    // CRITICAL: Start audio playback FIRST in the user gesture for mobile compatibility
    try {
      await audio.play();
      // Start vocals if enabled
      if (vocalsEnabled && vocalsAudioRef.current) {
        vocalsAudioRef.current.currentTime = audio.currentTime;
        vocalsAudioRef.current.play().catch(console.error);
      }
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
      return; // Don't start mic if audio failed
    }

    // Start mic AFTER audio playback has begun (non-blocking for the user)
    if (!isMicActive) {
      startAnalysis().catch((err) => {
        console.warn("Microphone permission denied/unavailable:", err);
      });
    }
  }, [isPlaying, isPlayerReady, isMicActive, startAnalysis, toast, vocalsEnabled]);

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

  const toggleVocals = useCallback(() => {
    setVocalsEnabled(!vocalsEnabled);
  }, [vocalsEnabled]);

  const handleRestart = useCallback(() => {
    setCurrentTime(0);
    setTotalScore(0);
    scoreAccumulatorRef.current = { pitch: 0, rhythm: 0, diction: 0, technique: 0, deductions: 0, count: 0 };
    lastScoreSampleAtRef.current = 0;
    resetScores();
    setShowResults(false);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    if (vocalsAudioRef.current) {
      vocalsAudioRef.current.currentTime = 0;
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

      const rating = totalScore >= 900 ? 'L' : totalScore >= 800 ? 'S' : totalScore >= 700 ? 'A' : 
                     totalScore >= 600 ? 'B' : totalScore >= 500 ? 'C' : totalScore >= 300 ? 'D' : 'F';

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
    if (score >= 900) return { letter: 'L', color: 'text-score-perfect' };
    if (score >= 800) return { letter: 'S', color: 'text-score-perfect' };
    if (score >= 700) return { letter: 'A', color: 'text-score-great' };
    if (score >= 600) return { letter: 'B', color: 'text-score-good' };
    if (score >= 500) return { letter: 'C', color: 'text-score-ok' };
    if (score >= 300) return { letter: 'D', color: 'text-score-ok' };
    return { letter: 'F', color: 'text-score-miss' };
  };

  const rating = getRating(totalScore);

  // Handle starting AI separation
  const handleStartSeparation = async () => {
    if (track?.audioUrl) {
      const result = await separateVocals(track.audioUrl);
      if (result) {
        toast({ title: "AI separation complete", description: "Now playing instrumental track with optional vocals" });
      }
    }
  };

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
        
        {/* AI Vocal Separation Button - only show if not yet separated */}
        {!separatedAudio && !isSeparating && (
          <Button 
            variant="outline" 
            size="sm"
            onClick={handleStartSeparation}
            className="shrink-0 gap-1.5"
            title="Use AI to separate vocals (Demucs)"
          >
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline">AI Separate</span>
          </Button>
        )}
        
        {isSeparating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="hidden sm:inline">{separationProgress || 'Processing...'}</span>
          </div>
        )}
        
        {separationError && !isSeparating && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <span className="hidden sm:inline truncate max-w-[150px]" title={separationError}>
              AI failed
            </span>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={resetSeparation}
              className="h-6 px-2 text-xs"
            >
              Retry
            </Button>
          </div>
        )}

        {/* Vocals ON/OFF Toggle - only show when separation is complete */}
        {separatedAudio && (
          <Button 
            variant={vocalsEnabled ? "default" : "outline"} 
            size="sm"
            onClick={toggleVocals}
            className={`shrink-0 gap-1.5 ${vocalsEnabled ? 'bg-primary hover:bg-primary/90' : ''}`}
            title={vocalsEnabled ? 'Vocals playing at 80%' : 'Enable vocals (80% volume)'}
          >
            <Music2 className="w-4 h-4" />
            <span className="hidden sm:inline">
              {vocalsEnabled ? 'Vocals On' : 'Vocals Off'}
            </span>
          </Button>
        )}
        
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
            
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Pitch <span className="text-primary/70">(30%)</span></p>
              </div>
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.diction / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Diction <span className="text-primary/70">(30%)</span></p>
              </div>
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.technique / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Technique <span className="text-primary/70">(20%)</span></p>
              </div>
              <div className="text-center p-3 bg-muted/30 rounded-lg">
                <p className="text-xl font-semibold">
                  {scoreAccumulatorRef.current.count > 0 
                    ? Math.round(scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count) 
                    : 0}%
                </p>
                <p className="text-xs text-muted-foreground">Rhythm <span className="text-primary/70">(20%)</span></p>
              </div>
            </div>
            
            {/* Deductions display */}
            {scoreAccumulatorRef.current.count > 0 && 
             Math.round(scoreAccumulatorRef.current.deductions / scoreAccumulatorRef.current.count) > 0 && (
              <div className="text-center mb-6 p-2 bg-destructive/10 rounded-lg border border-destructive/30">
                <p className="text-sm text-destructive">
                  -{Math.round(scoreAccumulatorRef.current.deductions / scoreAccumulatorRef.current.count)}% Deductions
                </p>
                <p className="text-xs text-muted-foreground">Off-key noise or singing during breaks</p>
              </div>
            )}
            
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
          <div className="w-full max-w-4xl space-y-3 flex flex-col items-center">
            {lyrics.length === 0 ? (
              <div className="text-center py-12">
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg mb-3" />
                <div className="animate-shimmer h-12 rounded-lg" />
                <p className="text-muted-foreground mt-4">Loading lyrics...</p>
              </div>
            ) : (
              lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 4).map((line, i) => {
                const actualIndex = Math.max(0, currentLineIndex - 1) + i;
                const isCurrent = actualIndex === currentLineIndex;
                const isPast = actualIndex < currentLineIndex;

                const nextLine = lyrics[actualIndex + 1];
                const effectiveDuration =
                  line.duration && line.duration > 0
                    ? line.duration
                    : nextLine
                      ? Math.max(0.25, nextLine.time - line.time)
                      : Math.max(0.25, duration - line.time);

                const lineProgress = isCurrent
                  ? Math.min(1, Math.max(0, (currentTime - line.time) / effectiveDuration))
                  : isPast
                    ? 1
                    : 0;

                return (
                  <div
                    key={actualIndex}
                  className={`text-center transition-all duration-300 w-full ${
                    isCurrent
                      ? 'text-2xl md:text-4xl 2xl:text-5xl 3xl:text-6xl font-bold scale-100 opacity-100'
                      : isPast
                        ? 'text-lg md:text-xl 2xl:text-2xl 3xl:text-3xl opacity-40 scale-95'
                        : 'text-lg md:text-xl 2xl:text-2xl 3xl:text-3xl opacity-60 scale-95'
                  }`}
                  >
                    <div className="relative inline-block">
                      <span className="text-muted-foreground">{line.text}</span>
                      {isCurrent && (
                        <span
                          className="absolute left-0 top-0 text-primary overflow-hidden whitespace-nowrap"
                          style={{ width: `${lineProgress * 100}%` }}
                        >
                          {line.text}
                        </span>
                      )}
                      {isPast && (
                        <span className="absolute left-0 top-0 text-primary/70 overflow-hidden whitespace-nowrap w-full">
                          {line.text}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Score Display */}
      <div className="glass border-t border-border p-4 shrink-0">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-gradient-gold">{totalScore}</p>
              <p className="text-xs text-muted-foreground">Score</p>
            </div>
            <div className={`text-2xl font-bold ${rating.color}`}>
              {rating.letter}
            </div>
          </div>

          {/* Live Metrics */}
          {isMicActive && (
            <div className="hidden md:flex items-center gap-3">
              <div className="text-center">
                <div className={`h-1 w-12 rounded-full ${getScoreColor(metrics.pitchAccuracy)}`} />
                <p className="text-xs text-muted-foreground mt-1">Pitch</p>
              </div>
              <div className="text-center">
                <div className={`h-1 w-12 rounded-full ${getScoreColor(metrics.diction)}`} />
                <p className="text-xs text-muted-foreground mt-1">Diction</p>
              </div>
              <div className="text-center">
                <div className={`h-1 w-12 rounded-full ${getScoreColor(metrics.technique)}`} />
                <p className="text-xs text-muted-foreground mt-1">Technique</p>
              </div>
              <div className="text-center">
                <div className={`h-1 w-12 rounded-full ${getScoreColor(metrics.rhythm)}`} />
                <p className="text-xs text-muted-foreground mt-1">Rhythm</p>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={toggleMic}
              className={isMicActive ? 'bg-primary text-primary-foreground' : ''}
            >
              {isMicActive ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
            </Button>
            
            <Button
              size="lg"
              onClick={togglePlay}
              disabled={!isPlayerReady || isSeparating || !separatedAudio}
              className="gradient-primary text-primary-foreground w-16 h-16 rounded-full disabled:opacity-50"
              title={!separatedAudio ? 'Waiting for AI separation...' : isPlaying ? 'Pause' : 'Play'}
            >
              {isSeparating ? <Loader2 className="w-8 h-8 animate-spin" /> : isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
            </Button>

            <Button variant="outline" size="icon" onClick={handleRestart}>
              <RotateCcw className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="max-w-4xl mx-auto mt-4">
          <div
            className="h-1 bg-muted rounded-full cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              const newTime = percent * duration;
              if (audioRef.current) {
                audioRef.current.currentTime = newTime;
              }
              if (vocalsAudioRef.current) {
                vocalsAudioRef.current.currentTime = newTime;
              }
              setCurrentTime(newTime);
            }}
          >
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${(currentTime / duration) * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>{formatDuration(currentTime)}</span>
            <span>{formatDuration(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sing;
