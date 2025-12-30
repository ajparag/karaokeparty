import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Play, Pause, Mic, MicOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
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
  
  const [track, setTrack] = useState<Track | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [isMicActive, setIsMicActive] = useState(false);
  const [score, setScore] = useState({ pitch: 0, rhythm: 0, diction: 0, total: 0 });
  
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const fetchLyrics = async (title: string, artist: string, duration: number) => {
    try {
      const { data } = await supabase.functions.invoke('fetch-lyrics', {
        body: { title, artist, duration }
      });
      if (data?.lyrics) setLyrics(data.lyrics);
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
    }
  };

  useEffect(() => {
    const index = lyrics.findIndex((line, i) => {
      const nextLine = lyrics[i + 1];
      return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
    setCurrentLineIndex(index);
  }, [currentTime, lyrics]);

  const togglePlay = () => {
    if (!audioRef.current || !track?.streamUrl) {
      toast({ title: "Audio not available", variant: "destructive" });
      return;
    }
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const toggleMic = async () => {
    if (isMicActive) { setIsMicActive(false); return; }
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setIsMicActive(true);
    } catch {
      toast({ title: "Microphone access denied", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="glass border-b border-border p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/search')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{track?.title || 'Loading...'}</h1>
          <p className="text-sm text-muted-foreground truncate">{track?.artist}</p>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-hidden">
        <div className="w-full max-w-4xl space-y-4">
          {lyrics.slice(Math.max(0, currentLineIndex - 1), currentLineIndex + 4).map((line, i) => {
            const actualIndex = Math.max(0, currentLineIndex - 1) + i;
            const isCurrent = actualIndex === currentLineIndex;
            const progress = isCurrent && line.duration 
              ? Math.min(100, ((currentTime - line.time) / line.duration) * 100) : actualIndex < currentLineIndex ? 100 : 0;
            
            return (
              <div key={actualIndex} className={`singing-bar ${isCurrent ? 'ring-2 ring-primary' : 'opacity-60'}`}>
                <div className="singing-bar-progress" style={{ width: `${progress}%` }} />
                <span className={`relative z-10 text-lg ${isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{line.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="score-panel p-6">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-4 gap-4 mb-4">
            <ScoreItem label="Pitch" value={score.pitch} />
            <ScoreItem label="Rhythm" value={score.rhythm} />
            <ScoreItem label="Diction" value={score.diction} />
            <div className="text-center">
              <p className="text-3xl font-bold text-gradient-gold">{score.total}</p>
              <p className="text-xs text-muted-foreground">Total Score</p>
            </div>
          </div>
          <div className="flex justify-center gap-4">
            <Button variant="outline" size="lg" onClick={toggleMic} className={isMicActive ? 'bg-primary text-primary-foreground' : ''}>
              {isMicActive ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
            </Button>
            <Button size="lg" onClick={togglePlay} className="gradient-primary text-primary-foreground px-8">
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </Button>
          </div>
        </div>
      </div>

      {track?.streamUrl && (
        <audio ref={audioRef} src={track.streamUrl} onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)} onEnded={() => setIsPlaying(false)} />
      )}
    </div>
  );
};

const ScoreItem = ({ label, value }: { label: string; value: number }) => (
  <div className="text-center">
    <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
      <div className="h-full gradient-primary transition-all" style={{ width: `${value}%` }} />
    </div>
    <p className="text-sm font-medium">{Math.round(value)}%</p>
    <p className="text-xs text-muted-foreground">{label}</p>
  </div>
);

export default Sing;
