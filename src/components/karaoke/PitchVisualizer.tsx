import { useEffect, useRef, useState } from 'react';

interface PitchVisualizerProps {
  isActive: boolean;
  onRhythmData?: (data: { beatStrength: number; consistency: number; pitchAccuracy: number }) => void;
  compact?: boolean;
}

export function PitchVisualizer({ isActive, onRhythmData, compact = false }: PitchVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const beatIntervalsRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);
  const pitchHistoryRef = useRef<number[]>([]);
  const lastConsistencyRef = useRef<number>(50);
  const lastReportTimeRef = useRef<number>(0);
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
        // Set audio session to playback mode for iOS (prevents call audio routing)
        if ('audioSession' in navigator && (navigator as any).audioSession) {
          try {
            (navigator as any).audioSession.type = 'playback';
            console.log('[PitchVisualizer] Set audio session type to playback');
          } catch (e) {
            console.log('[PitchVisualizer] Could not set audio session type:', e);
          }
        }

        // Request microphone with Apple-friendly constraints
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // @ts-ignore - experimental property for Safari
            voiceIsolation: false,
          } 
        });
        setHasPermission(true);
        setError(null);

        // Use webkitAudioContext fallback for older Safari versions
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) {
          throw new Error('AudioContext not supported');
        }
        
        audioContextRef.current = new AudioContextClass({ latencyHint: 'playback' });
        
        // Resume AudioContext if suspended (required on iOS Safari)
        if (audioContextRef.current.state === 'suspended') {
          console.log('[PitchVisualizer] AudioContext suspended, resuming...');
          await audioContextRef.current.resume();
          console.log('[PitchVisualizer] AudioContext resumed:', audioContextRef.current.state);
        }
        
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 2048;
        analyserRef.current.smoothingTimeConstant = 0.8;

        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(analyserRef.current);

        startVisualization();
      } catch (err) {
        console.error('[PitchVisualizer] Microphone access denied:', err);
        const errorMessage = err instanceof Error ? err.message : 'Microphone access required';
        // Provide more helpful error for Safari/iOS users
        if (errorMessage.includes('not allowed') || errorMessage.includes('Permission denied')) {
          setError('Microphone blocked. Check Settings > Safari > Microphone');
        } else {
          setError('Microphone access required for scoring');
        }
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

  const detectPitch = (frequencyData: Uint8Array, sampleRate: number): number => {
    // Find the dominant frequency
    let maxIndex = 0;
    let maxValue = 0;
    
    // Focus on typical vocal range (80Hz - 1000Hz)
    const minBin = Math.floor(80 / (sampleRate / 2048));
    const maxBin = Math.floor(1000 / (sampleRate / 2048));
    
    for (let i = minBin; i < maxBin && i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxIndex = i;
      }
    }
    
    // Convert bin index to frequency
    const frequency = (maxIndex * sampleRate) / 2048;
    return frequency;
  };

  const calculatePitchAccuracy = (pitchHistory: number[]): number => {
    if (pitchHistory.length < 5) return 50;
    
    // Calculate pitch stability - how consistent the pitch is
    const recentPitches = pitchHistory.slice(-20);
    const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
    
    if (avgPitch < 50) return 50; // Too quiet
    
    const variance = recentPitches.reduce((sum, pitch) => {
      return sum + Math.pow(pitch - avgPitch, 2);
    }, 0) / recentPitches.length;
    
    const stdDev = Math.sqrt(variance);
    
    // Lower variance = better pitch control
    // Using a curve that makes it easier to get good scores
    const rawAccuracy = Math.max(0, 100 - (stdDev / avgPitch * 100));
    const accuracy = Math.min(100, rawAccuracy * 1.3 + 20); // Boost and floor
    
    return accuracy;
  };

  const startVisualization = () => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!canvas || !analyser || !audioContext) return;

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

      // Detect pitch
      const pitch = detectPitch(frequencyData, audioContext.sampleRate);
      if (pitch > 50 && normalizedVolume > 0.1) {
        pitchHistoryRef.current.push(pitch);
        if (pitchHistoryRef.current.length > 50) {
          pitchHistoryRef.current.shift();
        }
      }

      // Calculate pitch accuracy
      const pitchAccuracy = calculatePitchAccuracy(pitchHistoryRef.current);

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
        if (beatIntervalsRef.current.length > 3) {
          const avgInterval = beatIntervalsRef.current.reduce((a, b) => a + b, 0) / beatIntervalsRef.current.length;
          const variance = beatIntervalsRef.current.reduce((sum, interval) => {
            return sum + Math.pow(interval - avgInterval, 2);
          }, 0) / beatIntervalsRef.current.length;
          const stdDev = Math.sqrt(variance);
          
          // More lenient consistency calculation
          const rawConsistency = Math.max(0, 100 - (stdDev / avgInterval * 50));
          const consistency = Math.min(100, rawConsistency * 1.2); // Boost scores
          lastConsistencyRef.current = consistency;
        }
      }

      // Report data regularly (even if no beats detected)
      if (onRhythmData) {
        const now = performance.now();
        if (now - lastReportTimeRef.current > 300) {
          lastReportTimeRef.current = now;
          onRhythmData({
            beatStrength: normalizedVolume,
            consistency: lastConsistencyRef.current,
            pitchAccuracy,
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
      <div className={`w-full ${compact ? 'h-16' : 'h-32'} bg-card/50 rounded-lg flex items-center justify-center border border-border`}>
        <p className="text-muted-foreground text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <canvas
        ref={canvasRef}
        width={800}
        height={compact ? 80 : 150}
        className={`w-full ${compact ? 'h-16' : 'h-32'} rounded-lg border border-border bg-card/30`}
      />
      {!hasPermission && isActive && (
        <p className="text-muted-foreground text-xs mt-2 text-center">
          Requesting microphone access...
        </p>
      )}
    </div>
  );
}
