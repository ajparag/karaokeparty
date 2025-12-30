import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Play, Pause, Mic, MicOff, RotateCcw, Save } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalAnalysis } from "@/hooks/useVocalAnalysis";
import { useAuth } from "@/hooks/useAuth";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
  language?: string;
  streamUrl?: string;
}

interface LyricLine {
  time: number;
  text: string;
  duration?: number;
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
  const [showResults, setShowResults] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scoreAccumulatorRef = useRef({ pitch: 0, rhythm: 0, diction: 0, count: 0 });

  const { 
    isActive: isMicActive, 
    metrics, 
    startAnalysis, 
    stopAnalysis,
    resetScores 
  } = useVocalAnalysis({
    onMetricsUpdate: (m) => {
      if (m.isVoiceDetected && isPlaying) {
        scoreAccumulatorRef.current.pitch += m.pitchAccuracy;
        scoreAccumulatorRef.current.rhythm += m.rhythm;
        scoreAccumulatorRef.current.diction += m.diction;
        scoreAccumulatorRef.current.count += 1;
        
        // Calculate running total score (0-1000 scale)
        const avgPitch = scoreAccumulatorRef.current.pitch / scoreAccumulatorRef.current.count;
        const avgRhythm = scoreAccumulatorRef.current.rhythm / scoreAccumulatorRef.current.count;
        const avgDiction = scoreAccumulatorRef.current.diction / scoreAccumulatorRef.current.count;
        const combined = (avgPitch * 0.4 + avgRhythm * 0.35 + avgDiction * 0.25);
        setTotalScore(Math.round(combined * 10));
      }
    }
  });

  // Load track from session storage
  useEffect(() => {
    const stored = sessionStorage.getItem('selectedTrack');
    if (stored) {
      const parsed = JSON.parse(stored);
      setTrack(parsed);
      fetchLyrics(parsed.title, parsed.artist, parsed.duration);
    } else {
      navigate('/search');
    }
  }, [trackId, navigate]);

  const fetchLyrics = async (title: string, artist: string, trackDuration: number) => {
    try {
      const { data } = await supabase.functions.invoke('fetch-lyrics', {
        body: { title, artist, duration: trackDuration }
      });
      if (data?.lyrics) {
        setLyrics(data.lyrics);
      }
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
    }
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

  const togglePlay = useCallback(() => {
    if (!audioRef.current) {
      // If no audio element or stream, simulate playback for demo
      if (!track?.streamUrl) {
        setIsPlaying(!isPlaying);
        return;
      }
    }
    
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(console.error);
      }
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, track?.streamUrl]);

  const toggleMic = useCallback(async () => {
    if (isMicActive) {
      stopAnalysis();
    } else {
      await startAnalysis();
    }
  }, [isMicActive, startAnalysis, stopAnalysis]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  }, []);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setShowResults(true);
  }, []);

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
        youtube_video_id: track.id,
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

  // Simulate time progression when no audio
  useEffect(() => {
    if (!isPlaying || track?.streamUrl) return;
    
    const interval = setInterval(() => {
      setCurrentTime(prev => {
        const next = prev + 0.1;
        if (next >= (track?.duration || 180)) {
          handleEnded();
          return prev;
        }
        return next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying, track?.streamUrl, track?.duration, handleEnded]);

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
        <Button variant="ghost" size="icon" onClick={() => navigate('/search')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-sm text-muted-foreground truncate">{track?.artist}</p>
        </div>
        {track?.language && (
          <span className="language-badge text-muted-foreground shrink-0">
            {track.language}
          </span>
        )}
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
                  {/* Progress fill */}
                  <div 
                    className="singing-bar-progress" 
                    style={{ width: `${progress}%` }} 
                  />
                  
                  {/* Performance overlay - shows mic input level */}
                  {isCurrent && isMicActive && (
                    <div 
                      className="singing-bar-performance"
                      style={{ width: `${metrics.volume * 100}%` }}
                    />
                  )}
                  
                  {/* Lyrics text */}
                  <span className={`relative z-10 text-base md:text-lg transition-colors ${
                    isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'
                  }`}>
                    {line.text || '♪ ♪ ♪'}
                  </span>
                  
                  {/* Score indicator for current line */}
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
      </div>

      {/* Score Panel */}
      <div className="score-panel p-4 md:p-6 shrink-0">
        <div className="max-w-4xl mx-auto">
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
              label="Diction" 
              value={metrics.diction} 
              color={getScoreColor(metrics.diction)}
              isActive={metrics.isVoiceDetected}
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
              style={{ width: `${(currentTime / (duration || track?.duration || 180)) * 100}%` }}
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

      {/* Hidden Audio Element */}
      {track?.streamUrl && (
        <audio 
          ref={audioRef} 
          src={track.streamUrl} 
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          preload="auto"
        />
      )}
    </div>
  );
};

interface ScoreItemProps {
  label: string;
  value: number;
  color: string;
  isActive: boolean;
}

const ScoreItem = ({ label, value, color, isActive }: ScoreItemProps) => (
  <div className="text-center">
    <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
      <div 
        className={`h-full transition-all duration-200 ${color}`} 
        style={{ width: `${value}%` }} 
      />
    </div>
    <p className={`text-sm font-medium transition-all ${isActive ? 'scale-110' : ''}`}>
      {Math.round(value)}%
    </p>
    <p className="text-xs text-muted-foreground">{label}</p>
  </div>
);

export default Sing;
