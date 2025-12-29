import { useEffect, useRef, useState } from 'react';

interface PitchVisualizerProps {
  isActive: boolean;
  onRhythmData?: (data: { beatStrength: number; consistency: number }) => void;
}

export function PitchVisualizer({ isActive, onRhythmData }: PitchVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const beatIntervalsRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    const initAudio = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setHasPermission(true);
        setError(null);

        audioContextRef.current = new AudioContext();
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 2048;
        analyserRef.current.smoothingTimeConstant = 0.8;

        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(analyserRef.current);

        startVisualization();
      } catch (err) {
        console.error('Microphone access denied:', err);
        setError('Microphone access required for scoring');
        setHasPermission(false);
      }
    };

    initAudio();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close();
      }
    };
  }, [isActive]);

  const startVisualization = () => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const frequencyData = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);

      analyser.getByteTimeDomainData(dataArray);
      analyser.getByteFrequencyData(frequencyData);

      // Clear canvas
      ctx.fillStyle = 'hsl(240 10% 5% / 0.3)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw waveform
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'hsl(280 100% 70%)';
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      // Calculate beat/volume detection
      const avgVolume = frequencyData.reduce((a, b) => a + b, 0) / frequencyData.length;
      const normalizedVolume = avgVolume / 255;

      // Detect beats with less strict threshold
      if (normalizedVolume > 0.15) {
        const now = performance.now();
        if (lastBeatTimeRef.current > 0) {
          const interval = now - lastBeatTimeRef.current;
          if (interval > 150 && interval < 2000) {
            beatIntervalsRef.current.push(interval);
            if (beatIntervalsRef.current.length > 20) {
              beatIntervalsRef.current.shift();
            }
          }
        }
        lastBeatTimeRef.current = now;

        // Calculate rhythm consistency with more lenient scoring
        if (beatIntervalsRef.current.length > 3 && onRhythmData) {
          const avgInterval = beatIntervalsRef.current.reduce((a, b) => a + b, 0) / beatIntervalsRef.current.length;
          const variance = beatIntervalsRef.current.reduce((sum, interval) => {
            return sum + Math.pow(interval - avgInterval, 2);
          }, 0) / beatIntervalsRef.current.length;
          const stdDev = Math.sqrt(variance);
          
          // More lenient consistency calculation
          // Lower stdDev/avgInterval ratio = better consistency
          // Using a gentler curve to make scoring easier
          const rawConsistency = Math.max(0, 100 - (stdDev / avgInterval * 50));
          const consistency = Math.min(100, rawConsistency * 1.2); // Boost scores
          
          onRhythmData({
            beatStrength: normalizedVolume,
            consistency: consistency,
          });
        }
      }

      // Draw frequency bars
      const barWidth = (canvas.width / bufferLength) * 4;
      let barX = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (frequencyData[i] / 255) * canvas.height * 0.5;
        
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
        gradient.addColorStop(0, 'hsl(280 100% 70% / 0.5)');
        gradient.addColorStop(1, 'hsl(320 100% 60% / 0.3)');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(barX, canvas.height - barHeight, barWidth - 1, barHeight);
        
        barX += barWidth;
        if (barX >= canvas.width) break;
      }
    };

    draw();
  };

  if (error) {
    return (
      <div className="w-full h-32 bg-card/50 rounded-lg flex items-center justify-center border border-border">
        <p className="text-muted-foreground text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <canvas
        ref={canvasRef}
        width={800}
        height={150}
        className="w-full h-32 rounded-lg border border-border bg-card/30"
      />
      {!hasPermission && isActive && (
        <p className="text-muted-foreground text-xs mt-2 text-center">
          Requesting microphone access...
        </p>
      )}
    </div>
  );
}
