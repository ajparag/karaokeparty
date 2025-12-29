import { useEffect, useRef, useState, memo } from 'react';
import { Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

interface YouTubePlayerProps {
  videoId: string;
  onPlay?: () => void;
  onPause?: () => void;
  onEnd?: () => void;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export const YouTubePlayer = memo(function YouTubePlayer({ videoId, onPlay, onPause, onEnd }: YouTubePlayerProps) {
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState([80]);
  const [isReady, setIsReady] = useState(false);
  
  // Use refs for callbacks to avoid re-creating the player
  const onPlayRef = useRef(onPlay);
  const onPauseRef = useRef(onPause);
  const onEndRef = useRef(onEnd);
  
  useEffect(() => {
    onPlayRef.current = onPlay;
    onPauseRef.current = onPause;
    onEndRef.current = onEnd;
  }, [onPlay, onPause, onEnd]);

  useEffect(() => {
    let player: any = null;
    
    const initPlayer = () => {
      if (containerRef.current && window.YT && window.YT.Player) {
        player = new window.YT.Player(containerRef.current, {
          videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            showinfo: 0,
          },
          events: {
            onReady: () => {
              playerRef.current = player;
              setIsReady(true);
            },
            onStateChange: (event: any) => {
              if (event.data === window.YT.PlayerState.PLAYING) {
                setIsPlaying(true);
                onPlayRef.current?.();
              } else if (event.data === window.YT.PlayerState.PAUSED) {
                setIsPlaying(false);
                onPauseRef.current?.();
              } else if (event.data === window.YT.PlayerState.ENDED) {
                setIsPlaying(false);
                onEndRef.current?.();
              }
            },
          },
        });
      }
    };

    // Load YouTube IFrame API if not already loaded
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
      
      window.onYouTubeIframeAPIReady = initPlayer;
    } else if (window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }

    return () => {
      if (player && player.destroy) {
        player.destroy();
      }
      playerRef.current = null;
    };
  }, [videoId]); // Only re-create player when videoId changes

  const togglePlay = () => {
    if (!playerRef.current) return;
    
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const toggleMute = () => {
    if (!playerRef.current) return;
    
    if (isMuted) {
      playerRef.current.unMute();
      playerRef.current.setVolume(volume[0]);
    } else {
      playerRef.current.mute();
    }
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (value: number[]) => {
    setVolume(value);
    if (playerRef.current && !isMuted) {
      playerRef.current.setVolume(value[0]);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="relative flex-1 rounded-2xl overflow-hidden bg-foreground/5">
        <div ref={containerRef} className="absolute inset-0 [&>iframe]:w-full [&>iframe]:h-full" />
        
        {!isReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-card">
            <div className="animate-pulse text-muted-foreground">Loading video...</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 p-4 bg-card rounded-xl border border-border mt-4 flex-shrink-0">
        <Button
          size="icon"
          variant="ghost"
          onClick={togglePlay}
          disabled={!isReady}
          className="h-12 w-12 rounded-full gradient-primary text-primary-foreground hover:opacity-90"
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
        </Button>

        <div className="flex items-center gap-2 flex-1">
          <Button size="icon" variant="ghost" onClick={toggleMute} disabled={!isReady}>
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Slider
            value={volume}
            onValueChange={handleVolumeChange}
            max={100}
            step={1}
            className="w-32"
            disabled={!isReady}
          />
        </div>
      </div>
    </div>
  );
});
