import { useEffect, useRef, useState } from 'react';

interface PitchVisualizerProps {
  isActive: boolean;
  onRhythmData?: (data: { beatStrength: number; consistency: number }) => void;
}

export function PitchVisualizer({ isActive, onRhythmData }: PitchVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [volume, setVolume] = useState(0);
  const previousVolumeRef = useRef<number[]>([]);
  const beatCountRef = useRef(0);
  const lastBeatTimeRef = useRef(0);
  const beatIntervalsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!isActive) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      return;
    }

    const setupAudio = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          } 
        });
        
        audioContextRef.current = new AudioContext();
        const source = audioContextRef.current.createMediaStreamSource(stream);
        analyzerRef.current = audioContextRef.current.createAnalyser();
        analyzerRef.current.fftSize = 256;
        analyzerRef.current.smoothingTimeConstant = 0.8;
        source.connect(analyzerRef.current);
        
        visualize();
      } catch (error) {
        console.error('Error accessing microphone:', error);
      }
    };

    const visualize = () => {
      if (!canvasRef.current || !analyzerRef.current) return;
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bufferLength = analyzerRef.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        animationRef.current = requestAnimationFrame(draw);
        analyzerRef.current!.getByteFrequencyData(dataArray);

        // Calculate volume
        const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
        const normalizedVolume = Math.min(average / 128, 1);
        setVolume(normalizedVolume);

        // Beat detection
        previousVolumeRef.current.push(normalizedVolume);
        if (previousVolumeRef.current.length > 10) {
          previousVolumeRef.current.shift();
        }
        
        const avgPrevVolume = previousVolumeRef.current.reduce((a, b) => a + b, 0) / previousVolumeRef.current.length;
        const now = Date.now();
        
        if (normalizedVolume > avgPrevVolume * 1.3 && normalizedVolume > 0.2 && now - lastBeatTimeRef.current > 200) {
          beatCountRef.current++;
          
          if (lastBeatTimeRef.current > 0) {
            const interval = now - lastBeatTimeRef.current;
            beatIntervalsRef.current.push(interval);
            if (beatIntervalsRef.current.length > 20) {
              beatIntervalsRef.current.shift();
            }
          }
          lastBeatTimeRef.current = now;
          
          // Calculate rhythm consistency
          if (beatIntervalsRef.current.length > 5 && onRhythmData) {
            const avgInterval = beatIntervalsRef.current.reduce((a, b) => a + b, 0) / beatIntervalsRef.current.length;
            const variance = beatIntervalsRef.current.reduce((sum, interval) => {
              return sum + Math.pow(interval - avgInterval, 2);
            }, 0) / beatIntervalsRef.current.length;
            const stdDev = Math.sqrt(variance);
            const consistency = Math.max(0, 100 - (stdDev / avgInterval * 100));
            
            onRhythmData({
              beatStrength: normalizedVolume,
              consistency: Math.min(100, consistency),
            });
          }
        }

        // Draw visualization
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height;
          
          // Create gradient
          const gradient = ctx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
          gradient.addColorStop(0, `hsl(250, 95%, ${60 + normalizedVolume * 20}%)`);
          gradient.addColorStop(0.5, `hsl(280, 90%, ${55 + normalizedVolume * 20}%)`);
          gradient.addColorStop(1, `hsl(170, 80%, ${45 + normalizedVolume * 20}%)`);
          
          ctx.fillStyle = gradient;
          
          // Draw with rounded corners
          const radius = barWidth / 2;
          ctx.beginPath();
          ctx.roundRect(x, canvas.height - barHeight, barWidth - 2, barHeight, [radius, radius, 0, 0]);
          ctx.fill();
          
          x += barWidth;
        }
      };

      draw();
    };

    setupAudio();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [isActive, onRhythmData]);

  return (
    <div className="relative w-full h-48 rounded-2xl overflow-hidden bg-card border border-border">
      <canvas
        ref={canvasRef}
        width={800}
        height={200}
        className="w-full h-full"
      />
      
      {/* Volume indicator */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <div className="text-xs text-muted-foreground">Level</div>
        <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
          <div 
            className="h-full gradient-primary transition-all duration-75"
            style={{ width: `${volume * 100}%` }}
          />
        </div>
      </div>
      
      {!isActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80 backdrop-blur-sm">
          <p className="text-muted-foreground">Start singing to see your voice</p>
        </div>
      )}
    </div>
  );
}
