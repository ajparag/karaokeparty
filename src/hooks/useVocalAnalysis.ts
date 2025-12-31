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
    transcribedText: '',
  });

  // Local Whisper hook for browser-based transcription
  const { 
    isModelReady, 
    isModelLoading: whisperLoading, 
    loadProgress,
    loadModel, 
    transcribe, 
    dispose,
    checkModelReady,
  } = useLocalWhisper();

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const transcriptionIntervalRef = useRef<number | null>(null);
  const lastDictionScoreRef = useRef<number>(0);
  const lastTranscribedTextRef = useRef<string>('');
  const transcriptionInFlightRef = useRef(false);
  const transcriptionDisabledRef = useRef(false);

  // Raw PCM capture for Whisper (avoids webm decode issues)
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const inputSampleRateRef = useRef<number>(0);

  // Debug counters (helps trace why transcription text might not appear)
  const debugRef = useRef({
    audioProcessCalls: 0,
    lastAudioProcessLogAt: 0,
    transcriptionTicks: 0,
  });
  
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

  const downsampleTo16k = useCallback((input: Float32Array, sampleRate: number) => {
    if (sampleRate === 16000) return input;
    const ratio = sampleRate / 16000;
    const newLength = Math.floor(input.length / ratio);
    const output = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      output[i] = input[Math.floor(i * ratio)];
    }
    return output;
  }, []);

  // Transcribe audio using local Whisper model (browser-based)
  const transcribeAudio = useCallback(async () => {
    debugRef.current.transcriptionTicks += 1;

    if (transcriptionDisabledRef.current) {
      console.log('[whisper] skip: transcriptionDisabledRef=true');
      return;
    }
    if (transcriptionInFlightRef.current) {
      console.log('[whisper] skip: transcription already in flight');
      return;
    }
    if (!checkModelReady()) {
      console.log('[whisper] skip: model not ready (ref check)');
      return;
    }
    if (pcmChunksRef.current.length === 0) {
      console.log('[whisper] skip: no pcm chunks');
      return;
    }

    transcriptionInFlightRef.current = true;

    try {
      const sampleRate = inputSampleRateRef.current || 48000;
      const mergedLength = pcmChunksRef.current.reduce((sum, c) => sum + c.length, 0);

      console.log('[whisper] tick', debugRef.current.transcriptionTicks, {
        pcmChunks: pcmChunksRef.current.length,
        mergedLength,
        sampleRate,
      });

      // Need ~0.75s minimum audio to be meaningful
      if (mergedLength < sampleRate * 0.75) {
        console.log('[whisper] skip: not enough audio yet', {
          mergedLength,
          minNeeded: Math.floor(sampleRate * 0.75),
        });
        return;
      }

      const merged = new Float32Array(mergedLength);
      let offset = 0;
      for (const chunk of pcmChunksRef.current) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      pcmChunksRef.current = [];

      const audio16k = downsampleTo16k(merged, sampleRate);
      console.log('[whisper] prepared audio', {
        inSamples: merged.length,
        outSamples: audio16k.length,
        inSampleRate: sampleRate,
        outSampleRate: 16000,
      });

      console.log('[whisper] calling model...');
      const result = await transcribe(audio16k);
      const transcribedText = result?.text?.trim() || '';
      console.log('[whisper] result', { text: transcribedText });

      // Keep the last text around so the UI reliably shows something once we get any output.
      if (transcribedText) {
        lastTranscribedTextRef.current = transcribedText;
      }

      if (!transcribedText) return;

      let dictionScore = 0;
      if (options.expectedLyrics) {
        dictionScore = calculateSimilarity(transcribedText, options.expectedLyrics);
        console.log('[whisper] similarity-based diction', {
          expected: options.expectedLyrics,
          dictionScore,
        });
      } else {
        const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
        dictionScore = Math.min(85, 40 + wordCount * 8);
        console.log('[whisper] wordcount-based diction', { wordCount, dictionScore });
      }

      lastDictionScoreRef.current = dictionScore;

      setMetrics((prev) => ({
        ...prev,
        diction: dictionScore,
        transcribedText: lastTranscribedTextRef.current,
      }));
    } catch (err) {
      console.error('[whisper] transcribe failed:', err);
    } finally {
      transcriptionInFlightRef.current = false;
    }
  }, [checkModelReady, transcribe, options.expectedLyrics, calculateSimilarity, downsampleTo16k]);

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
      transcribedText: lastTranscribedTextRef.current,
    };
  }, [metrics.pitchAccuracy, metrics.transcribedText]);

  const startAnalysis = useCallback(async () => {
    try {
      setError(null);
      
      // Load Whisper model if not already loaded
      if (!isModelReady) {
        console.log('[whisper] loadModel(): starting (diction scoring)');
        await loadModel();
        console.log('[whisper] loadModel(): done', { isModelReady: true });
      } else {
        console.log('[whisper] model already ready');
      }
      
      console.log('[mic] requesting getUserMedia...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      console.log('[mic] getUserMedia ok', {
        tracks: stream.getAudioTracks().length,
      });

      streamRef.current = stream;
      setHasPermission(true);

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      inputSampleRateRef.current = audioContext.sampleRate;
      console.log('[audio] AudioContext created', { sampleRate: audioContext.sampleRate });

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Capture raw PCM for Whisper (more reliable than MediaRecorder/webm decoding)
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        debugRef.current.audioProcessCalls += 1;

        const input = e.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(input));

        // Throttled logging (every ~3s)
        const now = performance.now();
        if (now - debugRef.current.lastAudioProcessLogAt > 3000) {
          debugRef.current.lastAudioProcessLogAt = now;
          const totalSamples = pcmChunksRef.current.reduce((sum, c) => sum + c.length, 0);
          console.log('[audio] onaudioprocess', {
            calls: debugRef.current.audioProcessCalls,
            chunkSamples: input.length,
            bufferedChunks: pcmChunksRef.current.length,
            bufferedSamples: totalSamples,
            sampleRate: inputSampleRateRef.current || audioContext.sampleRate,
          });
        }

        // Bound memory: keep up to ~30 seconds
        const maxSamples = (inputSampleRateRef.current || audioContext.sampleRate) * 30;
        let total = pcmChunksRef.current.reduce((sum, c) => sum + c.length, 0);
        while (total > maxSamples && pcmChunksRef.current.length > 1) {
          total -= pcmChunksRef.current[0].length;
          pcmChunksRef.current.shift();
        }
      };

      source.connect(processor);
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(audioContext.destination);

      // Transcribe every 1 second
      console.log('[whisper] scheduling transcription interval (1s)');
      transcriptionIntervalRef.current = window.setInterval(() => {
        console.log('[whisper] interval tick');
        transcribeAudio();
      }, 1000);

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
      window.clearInterval(transcriptionIntervalRef.current);
      transcriptionIntervalRef.current = null;
    }

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // ignore
      }
      processorRef.current.onaudioprocess = null as any;
      processorRef.current = null;
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
    pcmChunksRef.current = [];
    setIsActive(false);
    
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
  }, []);

  const resetScores = useCallback(() => {
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
    pcmChunksRef.current = [];
    lastDictionScoreRef.current = 0;
    lastTranscribedTextRef.current = '';
    setMetrics({
      pitch: 0,
      pitchAccuracy: 0,
      rhythm: 0,
      diction: 0,
      volume: 0,
      isVoiceDetected: false,
      transcribedText: '',
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
    
    if (isActive && !transcriptionIntervalRef.current) {
      transcriptionIntervalRef.current = window.setInterval(() => {
        transcribeAudio();
      }, 1000);
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
