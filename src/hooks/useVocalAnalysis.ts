import { useState, useRef, useCallback, useEffect } from 'react';
import { 
  requestMicrophone, 
  createAudioContext, 
  formatMicrophoneError, 
  cleanupAudio 
} from '@/lib/audioPermissions';

interface VocalMetrics {
  pitch: number;           // Current detected pitch in Hz
  pitchAccuracy: number;   // 0-100 accuracy score
  rhythm: number;          // 0-100 rhythm consistency
  technique: number;       // 0-100 technique score (vibrato, glissando)
  deductions: number;      // 0-100 deduction amount (off-key noise, wrong timing)
  volume: number;          // Current volume level 0-1
  isVoiceDetected: boolean;
}

interface UseVocalAnalysisOptions {
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
  targetPitch?: number; // Optional reference pitch to match
  isInstrumentalSection?: boolean; // Flag to detect singing during instrumental breaks
}

export function useVocalAnalysis(options: UseVocalAnalysisOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<VocalMetrics>({
    pitch: 0,
    pitchAccuracy: 0,
    rhythm: 0,
    technique: 0,
    deductions: 0,
    volume: 0,
    isVoiceDetected: false,
  });

  // Audio analysis refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Scoring refs
  const pitchHistoryRef = useRef<number[]>([]);
  const volumeHistoryRef = useRef<number[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);
  const lastVoiceActivityRef = useRef<number>(0);

  // Technique detection refs (vibrato, glissando)
  const vibratoHistoryRef = useRef<number[]>([]); // Track pitch oscillations
  const lastTechniqueScoreRef = useRef<number>(0);
  
  // Deduction tracking refs
  const deductionScoreRef = useRef<number>(0);
  const offKeyCountRef = useRef<number>(0);
  const instrumentalVoiceCountRef = useRef<number>(0);

  // Detect pitch from frequency data
  const detectPitch = useCallback((frequencyData: Uint8Array, sampleRate: number): number => {
    let maxIndex = 0;
    let maxValue = 0;
    
    const minBin = Math.floor(80 / (sampleRate / frequencyData.length));
    const maxBin = Math.floor(1000 / (sampleRate / frequencyData.length));
    
    for (let i = minBin; i < maxBin && i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxIndex = i;
      }
    }
    
    if (maxValue < 100) return 0;
    return (maxIndex * sampleRate) / (frequencyData.length * 2);
  }, []);

  // Calculate vocal metrics with technique and deductions
  const calculateMetrics = useCallback((
    currentPitch: number,
    currentVolume: number,
    now: number
  ): VocalMetrics => {
    // Lower threshold for better device compatibility (was 0.05, now 0.02)
    const isVoiceDetected = currentVolume > 0.02;
    const shouldUpdatePitch = isVoiceDetected && currentPitch > 0;

    if (shouldUpdatePitch) {
      pitchHistoryRef.current.push(currentPitch);
      if (pitchHistoryRef.current.length > 50) {
        pitchHistoryRef.current.shift();
      }
      
      // Track vibrato for technique detection
      vibratoHistoryRef.current.push(currentPitch);
      if (vibratoHistoryRef.current.length > 30) {
        vibratoHistoryRef.current.shift();
      }
    }
    
    if (isVoiceDetected) {
      lastVoiceActivityRef.current = now;
      
      // Minimal deduction for singing during instrumental (barely penalize)
      if (options.isInstrumentalSection) {
        instrumentalVoiceCountRef.current += 1;
        deductionScoreRef.current = Math.min(30, deductionScoreRef.current + 0.1);
      }
    }
    
    volumeHistoryRef.current.push(currentVolume);
    if (volumeHistoryRef.current.length > 30) {
      volumeHistoryRef.current.shift();
    }

    // Beat detection
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

    // Calculate pitch accuracy - HIGH ACHIEVABILITY SCORING
    let pitchAccuracy = 50; // Base score for any voice detected
    if (isVoiceDetected && pitchHistoryRef.current.length > 3) {
      const recentPitches = pitchHistoryRef.current.slice(-15);
      const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
      const variance = recentPitches.reduce((sum, p) => sum + Math.pow(p - avgPitch, 2), 0) / recentPitches.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / avgPitch;
      
      if (cv < 0.05) {
        pitchAccuracy = 95 + (1 - cv / 0.05) * 5; // 95-100 for excellent
      } else if (cv < 0.15) {
        pitchAccuracy = 70 + (1 - (cv - 0.05) / 0.10) * 25; // 70-95 for good
      } else if (cv < 0.30) {
        pitchAccuracy = 50 + (1 - (cv - 0.15) / 0.15) * 20; // 50-70 for average
      }
      
      // Only penalize truly awful off-key singing (>50% variance)
      if (cv > 0.50) {
        offKeyCountRef.current += 1;
        deductionScoreRef.current = Math.min(50, deductionScoreRef.current + 0.1);
      }
    } else if (isVoiceDetected) {
      pitchAccuracy = 65; // Give decent score while building history
    }

    // Calculate rhythm consistency - HIGH ACHIEVABILITY SCORING
    let rhythm = 50; // Base score for voice detected
    if (isVoiceDetected && beatTimesRef.current.length > 2) {
      const intervals: number[] = [];
      for (let i = 1; i < beatTimesRef.current.length; i++) {
        intervals.push(beatTimesRef.current[i] - beatTimesRef.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const intervalVariance = intervals.reduce((sum, int) => sum + Math.pow(int - avgInterval, 2), 0) / intervals.length;
      const intervalStdDev = Math.sqrt(intervalVariance);
      const cv = intervalStdDev / avgInterval;
      
      if (cv < 0.10) {
        rhythm = 90 + (1 - cv / 0.10) * 10; // 90-100 for excellent
      } else if (cv < 0.25) {
        rhythm = 70 + (1 - (cv - 0.10) / 0.15) * 20; // 70-90 for good
      } else if (cv < 0.50) {
        rhythm = 50 + (1 - (cv - 0.25) / 0.25) * 20; // 50-70 for average
      }
    } else if (isVoiceDetected) {
      rhythm = 65; // Give decent score while building history
    }

    // Calculate technique score - HIGH ACHIEVABILITY SCORING
    let technique = 55; // Base score for singing
    if (isVoiceDetected) {
      const pitches = vibratoHistoryRef.current.slice(-20);
      
      // Volume consistency bonus (steady voice control)
      const volumes = volumeHistoryRef.current.slice(-15);
      let volumeBonus = 0;
      if (volumes.length > 5) {
        const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const volVariance = volumes.reduce((sum, v) => sum + Math.pow(v - avgVol, 2), 0) / volumes.length;
        const volCv = Math.sqrt(volVariance) / (avgVol + 0.001);
        // Good volume control = low variance
        if (volCv < 0.3) volumeBonus = 15;
        else if (volCv < 0.5) volumeBonus = 10;
        else volumeBonus = 5;
      }
      
      // Pitch movement bonus (natural singing has pitch variation)
      let expressionBonus = 0;
      if (pitches.length >= 5) {
        const avgPitch = pitches.reduce((a, b) => a + b, 0) / pitches.length;
        const maxPitch = Math.max(...pitches);
        const minPitch = Math.min(...pitches);
        const range = (maxPitch - minPitch) / avgPitch;
        
        // Natural singing has 5-25% pitch range - reward this
        if (range >= 0.03 && range <= 0.30) {
          expressionBonus = 20;
        } else if (range < 0.03) {
          expressionBonus = 10; // Monotone but still singing
        } else {
          expressionBonus = 5; // Wild pitch but trying
        }
      }
      
      // Sustained singing bonus
      const sustainBonus = pitches.length >= 15 ? 10 : pitches.length >= 8 ? 5 : 0;
      
      technique = Math.min(100, technique + volumeBonus + expressionBonus + sustainBonus);
      
      // Smooth the technique score
      lastTechniqueScoreRef.current = lastTechniqueScoreRef.current * 0.6 + technique * 0.4;
      technique = Math.round(lastTechniqueScoreRef.current);
    }

    // Calculate final deduction (capped at 30 to prevent score crushing)
    const deductions = Math.round(Math.min(30, deductionScoreRef.current));
    // Faster decay of deductions to be forgiving
    if (deductionScoreRef.current > 0) {
      deductionScoreRef.current = Math.max(0, deductionScoreRef.current - 0.2);
    }

    return {
      pitch: currentPitch,
      pitchAccuracy: Math.round(pitchAccuracy),
      rhythm: Math.round(rhythm),
      technique,
      deductions,
      volume: currentVolume,
      isVoiceDetected,
    };
  }, [options.isInstrumentalSection]);

  // Start vocal analysis
  const startAnalysis = useCallback(async () => {
    try {
      console.log('[analysis] Starting...');

      // Use centralized microphone and AudioContext initialization
      const stream = await requestMicrophone();
      streamRef.current = stream;
      setHasPermission(true);

      const audioContext = await createAudioContext();
      audioContextRef.current = audioContext;
      console.log('[audio] AudioContext created', { sampleRate: audioContext.sampleRate, state: audioContext.state });

      // Set up analyser for pitch/volume
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Start analysis loop
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.frequencyBinCount);

      const analyze = () => {
        if (!analyserRef.current || !audioContextRef.current) return;

        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(timeData);

        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const value = (timeData[i] - 128) / 128;
          sum += value * value;
        }
        const volume = Math.sqrt(sum / timeData.length);
        const pitch = detectPitch(frequencyData, audioContext.sampleRate);
        const newMetrics = calculateMetrics(pitch, volume, performance.now());
        
        setMetrics(newMetrics);
        options.onMetricsUpdate?.(newMetrics);

        animationFrameRef.current = requestAnimationFrame(analyze);
      };

      setIsActive(true);
      analyze();
    } catch (err) {
      console.error('[audio] Failed to start vocal analysis:', err);
      setError(formatMicrophoneError(err));
      setHasPermission(false);
    }
  }, [detectPitch, calculateMetrics, options]);

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Clean up audio resources using centralized utility
    cleanupAudio(streamRef.current, audioContextRef.current);
    streamRef.current = null;
    audioContextRef.current = null;

    analyserRef.current = null;
    setIsActive(false);
    
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
  }, []);

  // Reset scores
  const resetScores = useCallback(() => {
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
    vibratoHistoryRef.current = [];
    lastTechniqueScoreRef.current = 0;
    deductionScoreRef.current = 0;
    offKeyCountRef.current = 0;
    instrumentalVoiceCountRef.current = 0;
    setMetrics({
      pitch: 0,
      pitchAccuracy: 0,
      rhythm: 0,
      technique: 0,
      deductions: 0,
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
