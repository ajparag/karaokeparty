import { useState, useRef, useCallback, useEffect } from 'react';

const hasDevanagari = (text: string) => /[\u0900-\u097F]/.test(text);

interface VocalMetrics {
  pitch: number;           // Current detected pitch in Hz
  pitchAccuracy: number;   // 0-100 accuracy score
  rhythm: number;          // 0-100 rhythm consistency
  diction: number;         // 0-100 clarity score (based on transcription)
  volume: number;          // Current volume level 0-1
  isVoiceDetected: boolean;
  transcribedText?: string; // Latest transcribed text
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
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
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

  // Audio analysis refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // WebSocket transcription refs
  const wsRef = useRef<WebSocket | null>(null);
  const wsConnectedRef = useRef(false);
  const wsProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const wsSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputSampleRateRef = useRef<number>(48000);

  // Scoring refs
  const lastDictionScoreRef = useRef<number>(0);
  const lastTranscribedTextRef = useRef<string>('');
  const pitchHistoryRef = useRef<number[]>([]);
  const volumeHistoryRef = useRef<number[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  const lastBeatTimeRef = useRef<number>(0);
  const intermediateDictionRef = useRef<number>(0);
  const lastVoiceActivityRef = useRef<number>(0);

  // Calculate similarity between two strings
  const calculateSimilarity = useCallback((str1: string, str2: string): number => {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().replace(/[^\\w\\s\\u0900-\\u097F]/g, '').trim();
    const s2 = str2.toLowerCase().replace(/[^\\w\\s\\u0900-\\u097F]/g, '').trim();
    
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

  // Downsample audio to 16kHz for Speechmatics
  const downsampleBuffer = useCallback((buffer: Float32Array, inputSampleRate: number): Int16Array => {
    const targetSampleRate = 16000;
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = Math.floor(i * ratio);
      const s = Math.max(-1, Math.min(1, buffer[srcIndex]));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return result;
  }, []);

  // Handle transcription updates from WebSocket
  const handleTranscript = useCallback((text: string, isFinal: boolean) => {
    if (!text) return;

    console.log('[ws-transcribe]', isFinal ? 'FINAL:' : 'partial:', text.substring(0, 50));

    lastTranscribedTextRef.current = text;

    let dictionScore = 0;
    if (options.expectedLyrics) {
      dictionScore = calculateSimilarity(text, options.expectedLyrics);
    } else {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      dictionScore = Math.min(85, 40 + wordCount * 8);
    }

    if (isFinal) {
      lastDictionScoreRef.current = dictionScore;
    }

    setMetrics((prev) => ({
      ...prev,
      diction: Math.max(dictionScore, prev.diction * 0.9),
      transcribedText: text,
    }));
  }, [options.expectedLyrics, calculateSimilarity]);

  // Start capturing and sending audio to WebSocket
  const startAudioCapture = useCallback(() => {
    const stream = streamRef.current;
    const audioContext = audioContextRef.current;
    const ws = wsRef.current;

    if (!stream || !audioContext || !ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[audio] Cannot start capture - missing dependencies');
      return;
    }

    console.log('[audio] Starting audio capture for WebSocket');

    const source = audioContext.createMediaStreamSource(stream);
    wsSourceRef.current = source;

    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    wsProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (!wsConnectedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const int16Data = downsampleBuffer(inputData, inputSampleRateRef.current);

      // Send binary audio data
      ws.send(int16Data.buffer);
    };

    source.connect(processor);
    
    // Connect to destination (muted) to keep processor running
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(audioContext.destination);

    console.log('[audio] Audio capture started');
  }, [downsampleBuffer]);

  // Connect to Speechmatics real-time WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current) return;

    console.log('[ws] Connecting to Speechmatics real-time...');
    setIsModelLoading(true);

    const wsUrl = `wss://wnfgqlywaecvbptjvktt.functions.supabase.co/speechmatics-realtime`;
    
    // Set a connection timeout (10 seconds)
    const connectionTimeout = setTimeout(() => {
      if (wsRef.current && !wsConnectedRef.current) {
        console.error('[ws] Connection timeout');
        setTranscriptionError('Connection timeout - tap Retry');
        setIsModelLoading(false);
        setIsTranscriptionDisabled(true);
        wsRef.current.close();
        wsRef.current = null;
      }
    }, 10000);

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ws] WebSocket opened, waiting for recognition...');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'connected') {
            console.log('[ws] Recognition started!');
            clearTimeout(connectionTimeout);
            wsConnectedRef.current = true;
            setIsModelLoading(false);
            setTranscriptionError(null);
            setIsTranscriptionDisabled(false);

            // Start sending audio now that we're connected
            startAudioCapture();
          } else if (data.type === 'partial') {
            handleTranscript(data.text, false);
          } else if (data.type === 'final') {
            handleTranscript(data.text, true);
          } else if (data.type === 'error') {
            console.error('[ws] Error:', data.error);
            setTranscriptionError(data.error);
            setIsTranscriptionDisabled(true);
          } else if (data.type === 'disconnected') {
            wsConnectedRef.current = false;
          }
        } catch (err) {
          console.error('[ws] Parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('[ws] WebSocket error:', err);
        clearTimeout(connectionTimeout);
        setTranscriptionError('Connection failed - tap Retry');
        setIsModelLoading(false);
        setIsTranscriptionDisabled(true);
      };

      ws.onclose = () => {
        console.log('[ws] WebSocket closed');
        clearTimeout(connectionTimeout);
        wsConnectedRef.current = false;
        wsRef.current = null;
        setIsModelLoading(false);
      };
    } catch (err) {
      console.error('[ws] Failed to create WebSocket:', err);
      clearTimeout(connectionTimeout);
      setTranscriptionError('Failed to connect - tap Retry');
      setIsModelLoading(false);
      setIsTranscriptionDisabled(true);
    }
  }, [handleTranscript, startAudioCapture]);

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

  // Calculate vocal metrics
  const calculateMetrics = useCallback((
    currentPitch: number,
    currentVolume: number,
    now: number
  ): VocalMetrics => {
    const isVoiceDetected = currentVolume > 0.05;
    const shouldUpdatePitch = isVoiceDetected && currentPitch > 0;

    if (shouldUpdatePitch) {
      pitchHistoryRef.current.push(currentPitch);
      if (pitchHistoryRef.current.length > 50) {
        pitchHistoryRef.current.shift();
      }
    }
    
    if (isVoiceDetected) {
      lastVoiceActivityRef.current = now;
      if (intermediateDictionRef.current < lastDictionScoreRef.current) {
        intermediateDictionRef.current = lastDictionScoreRef.current;
      } else if (intermediateDictionRef.current < 70) {
        intermediateDictionRef.current = Math.min(70, intermediateDictionRef.current + 0.5);
      }
    } else {
      if (now - lastVoiceActivityRef.current > 500) {
        const target = lastDictionScoreRef.current;
        if (intermediateDictionRef.current > target) {
          intermediateDictionRef.current = Math.max(target, intermediateDictionRef.current - 1);
        }
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

    // Calculate pitch accuracy
    let pitchAccuracy = 0;
    if (pitchHistoryRef.current.length > 5) {
      const recentPitches = pitchHistoryRef.current.slice(-10);
      const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
      const variance = recentPitches.reduce((sum, p) => sum + Math.pow(p - avgPitch, 2), 0) / recentPitches.length;
      const stdDev = Math.sqrt(variance);
      const normalizedVariance = Math.min(stdDev / avgPitch, 0.5);
      pitchAccuracy = Math.max(0, 100 - (normalizedVariance * 200));
    }

    // Calculate rhythm consistency
    let rhythm = 0;
    if (beatTimesRef.current.length > 3) {
      const intervals: number[] = [];
      for (let i = 1; i < beatTimesRef.current.length; i++) {
        intervals.push(beatTimesRef.current[i] - beatTimesRef.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const intervalVariance = intervals.reduce((sum, int) => sum + Math.pow(int - avgInterval, 2), 0) / intervals.length;
      const intervalStdDev = Math.sqrt(intervalVariance);
      const normalizedIntervalVariance = Math.min(intervalStdDev / avgInterval, 0.5);
      rhythm = Math.max(0, 100 - (normalizedIntervalVariance * 200));
    }

    const displayDiction = Math.max(
      lastDictionScoreRef.current,
      Math.round(intermediateDictionRef.current)
    );

    return {
      pitch: currentPitch,
      pitchAccuracy: Math.round(pitchAccuracy),
      rhythm: Math.round(rhythm),
      diction: displayDiction,
      volume: currentVolume,
      isVoiceDetected,
      transcribedText: lastTranscribedTextRef.current,
    };
  }, []);

  // Start vocal analysis
  const startAnalysis = useCallback(async () => {
    try {
      console.log('[analysis] Starting...');
      
      // Reset state
      lastTranscribedTextRef.current = '';
      lastDictionScoreRef.current = 0;
      intermediateDictionRef.current = 0;
      setMetrics((prev) => ({ ...prev, diction: 0, transcribedText: '' }));
      setTranscriptionError(null);

      // Set audio session to playback mode BEFORE requesting microphone
      // This prevents Android from switching to "communication" mode which routes volume to call
      if ('audioSession' in navigator && (navigator as any).audioSession) {
        try {
          (navigator as any).audioSession.type = 'playback';
          console.log('[audio] Set audio session type to playback');
        } catch (e) {
          console.log('[audio] Could not set audio session type:', e);
        }
      }

      // Request microphone with voice processing disabled to avoid triggering communication mode
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Disable voice processing modes that might trigger call audio routing
          // @ts-ignore - experimental property
          voiceIsolation: false,
        },
      });

      streamRef.current = stream;
      setHasPermission(true);

      // Create audio context with playback latency hint to favor media mode
      const audioContext = new AudioContext({ latencyHint: 'playback' });
      audioContextRef.current = audioContext;
      inputSampleRateRef.current = audioContext.sampleRate;
      console.log('[audio] AudioContext created', { sampleRate: audioContext.sampleRate, state: audioContext.state });

      // Resume AudioContext if suspended (required on mobile browsers)
      if (audioContext.state === 'suspended') {
        console.log('[audio] AudioContext suspended, resuming...');
        await audioContext.resume();
        console.log('[audio] AudioContext resumed:', audioContext.state);
      }

      // Set up analyser for pitch/volume
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Connect WebSocket for transcription
      connectWebSocket();

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
      console.error('Failed to start vocal analysis:', err);
      setError('Microphone access denied');
      setHasPermission(false);
    }
  }, [detectPitch, calculateMetrics, options, connectWebSocket]);

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Stop WebSocket audio capture
    if (wsProcessorRef.current) {
      wsProcessorRef.current.disconnect();
      wsProcessorRef.current = null;
    }
    if (wsSourceRef.current) {
      wsSourceRef.current.disconnect();
      wsSourceRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
      } catch {
        // Ignore
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    wsConnectedRef.current = false;

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
    
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
  }, []);

  // Reset scores
  const resetScores = useCallback(() => {
    pitchHistoryRef.current = [];
    volumeHistoryRef.current = [];
    beatTimesRef.current = [];
    lastDictionScoreRef.current = 0;
    lastTranscribedTextRef.current = '';
    intermediateDictionRef.current = 0;
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

  // Retry transcription
  const retryTranscription = useCallback(async () => {
    setIsTranscriptionDisabled(false);
    setTranscriptionError(null);
    lastTranscribedTextRef.current = '';
    setMetrics((prev) => ({ ...prev, transcribedText: '' }));

    // Reconnect WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    wsConnectedRef.current = false;

    if (isActive) {
      connectWebSocket();
    }
  }, [isActive, connectWebSocket]);

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
    isTranscriptionDisabled,
    transcriptionError,
    isModelLoading,
    loadProgress: 100, // No local model to load
    isModelReady: true, // Always ready (using WebSocket)
    startAnalysis,
    stopAnalysis,
    resetScores,
    retryTranscription,
  };
}
