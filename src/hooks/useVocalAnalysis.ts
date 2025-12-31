import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocalWhisper } from './useLocalWhisper';

interface VocalMetrics {
  pitch: number;           // Current detected pitch in Hz
  pitchAccuracy: number;   // 0-100 accuracy score
  rhythm: number;          // 0-100 rhythm consistency
  diction: number;         // 0-100 clarity score (based on Whisper transcription)
  volume: number;          // Current volume level 0-1
  isVoiceDetected: boolean;
  transcribedText?: string; // Latest transcribed text from Whisper
}

interface UseVocalAnalysisOptions {
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
  targetPitch?: number; // Optional reference pitch to match
  expectedLyrics?: string; // Current lyrics line for comparison
}

export function useVocalAnalysis(options: UseVocalAnalysisOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTranscriptionDisabled, setIsTranscriptionDisabled] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [metrics, setMetrics] = useState<VocalMetrics>({
    pitch: 0,
    pitchAccuracy: 0,
    rhythm: 0,
    diction: 0,
    volume: 0,
    isVoiceDetected: false,
  });

  // Local Whisper hook for browser-based transcription
  const { 
    isModelReady, 
    isModelLoading: whisperLoading, 
    loadProgress,
    loadModel, 
    transcribe, 
    dispose 
  } = useLocalWhisper();

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastDictionScoreRef = useRef<number>(0);
  const transcriptionDisabledRef = useRef(false);
  
  // Tracking for scoring
  const pitchHistoryRef = useRef<number[]>([]);
  const volumeHistoryRef = useRef<number[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);

  // Update loading state from whisper hook
  useEffect(() => {
    setIsModelLoading(whisperLoading);
  }, [whisperLoading]);

  // Calculate similarity between two strings (Levenshtein-based)
  const calculateSimilarity = useCallback((str1: string, str2: string): number => {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const s2 = str2.toLowerCase().replace(/[^\w\s]/g, '').trim();
    
    if (s1 === s2) return 100;
    if (!s1 || !s2) return 0;
    
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    
    let matches = 0;
    for (const word of words1) {
      if (words2.some(w => w.includes(word) || word.includes(w))) {
        matches++;
      }
    }
    
    return Math.round((matches / Math.max(words1.length, 1)) * 100);
  }, []);

  // Transcribe audio using local Whisper model (browser-based)
  const transcribeAudio = useCallback(async () => {
    if (transcriptionDisabledRef.current) return;
    if (!isModelReady) return;
    if (audioChunksRef.current.length === 0) return;

    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    audioChunksRef.current = []; // Clear chunks for next batch

    // Skip if too small (less than 1KB - likely silence)
    if (audioBlob.size < 1000) return;

    try {
      const result = await transcribe(audioBlob);

      if (result?.text) {
        const transcribedText = result.text.trim();

        // Calculate diction score based on similarity to expected lyrics
        let dictionScore = 0;
        if (options.expectedLyrics) {
          dictionScore = calculateSimilarity(transcribedText, options.expectedLyrics);
        } else if (transcribedText.length > 0) {
          // If no expected lyrics, give points for clear speech
          dictionScore = Math.min(80, transcribedText.split(/\s+/).length * 10);
        }

        lastDictionScoreRef.current = dictionScore;

        setMetrics((prev) => ({
          ...prev,
          diction: dictionScore,
          transcribedText,
        }));
      }
    } catch (err) {
      console.error('Failed to transcribe:', err);
    }
  }, [isModelReady, transcribe, options.expectedLyrics, calculateSimilarity]);

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
    
    const frequency = (maxIndex * sampleRate) / (frequencyData.length * 2);
    return frequency;
  }, []);

  const calculateMetrics = useCallback((
    currentPitch: number,
    currentVolume: number,
    now: number
  ): VocalMetrics => {
    const isVoiceDetected = currentVolume > 0.05 && currentPitch > 0;
    
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

    let pitchAccuracy = 0;
    if (pitchHistoryRef.current.length > 5) {
      const recentPitches = pitchHistoryRef.current.slice(-10);
      const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
      const variance = recentPitches.reduce((sum, p) => sum + Math.pow(p - avgPitch, 2), 0) / recentPitches.length;
      const stdDev = Math.sqrt(variance);
      const normalizedVariance = Math.min(stdDev / avgPitch, 0.5);
      pitchAccuracy = Math.max(0, 100 - (normalizedVariance * 200));
    }

    let rhythm = 0;
    if (beatTimesRef.current.length > 3) {
      const intervals: number[] = [];
      for (let i = 1; i < beatTimesRef.current.length; i++) {
        intervals.push(beatTimesRef.current[i] - beatTimesRef.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const intervalVariance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
      const intervalStdDev = Math.sqrt(intervalVariance);
      const rhythmScore = Math.max(0, 100 - (intervalStdDev / avgInterval * 100));
      rhythm = Math.min(100, rhythmScore * 1.2);
    }

    return {
      pitch: currentPitch,
      pitchAccuracy: isVoiceDetected ? pitchAccuracy : metrics.pitchAccuracy,
      rhythm,
      diction: lastDictionScoreRef.current, // Use Whisper-based diction score
      volume: currentVolume,
      isVoiceDetected,
      transcribedText: metrics.transcribedText,
    };
  }, [metrics.pitchAccuracy, metrics.transcribedText]);

  const startAnalysis = useCallback(async () => {
    try {
      setError(null);
      
      // Load Whisper model if not already loaded
      if (!isModelReady) {
        console.log('Loading Whisper model for diction scoring...');
        await loadModel();
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      
      streamRef.current = stream;
      setHasPermission(true);

      // Setup MediaRecorder for Whisper transcription
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      
      mediaRecorder.start(1000); // Collect chunks every 1 second
      
      // Transcribe every 2 seconds (only if model is ready)
      transcriptionIntervalRef.current = setInterval(() => {
        transcribeAudio();
      }, 2000);

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
      console.error('Failed to start vocal analysis:', err);
      setError('Microphone access denied');
      setHasPermission(false);
    }
  }, [detectPitch, calculateMetrics, options, transcribeAudio, isModelReady, loadModel]);

  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    if (transcriptionIntervalRef.current) {
      clearInterval(transcriptionIntervalRef.current);
      transcriptionIntervalRef.current = null;
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
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
    audioChunksRef.current = [];
    setIsActive(false);
    
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
  }, []);

  const resetScores = useCallback(() => {
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
    audioChunksRef.current = [];
    lastDictionScoreRef.current = 0;
    setMetrics({
      pitch: 0,
      pitchAccuracy: 0,
      rhythm: 0,
      diction: 0,
      volume: 0,
      isVoiceDetected: false,
    });
  }, []);

  // Retry transcription - resets disabled state and restarts interval
  const retryTranscription = useCallback(async () => {
    transcriptionDisabledRef.current = false;
    setIsTranscriptionDisabled(false);
    
    // Load model if not ready
    if (!isModelReady) {
      await loadModel();
    }
    
    // Restart transcription interval if analysis is active and recorder exists
    if (isActive && mediaRecorderRef.current && !transcriptionIntervalRef.current) {
      transcriptionIntervalRef.current = setInterval(() => {
        transcribeAudio();
      }, 2000);
    }
  }, [isActive, transcribeAudio, isModelReady, loadModel]);

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
    isTranscriptionDisabled,
    isModelLoading,
    loadProgress,
    isModelReady,
    startAnalysis,
    stopAnalysis,
    resetScores,
    retryTranscription,
  };
}
