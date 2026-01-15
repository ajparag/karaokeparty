import { useState, useRef, useCallback, useEffect } from 'react';

interface UseSpeechmaticsRealtimeOptions {
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

export function useSpeechmaticsRealtime(options: UseSpeechmaticsRealtimeOptions = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState('');
  const [finalText, setFinalText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Downsample to 16kHz for Speechmatics
  const downsampleBuffer = useCallback((buffer: Float32Array, inputSampleRate: number): Int16Array => {
    const targetSampleRate = 16000;
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = Math.floor(i * ratio);
      // Convert float32 [-1, 1] to int16 [-32768, 32767]
      const s = Math.max(-1, Math.min(1, buffer[srcIndex]));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return result;
  }, []);

  const connect = useCallback(async () => {
    if (isConnected || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      // iOS Safari fix: Reset audio session to 'auto' BEFORE requesting microphone
      if ('audioSession' in navigator && (navigator as any).audioSession) {
        try {
          (navigator as any).audioSession.type = 'auto';
          console.log('[speechmatics-rt] Reset audio session type to auto');
        } catch (e) {
          console.log('[speechmatics-rt] Could not reset audio session type:', e);
        }
      }

      // Get microphone access with minimal constraints for iOS compatibility
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      console.log('[speechmatics-rt] Microphone stream obtained, tracks:', stream.getAudioTracks().length);

      // iOS Safari fix: "Kick" audio session to 'play-and-record' AFTER getting the stream
      if ('audioSession' in navigator && (navigator as any).audioSession) {
        try {
          (navigator as any).audioSession.type = 'play-and-record';
          console.log('[speechmatics-rt] Set audio session type to play-and-record');
        } catch (e) {
          console.log('[speechmatics-rt] Could not set audio session type:', e);
        }
      }

      // Use webkitAudioContext fallback for older Safari versions
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext not supported on this browser');
      }

      const audioContext = new AudioContextClass({ latencyHint: 'playback' });
      audioContextRef.current = audioContext;

      // Resume AudioContext if suspended (required on iOS Safari)
      if (audioContext.state === 'suspended') {
        console.log('[speechmatics-rt] AudioContext suspended, resuming...');
        await audioContext.resume();
        console.log('[speechmatics-rt] AudioContext resumed:', audioContext.state);
      }

      const inputSampleRate = audioContext.sampleRate;
      console.log('[speechmatics-rt] Audio context sample rate:', inputSampleRate);

      // Connect WebSocket to our edge function
      const wsUrl = `wss://wnfgqlywaecvbptjvktt.functions.supabase.co/speechmatics-realtime`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[speechmatics-rt] WebSocket opened');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[speechmatics-rt] Message:', data.type, data.text?.substring(0, 50));

          if (data.type === 'connected') {
            setIsConnected(true);
            setIsConnecting(false);
            console.log('[speechmatics-rt] Recognition started, setting up audio');

            // Set up audio processing now that we're connected
            const source = audioContext.createMediaStreamSource(stream);
            sourceRef.current = source;

            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              if (ws.readyState !== WebSocket.OPEN) return;

              const inputData = e.inputBuffer.getChannelData(0);
              const int16Data = downsampleBuffer(inputData, inputSampleRate);

              // Send as binary
              ws.send(int16Data.buffer);
            };

            source.connect(processor);
            // Connect to destination to keep it running (muted)
            const mute = audioContext.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(audioContext.destination);
          } else if (data.type === 'partial') {
            setPartialText(data.text || '');
            options.onPartialTranscript?.(data.text || '');
          } else if (data.type === 'final') {
            setFinalText((prev) => (prev ? prev + ' ' + data.text : data.text));
            setPartialText('');
            options.onFinalTranscript?.(data.text || '');
          } else if (data.type === 'error') {
            setError(data.error);
            options.onError?.(data.error);
          } else if (data.type === 'disconnected') {
            setIsConnected(false);
          }
        } catch (err) {
          console.error('[speechmatics-rt] Parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('[speechmatics-rt] WebSocket error:', err);
        setError('Connection error');
        setIsConnecting(false);
      };

      ws.onclose = () => {
        console.log('[speechmatics-rt] WebSocket closed');
        setIsConnected(false);
        setIsConnecting(false);
      };
    } catch (err) {
      console.error('[speechmatics-rt] Setup error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setIsConnecting(false);
    }
  }, [isConnected, isConnecting, downsampleBuffer, options]);

  const disconnect = useCallback(() => {
    console.log('[speechmatics-rt] Disconnecting...');

    // Stop audio processing
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
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

    setIsConnected(false);
    setPartialText('');
  }, []);

  const reset = useCallback(() => {
    setFinalText('');
    setPartialText('');
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    isConnected,
    isConnecting,
    error,
    partialText,
    finalText,
    connect,
    disconnect,
    reset,
  };
}
