import { useState, useRef, useCallback, useEffect } from 'react';

interface VocalMetrics {
  pitch: number;           // Current detected pitch in Hz
  pitchAccuracy: number;   // 0-100 accuracy score
  rhythm: number;          // 0-100 rhythm consistency
  diction: number;         // 0-100 clarity score (based on volume consistency)
  volume: number;          // Current volume level 0-1
  isVoiceDetected: boolean;
}

interface UseVocalAnalysisOptions {
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
  targetPitch?: number; // Optional reference pitch to match
}

export function useVocalAnalysis(options: UseVocalAnalysisOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalMetrics>({
    pitch: 0,
    pitchAccuracy: 0,
    rhythm: 0,
    diction: 0,
    volume: 0,
    isVoiceDetected: false,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  // Tracking for scoring
  const pitchHistoryRef = useRef<number[]>([]);
  const volumeHistoryRef = useRef<number[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);

  const detectPitch = useCallback((frequencyData: Uint8Array, sampleRate: number): number => {
    // Find dominant frequency using autocorrelation-like approach
    let maxIndex = 0;
    let maxValue = 0;
    
    // Focus on vocal frequency range (80Hz - 1000Hz)
    const minBin = Math.floor(80 / (sampleRate / frequencyData.length));
    const maxBin = Math.floor(1000 / (sampleRate / frequencyData.length));
    
    for (let i = minBin; i < maxBin && i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxIndex = i;
      }
    }
    
    if (maxValue < 100) return 0; // Below noise threshold
    
    // Convert bin index to frequency
    const frequency = (maxIndex * sampleRate) / (frequencyData.length * 2);
    return frequency;
  }, []);

  const calculateMetrics = useCallback((
    currentPitch: number,
    currentVolume: number,
    now: number
  ): VocalMetrics => {
    const isVoiceDetected = currentVolume > 0.05 && currentPitch > 0;
    
    // Update histories
    if (isVoiceDetected) {
      pitchHistoryRef.current.push(currentPitch);
      if (pitchHistoryRef.current.length > 50) {
        pitchHistoryRef.current.shift();
      }
    }
    
    volumeHistoryRef.current.push(currentVolume);
    if (volumeHistoryRef.current.length > 30) {
      volumeHistoryRef.current.shift();
    }

    // Detect beats (volume peaks)
    if (volumeHistoryRef.current.length > 3) {
      const recent = volumeHistoryRef.current.slice(-3);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      if (currentVolume > avg * 1.3 && now - lastBeatTimeRef.current > 200) {
        beatTimesRef.current.push(now);
        lastBeatTimeRef.current = now;
        if (beatTimesRef.current.length > 20) {
          beatTimesRef.current.shift();
        }
      }
    }

    // Calculate pitch accuracy (consistency of pitch)
    let pitchAccuracy = 0;
    if (pitchHistoryRef.current.length > 5) {
      const recentPitches = pitchHistoryRef.current.slice(-10);
      const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
      const variance = recentPitches.reduce((sum, p) => sum + Math.pow(p - avgPitch, 2), 0) / recentPitches.length;
      const stdDev = Math.sqrt(variance);
      // Lower variance = better pitch control
      const normalizedVariance = Math.min(stdDev / avgPitch, 0.5);
      pitchAccuracy = Math.max(0, 100 - (normalizedVariance * 200));
    }

    // Calculate rhythm score (consistency of beat intervals)
    let rhythm = 50; // Default
    if (beatTimesRef.current.length > 3) {
      const intervals: number[] = [];
      for (let i = 1; i < beatTimesRef.current.length; i++) {
        intervals.push(beatTimesRef.current[i] - beatTimesRef.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const intervalVariance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
      const intervalStdDev = Math.sqrt(intervalVariance);
      // More consistent intervals = better rhythm
      const rhythmScore = Math.max(0, 100 - (intervalStdDev / avgInterval * 100));
      rhythm = Math.min(100, rhythmScore * 1.2); // Boost a bit
    }

    // Calculate diction score (based on volume dynamics and clarity)
    let diction = 50;
    if (volumeHistoryRef.current.length > 10) {
      const recentVolumes = volumeHistoryRef.current.slice(-15);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      // Good diction = clear volume changes, not monotone
      const volumeVariance = recentVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / recentVolumes.length;
      // Some variance is good (dynamic singing), too much is chaotic
      const normalizedVariance = Math.sqrt(volumeVariance) / (avgVolume + 0.01);
      if (normalizedVariance > 0.1 && normalizedVariance < 0.8) {
        diction = 70 + (1 - Math.abs(normalizedVariance - 0.4) / 0.4) * 30;
      } else {
        diction = 50 + normalizedVariance * 30;
      }
      diction = Math.min(100, Math.max(0, diction));
    }

    return {
      pitch: currentPitch,
      pitchAccuracy: isVoiceDetected ? pitchAccuracy : metrics.pitchAccuracy,
      rhythm,
      diction: isVoiceDetected ? diction : metrics.diction,
      volume: currentVolume,
      isVoiceDetected,
    };
  }, [metrics.pitchAccuracy, metrics.diction]);

  const startAnalysis = useCallback(async () => {
    try {
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      
      streamRef.current = stream;
      setHasPermission(true);

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.frequencyBinCount);

      const analyze = () => {
        if (!analyserRef.current || !audioContextRef.current) return;

        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(timeData);

        // Calculate volume from time domain data
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const value = (timeData[i] - 128) / 128;
          sum += value * value;
        }
        const volume = Math.sqrt(sum / timeData.length);

        // Detect pitch
        const pitch = detectPitch(frequencyData, audioContext.sampleRate);

        // Calculate all metrics
        const newMetrics = calculateMetrics(pitch, volume, performance.now());
        
        setMetrics(newMetrics);
        options.onMetricsUpdate?.(newMetrics);

        animationFrameRef.current = requestAnimationFrame(analyze);
      };

      setIsActive(true);
      analyze();
    } catch (err) {
      console.error('Failed to start vocal analysis:', err);
      setError('Microphone access denied');
      setHasPermission(false);
    }
  }, [detectPitch, calculateMetrics, options]);

  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    setIsActive(false);
    
    // Reset histories
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
  }, []);

  const resetScores = useCallback(() => {
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
    setMetrics({
      pitch: 0,
      pitchAccuracy: 0,
      rhythm: 0,
      diction: 0,
      volume: 0,
      isVoiceDetected: false,
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAnalysis();
    };
  }, [stopAnalysis]);

  return {
    isActive,
    hasPermission,
    error,
    metrics,
    startAnalysis,
    stopAnalysis,
    resetScores,
  };
}
