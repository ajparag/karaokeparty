import { useState, useRef, useCallback, useEffect } from 'react';
import { 
  requestMicrophone, 
  createAudioContext, 
  formatMicrophoneError, 
  cleanupAudio 
} from '@/lib/audioPermissions';

const hasDevanagari = (text: string) => /[\u0900-\u097F]/.test(text);

interface VocalMetrics {
  pitch: number;           // Current detected pitch in Hz
  pitchAccuracy: number;   // 0-100 accuracy score
  rhythm: number;          // 0-100 rhythm consistency
  diction: number;         // 0-100 clarity score (based on transcription)
  technique: number;       // 0-100 technique score (vibrato, glissando)
  deductions: number;      // 0-100 deduction amount (off-key noise, wrong timing)
  volume: number;          // Current volume level 0-1
  isVoiceDetected: boolean;
  transcribedText?: string; // Latest transcribed text
}

interface UseVocalAnalysisOptions {
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
  targetPitch?: number; // Optional reference pitch to match
  expectedLyrics?: string; // Current lyrics line for comparison
  isInstrumentalSection?: boolean; // Flag to detect singing during instrumental breaks
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
    technique: 0,
    deductions: 0,
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

  // Technique detection refs (vibrato, glissando)
  const vibratoHistoryRef = useRef<number[]>([]); // Track pitch oscillations
  const lastTechniqueScoreRef = useRef<number>(0);
  
  // Deduction tracking refs
  const deductionScoreRef = useRef<number>(0);
  const offKeyCountRef = useRef<number>(0);
  const instrumentalVoiceCountRef = useRef<number>(0);

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

    // HIGH ACHIEVABILITY DICTION SCORING
    // Any detected words should score well, perfect match not required
    let dictionScore = 0;
    if (options.expectedLyrics) {
      const similarity = calculateSimilarity(text, options.expectedLyrics);
      // Boost similarity scores - 50% match = 75 points, 80% match = 95 points
      dictionScore = Math.min(100, 50 + similarity * 0.5);
    } else {
      // Without lyrics, score based on word detection
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      // Each word = +12 points, base of 55, cap at 95
      dictionScore = Math.min(95, 55 + wordCount * 12);
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
      // Boost intermediate diction when voice is detected
      if (intermediateDictionRef.current < lastDictionScoreRef.current) {
        intermediateDictionRef.current = lastDictionScoreRef.current;
      } else if (intermediateDictionRef.current < 80) {
        // Faster ramp up to reward singing
        intermediateDictionRef.current = Math.min(80, intermediateDictionRef.current + 1.0);
      }
      
      // Minimal deduction for singing during instrumental (barely penalize)
      if (options.isInstrumentalSection) {
        instrumentalVoiceCountRef.current += 1;
        deductionScoreRef.current = Math.min(30, deductionScoreRef.current + 0.1);
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

    // Calculate pitch accuracy - HIGH ACHIEVABILITY SCORING
    // A consistent singer should be able to reach 95-100 with stable pitch
    let pitchAccuracy = 50; // Base score for any voice detected
    if (isVoiceDetected && pitchHistoryRef.current.length > 3) {
      const recentPitches = pitchHistoryRef.current.slice(-15);
      const avgPitch = recentPitches.reduce((a, b) => a + b, 0) / recentPitches.length;
      const variance = recentPitches.reduce((sum, p) => sum + Math.pow(p - avgPitch, 2), 0) / recentPitches.length;
      const stdDev = Math.sqrt(variance);
      // Coefficient of variation - lower is better (more consistent pitch)
      const cv = stdDev / avgPitch;
      
      // Scoring curve: CV of 0 = 100pts, CV of 0.15 = 70pts, CV of 0.3+ = 50pts
      // Most singers have CV between 0.05-0.15, so this is very achievable
      if (cv < 0.05) {
        pitchAccuracy = 95 + (1 - cv / 0.05) * 5; // 95-100 for excellent
      } else if (cv < 0.15) {
        pitchAccuracy = 70 + (1 - (cv - 0.05) / 0.10) * 25; // 70-95 for good
      } else if (cv < 0.30) {
        pitchAccuracy = 50 + (1 - (cv - 0.15) / 0.15) * 20; // 50-70 for average
      }
      // else stays at base 50
      
      // Only penalize truly awful off-key singing (>50% variance)
      if (cv > 0.50) {
        offKeyCountRef.current += 1;
        deductionScoreRef.current = Math.min(50, deductionScoreRef.current + 0.1);
      }
    } else if (isVoiceDetected) {
      pitchAccuracy = 65; // Give decent score while building history
    }

    // Calculate rhythm consistency - HIGH ACHIEVABILITY SCORING
    // Any reasonably consistent beat pattern should score well
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
      
      // Scoring curve: CV of 0 = 100pts, CV of 0.2 = 75pts, CV of 0.5+ = 50pts
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
    // Based on vocal consistency and presence, not complex detection
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

    const displayDiction = Math.max(
      lastDictionScoreRef.current,
      Math.round(intermediateDictionRef.current)
    );

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
      diction: displayDiction,
      technique,
      deductions,
      volume: currentVolume,
      isVoiceDetected,
      transcribedText: lastTranscribedTextRef.current,
    };
  }, [options.isInstrumentalSection]);

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

      // Use centralized microphone and AudioContext initialization
      const stream = await requestMicrophone();
      streamRef.current = stream;
      setHasPermission(true);

      const audioContext = await createAudioContext();
      audioContextRef.current = audioContext;
      inputSampleRateRef.current = audioContext.sampleRate;
      console.log('[audio] AudioContext created', { sampleRate: audioContext.sampleRate, state: audioContext.state });

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
      console.error('[audio] Failed to start vocal analysis:', err);
      setError(formatMicrophoneError(err));
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
    lastDictionScoreRef.current = 0;
    lastTranscribedTextRef.current = '';
    intermediateDictionRef.current = 0;
    lastTechniqueScoreRef.current = 0;
    deductionScoreRef.current = 0;
    offKeyCountRef.current = 0;
    instrumentalVoiceCountRef.current = 0;
    setMetrics({
      pitch: 0,
      pitchAccuracy: 0,
      rhythm: 0,
      diction: 0,
      technique: 0,
      deductions: 0,
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
