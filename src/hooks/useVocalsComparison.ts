import { useState, useRef, useCallback, useEffect } from 'react';

interface VocalsComparisonMetrics {
  pitchMatch: number;      // 0-100 how close user pitch is to vocals pitch
  rhythmMatch: number;     // 0-100 how close user rhythm is to vocals rhythm  
  techniqueMatch: number;  // 0-100 how close user technique is to vocals
  volume: number;          // Current user volume level 0-1
  isVoiceDetected: boolean;
  referenceActive: boolean; // Whether the reference vocals are currently active
}

interface UseVocalsComparisonOptions {
  vocalsUrl?: string;
  currentTime?: number;
  isPlaying?: boolean;
  onMetricsUpdate?: (metrics: VocalsComparisonMetrics) => void;
}

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0,
    rhythmMatch: 0,
    techniqueMatch: 0,
    volume: 0,
    isVoiceDetected: false,
    referenceActive: false,
  });

  // User mic analysis refs
  const userAudioContextRef = useRef<AudioContext | null>(null);
  const userAnalyserRef = useRef<AnalyserNode | null>(null);
  const userStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Reference vocals analysis refs  
  const vocalsAudioContextRef = useRef<AudioContext | null>(null);
  const vocalsAnalyserRef = useRef<AnalyserNode | null>(null);
  const vocalsSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const vocalsAudioRef = useRef<HTMLAudioElement | null>(null);

  // History refs for comparison
  const userPitchHistoryRef = useRef<number[]>([]);
  const vocalsPitchHistoryRef = useRef<number[]>([]);
  const userVolumeHistoryRef = useRef<number[]>([]);
  const vocalsVolumeHistoryRef = useRef<number[]>([]);
  const userBeatTimesRef = useRef<number[]>([]);
  const vocalsBeatTimesRef = useRef<number[]>([]);
  const lastUserBeatRef = useRef<number>(0);
  const lastVocalsBeatRef = useRef<number>(0);

  // Detect pitch from frequency data
  const detectPitch = useCallback((frequencyData: Uint8Array, sampleRate: number): number => {
    let maxIndex = 0;
    let maxValue = 0;
    
    // Vocal range: 80Hz - 1000Hz
    const minBin = Math.floor(80 / (sampleRate / frequencyData.length));
    const maxBin = Math.floor(1000 / (sampleRate / frequencyData.length));
    
    for (let i = minBin; i < maxBin && i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxIndex = i;
      }
    }
    
    if (maxValue < 80) return 0; // Lowered threshold for vocals track
    return (maxIndex * sampleRate) / (frequencyData.length * 2);
  }, []);

  // Calculate volume from time domain data
  const calculateVolume = useCallback((timeData: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const value = (timeData[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / timeData.length);
  }, []);

  // Generous pitch comparison - rewards singing with higher base scores
  const comparePitch = useCallback((userPitch: number, vocalsPitch: number): number => {
    if (userPitch === 0 || vocalsPitch === 0) return 70; // Higher base score when no detection
    
    // Calculate pitch ratio (how close they are)
    const ratio = Math.min(userPitch, vocalsPitch) / Math.max(userPitch, vocalsPitch);
    
    // More generous scoring:
    // - Within 5% (ratio > 0.95) = 95-100 points
    // - Within 15% (ratio > 0.85) = 85-95 points
    // - Within 25% (ratio > 0.75) = 75-85 points  
    // - Within 40% (ratio > 0.60) = 65-75 points
    // - Beyond that = 55-65 points
    if (ratio > 0.95) {
      return 95 + (ratio - 0.95) * 100; // 95-100
    } else if (ratio > 0.85) {
      return 85 + (ratio - 0.85) * 100; // 85-95
    } else if (ratio > 0.75) {
      return 75 + (ratio - 0.75) * 100; // 75-85
    } else if (ratio > 0.60) {
      return 65 + (ratio - 0.60) * 67; // 65-75
    } else {
      return 55 + ratio * 17; // 55-65
    }
  }, []);

  // Generous rhythm comparison - higher base and rewards any rhythmic activity
  const compareRhythm = useCallback((userBeats: number[], vocalsBeats: number[]): number => {
    if (userBeats.length < 2 || vocalsBeats.length < 2) return 75; // Higher base score
    
    // Calculate average beat intervals
    const getUserAvgInterval = () => {
      const intervals: number[] = [];
      for (let i = 1; i < userBeats.length; i++) {
        intervals.push(userBeats[i] - userBeats[i - 1]);
      }
      return intervals.reduce((a, b) => a + b, 0) / intervals.length;
    };
    
    const getVocalsAvgInterval = () => {
      const intervals: number[] = [];
      for (let i = 1; i < vocalsBeats.length; i++) {
        intervals.push(vocalsBeats[i] - vocalsBeats[i - 1]);
      }
      return intervals.reduce((a, b) => a + b, 0) / intervals.length;
    };
    
    const userInterval = getUserAvgInterval();
    const vocalsInterval = getVocalsAvgInterval();
    
    if (userInterval === 0 || vocalsInterval === 0) return 75;
    
    // Compare intervals (generous)
    const ratio = Math.min(userInterval, vocalsInterval) / Math.max(userInterval, vocalsInterval);
    
    // Allow for half-time and double-time (singing at 0.5x or 2x speed is okay)
    const adjustedRatio = Math.max(ratio, ratio * 2 > 1 ? 2 - ratio * 2 : ratio * 2);
    
    // More generous scoring tiers
    if (adjustedRatio > 0.80) {
      return 90 + (adjustedRatio - 0.80) * 50; // 90-100
    } else if (adjustedRatio > 0.65) {
      return 80 + (adjustedRatio - 0.65) * 67; // 80-90  
    } else if (adjustedRatio > 0.45) {
      return 70 + (adjustedRatio - 0.45) * 50; // 70-80
    }
    return 65 + adjustedRatio * 11; // 65-70
  }, []);

  // Generous technique comparison (volume dynamics and pitch stability)
  const compareTechnique = useCallback((
    userVolumes: number[],
    vocalsVolumes: number[],
    userPitches: number[],
    vocalsPitches: number[]
  ): number => {
    let score = 75; // Higher base score for singing
    
    // Volume dynamics comparison - more generous rewards
    if (userVolumes.length > 5 && vocalsVolumes.length > 5) {
      const userVolRange = Math.max(...userVolumes) - Math.min(...userVolumes);
      const vocalsVolRange = Math.max(...vocalsVolumes) - Math.min(...vocalsVolumes);
      
      if (vocalsVolRange > 0.05) {
        // If vocals have dynamics, reward user for having similar dynamics
        const dynamicsRatio = Math.min(userVolRange, vocalsVolRange) / Math.max(userVolRange, vocalsVolRange);
        score += dynamicsRatio > 0.4 ? 12 : dynamicsRatio > 0.2 ? 10 : 8;
      } else {
        // Vocals are steady, reward user for any dynamics (expression)
        score += userVolRange > 0.08 ? 12 : userVolRange > 0.04 ? 10 : 8;
      }
    } else {
      score += 5; // Small bonus even without enough data
    }
    
    // Pitch stability comparison - more generous rewards
    if (userPitches.length > 5 && vocalsPitches.length > 5) {
      const calcCV = (arr: number[]) => {
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        if (avg === 0) return 1;
        const variance = arr.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / arr.length;
        return Math.sqrt(variance) / avg;
      };
      
      const userCV = calcCV(userPitches);
      const vocalsCV = calcCV(vocalsPitches);
      
      // Compare coefficient of variation (similar stability = good) - more generous
      const cvDiff = Math.abs(userCV - vocalsCV);
      if (cvDiff < 0.15) {
        score += 13; // Very similar stability
      } else if (cvDiff < 0.25) {
        score += 11;
      } else if (cvDiff < 0.40) {
        score += 9;
      } else {
        score += 7;
      }
    } else {
      score += 5; // Small bonus even without enough data
    }
    
    return Math.min(100, score);
  }, []);

  // Initialize vocals audio analysis
  const initVocalsAnalysis = useCallback(async () => {
    if (!options.vocalsUrl) return;
    
    try {
      // Create audio element for vocals
      const vocalsAudio = new Audio();
      vocalsAudio.crossOrigin = "anonymous";
      vocalsAudio.src = options.vocalsUrl;
      vocalsAudio.volume = 0; // Muted - just for analysis
      vocalsAudio.preload = "auto";
      vocalsAudioRef.current = vocalsAudio;
      
      // Create audio context for analysis
      const audioContext = new AudioContext();
      vocalsAudioContextRef.current = audioContext;
      
      // Wait for audio to be ready
      await new Promise<void>((resolve, reject) => {
        vocalsAudio.oncanplaythrough = () => resolve();
        vocalsAudio.onerror = () => reject(new Error('Failed to load vocals'));
        setTimeout(() => resolve(), 3000); // Timeout fallback
      });
      
      // Create analyzer
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      vocalsAnalyserRef.current = analyser;
      
      // Connect audio element to analyzer
      const source = audioContext.createMediaElementSource(vocalsAudio);
      source.connect(analyser);
      // Don't connect to destination (keep muted)
      vocalsSourceRef.current = source;
      
      console.log('[vocals-comparison] Vocals analysis initialized');
    } catch (err) {
      console.error('[vocals-comparison] Failed to init vocals analysis:', err);
    }
  }, [options.vocalsUrl]);

  // Sync vocals audio with main playback
  useEffect(() => {
    const vocalsAudio = vocalsAudioRef.current;
    if (!vocalsAudio) return;
    
    if (options.isPlaying) {
      vocalsAudio.currentTime = options.currentTime || 0;
      vocalsAudio.play().catch(() => {});
    } else {
      vocalsAudio.pause();
    }
  }, [options.isPlaying, options.currentTime]);

  // Start analysis
  const startAnalysis = useCallback(async () => {
    console.log('[vocals-comparison] startAnalysis called');
    
    try {
      // Request microphone
      console.log('[vocals-comparison] Requesting microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      console.log('[vocals-comparison] Microphone access granted');
      userStreamRef.current = stream;
      setHasPermission(true);
      
      // Create audio context for user mic
      console.log('[vocals-comparison] Creating AudioContext...');
      const audioContext = new AudioContext();
      console.log('[vocals-comparison] AudioContext created, state:', audioContext.state);
      userAudioContextRef.current = audioContext;
      
      // Create analyzer for user mic
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      userAnalyserRef.current = analyser;
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      // Initialize vocals analysis
      await initVocalsAnalysis();
      
      // Start analysis loop
      const userFrequencyData = new Uint8Array(analyser.frequencyBinCount);
      const userTimeData = new Uint8Array(analyser.fftSize);
      
      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioContextRef.current) return;
        
        // Get user audio data
        userAnalyserRef.current.getByteFrequencyData(userFrequencyData);
        userAnalyserRef.current.getByteTimeDomainData(userTimeData);
        
        const userVolume = calculateVolume(userTimeData);
        const userPitch = detectPitch(userFrequencyData, userAudioContextRef.current.sampleRate);
        const isVoiceDetected = userVolume > 0.02;
        
        // Update user histories
        if (isVoiceDetected) {
          if (userPitch > 0) {
            userPitchHistoryRef.current.push(userPitch);
            if (userPitchHistoryRef.current.length > 50) userPitchHistoryRef.current.shift();
          }
          userVolumeHistoryRef.current.push(userVolume);
          if (userVolumeHistoryRef.current.length > 30) userVolumeHistoryRef.current.shift();
          
          // Beat detection for user
          const now = performance.now();
          if (userVolumeHistoryRef.current.length > 3) {
            const recent = userVolumeHistoryRef.current.slice(-3);
            const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
            if (userVolume > avg * 1.3 && now - lastUserBeatRef.current > 200) {
              userBeatTimesRef.current.push(now);
              lastUserBeatRef.current = now;
              if (userBeatTimesRef.current.length > 20) userBeatTimesRef.current.shift();
            }
          }
        }
        
        // Get vocals audio data if available
        let vocalsPitch = 0;
        let vocalsVolume = 0;
        let referenceActive = false;
        
        if (vocalsAnalyserRef.current && vocalsAudioContextRef.current) {
          const vocalsFreqData = new Uint8Array(vocalsAnalyserRef.current.frequencyBinCount);
          const vocalsTimeData = new Uint8Array(vocalsAnalyserRef.current.fftSize);
          
          vocalsAnalyserRef.current.getByteFrequencyData(vocalsFreqData);
          vocalsAnalyserRef.current.getByteTimeDomainData(vocalsTimeData);
          
          vocalsVolume = calculateVolume(vocalsTimeData);
          vocalsPitch = detectPitch(vocalsFreqData, vocalsAudioContextRef.current.sampleRate);
          referenceActive = vocalsVolume > 0.01;
          
          // Update vocals histories
          if (referenceActive) {
            if (vocalsPitch > 0) {
              vocalsPitchHistoryRef.current.push(vocalsPitch);
              if (vocalsPitchHistoryRef.current.length > 50) vocalsPitchHistoryRef.current.shift();
            }
            vocalsVolumeHistoryRef.current.push(vocalsVolume);
            if (vocalsVolumeHistoryRef.current.length > 30) vocalsVolumeHistoryRef.current.shift();
            
            // Beat detection for vocals
            const now = performance.now();
            if (vocalsVolumeHistoryRef.current.length > 3) {
              const recent = vocalsVolumeHistoryRef.current.slice(-3);
              const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
              if (vocalsVolume > avg * 1.3 && now - lastVocalsBeatRef.current > 200) {
                vocalsBeatTimesRef.current.push(now);
                lastVocalsBeatRef.current = now;
                if (vocalsBeatTimesRef.current.length > 20) vocalsBeatTimesRef.current.shift();
              }
            }
          }
        }
        
        // Only update scores when reference vocals are active (not instrumental section)
        // During instrumental sections, keep the previous scores unchanged
        setMetrics(prevMetrics => {
          let pitchMatch = prevMetrics.pitchMatch;
          let rhythmMatch = prevMetrics.rhythmMatch;
          let techniqueMatch = prevMetrics.techniqueMatch;
          
          // Only update scores when vocals are present in the reference track
          if (referenceActive) {
            if (isVoiceDetected) {
              // User is singing - compare with reference vocals
              pitchMatch = comparePitch(userPitch, vocalsPitch);
              rhythmMatch = compareRhythm(userBeatTimesRef.current, vocalsBeatTimesRef.current);
              techniqueMatch = compareTechnique(
                userVolumeHistoryRef.current,
                vocalsVolumeHistoryRef.current,
                userPitchHistoryRef.current,
                vocalsPitchHistoryRef.current
              );
            } else {
              // User is silent during vocal section - gentle penalty
              // Mild decay to indicate missed vocals without being too harsh
              pitchMatch = Math.max(30, prevMetrics.pitchMatch * 0.95 - 2);
              rhythmMatch = Math.max(30, prevMetrics.rhythmMatch * 0.95 - 2);
              techniqueMatch = Math.max(30, prevMetrics.techniqueMatch * 0.95 - 2);
            }
          }
          
          const newMetrics: VocalsComparisonMetrics = {
            pitchMatch,
            rhythmMatch,
            techniqueMatch,
            volume: userVolume,
            isVoiceDetected,
            referenceActive,
          };
          
          options.onMetricsUpdate?.(newMetrics);
          return newMetrics;
        });
        
        animationFrameRef.current = requestAnimationFrame(analyze);
      };
      
      setIsActive(true);
      analyze();
      console.log('[vocals-comparison] Analysis started');
      
    } catch (err) {
      console.error('[vocals-comparison] Error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
    }
  }, [initVocalsAnalysis, detectPitch, calculateVolume, comparePitch, compareRhythm, compareTechnique, options]);

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    if (userStreamRef.current) {
      userStreamRef.current.getTracks().forEach(track => track.stop());
      userStreamRef.current = null;
    }
    
    if (userAudioContextRef.current) {
      userAudioContextRef.current.close();
      userAudioContextRef.current = null;
    }
    
    if (vocalsAudioRef.current) {
      vocalsAudioRef.current.pause();
      vocalsAudioRef.current = null;
    }
    
    if (vocalsAudioContextRef.current) {
      vocalsAudioContextRef.current.close();
      vocalsAudioContextRef.current = null;
    }
    
    setIsActive(false);
    console.log('[vocals-comparison] Analysis stopped');
  }, []);

  // Reset scores
  const resetScores = useCallback(() => {
    userPitchHistoryRef.current = [];
    vocalsPitchHistoryRef.current = [];
    userVolumeHistoryRef.current = [];
    vocalsVolumeHistoryRef.current = [];
    userBeatTimesRef.current = [];
    vocalsBeatTimesRef.current = [];
    
    setMetrics({
      pitchMatch: 0,
      rhythmMatch: 0,
      techniqueMatch: 0,
      volume: 0,
      isVoiceDetected: false,
      referenceActive: false,
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
