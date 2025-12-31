import { useState, useRef, useCallback } from 'react';

const WHISPER_MODEL_ID = 'onnx-community/whisper-small';
const WHISPER_LANGUAGE_PRIMARY = 'hi';
const WHISPER_LANGUAGE_FALLBACK = 'hindi';

const hasDevanagari = (text: string) => /[\u0900-\u097F]/.test(text);

interface TranscriptionResult {
  text: string;
}

export function useLocalWhisper() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [isModelReady, setIsModelReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  const pipelineRef = useRef<any>(null);
  const modelIdRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const isModelReadyRef = useRef(false);

  // Force decoder prompts to Hindi + transcribe (prevents English translation/romanization)
  const forcedDecoderIdsPrimaryRef = useRef<any>(null);
  const forcedDecoderIdsFallbackRef = useRef<any>(null);

  const loadModel = useCallback(async (): Promise<boolean> => {
    // If already loading, wait for it
    if (isLoadingRef.current) {
      // Poll until loading finishes
      return new Promise((resolve) => {
        const check = () => {
          if (!isLoadingRef.current) {
            resolve(isModelReadyRef.current);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    // If an older model instance is already loaded (e.g. after hot reload), force reload
    if (pipelineRef.current && modelIdRef.current === WHISPER_MODEL_ID) {
      return true;
    }
    if (pipelineRef.current && modelIdRef.current !== WHISPER_MODEL_ID) {
      pipelineRef.current = null;
      modelIdRef.current = null;
      isModelReadyRef.current = false;
      setIsModelReady(false);
    }
    
    isLoadingRef.current = true;
    setIsModelLoading(true);
    setError(null);
    
    try {
      // Dynamic import to avoid loading the library until needed
      const { pipeline } = await import('@huggingface/transformers');
      
      console.log('Loading Whisper model...', WHISPER_MODEL_ID);
      
      // Use the multilingual small model for Hindi support
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        WHISPER_MODEL_ID,
        {
          device: 'webgpu', // Use WebGPU if available, falls back to WASM
          progress_callback: (progress: any) => {
            if (progress.status === 'progress' && progress.progress) {
              setLoadProgress(Math.round(progress.progress));
            }
            console.log('[whisper] load progress', progress);
          },
        }
      );
      
      pipelineRef.current = transcriber;
      modelIdRef.current = WHISPER_MODEL_ID;
      isModelReadyRef.current = true;
      setIsModelReady(true);
      console.log('Whisper model loaded successfully');
      return true;
    } catch (err) {
      console.error('Failed to load Whisper model:', err);
      
      // Try fallback without WebGPU
      try {
        const { pipeline } = await import('@huggingface/transformers');
        
        console.log('Retrying without WebGPU...');
        const transcriber = await pipeline(
          'automatic-speech-recognition',
          WHISPER_MODEL_ID,
          {
            progress_callback: (progress: any) => {
              if (progress.status === 'progress' && progress.progress) {
                setLoadProgress(Math.round(progress.progress));
              }
              console.log('[whisper] load progress (fallback)', progress);
            },
          }
        );
        
        pipelineRef.current = transcriber;
        modelIdRef.current = WHISPER_MODEL_ID;
        isModelReadyRef.current = true;
        setIsModelReady(true);
        console.log('Whisper model loaded (WASM fallback)');
        return true;
      } catch (fallbackErr) {
        console.error('Failed to load Whisper model (fallback):', fallbackErr);
        isModelReadyRef.current = false;
        setError('Failed to load speech recognition model');
        return false;
      }
    } finally {
      setIsModelLoading(false);
      isLoadingRef.current = false;
    }
  }, []);

  const transcribe = useCallback(
    async (audioInput: Blob | Float32Array): Promise<TranscriptionResult | null> => {
      if (!pipelineRef.current) {
        console.warn('Whisper model not loaded');
        return null;
      }

      try {
        let audioData: Float32Array;

        if (audioInput instanceof Float32Array) {
          // Already raw mono PCM (ideally 16kHz)
          audioData = audioInput;
        } else {
          // Decode Blob -> Float32Array
          const arrayBuffer = await audioInput.arrayBuffer();
          const audioContext = new AudioContext();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          const channelData = audioBuffer.getChannelData(0);

          // Downsample to 16kHz if needed (simple decimation)
          if (audioBuffer.sampleRate !== 16000) {
            const ratio = audioBuffer.sampleRate / 16000;
            const newLength = Math.floor(channelData.length / ratio);
            const downsampled = new Float32Array(newLength);
            for (let i = 0; i < newLength; i++) {
              downsampled[i] = channelData[Math.floor(i * ratio)];
            }
            audioData = downsampled;
          } else {
            audioData = new Float32Array(channelData);
          }

          await audioContext.close();
        }

        const baseOpts = {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: false,
          // Force Hindi transcription (Devanagari), not translation
          task: 'transcribe',
          language: WHISPER_LANGUAGE_PRIMARY,
        } as const;

        let result = await pipelineRef.current(audioData, {
          ...baseOpts,
          generate_kwargs: {
            task: 'transcribe',
            language: WHISPER_LANGUAGE_PRIMARY,
          },
        });

        const text1 = (result?.text || '').trim();

        // transformers.js sometimes prefers full language name; retry if output isn't Devanagari
        if (text1 && !hasDevanagari(text1)) {
          const retry = await pipelineRef.current(audioData, {
            ...baseOpts,
            language: WHISPER_LANGUAGE_FALLBACK,
            generate_kwargs: {
              task: 'transcribe',
              language: WHISPER_LANGUAGE_FALLBACK,
            },
          });
          if (retry?.text) result = retry;
        }

        return { text: result.text || '' };
      } catch (err) {
        console.error('Transcription error:', err);
        return null;
      }
    },
    []
  );

  const dispose = useCallback(() => {
    if (pipelineRef.current) {
      pipelineRef.current = null;
      modelIdRef.current = null;
      isModelReadyRef.current = false;
      setIsModelReady(false);
    }
  }, []);

  // Expose ref for synchronous checks
  const checkModelReady = useCallback(() => isModelReadyRef.current, []);

  return {
    isModelLoading,
    isModelReady,
    loadProgress,
    error,
    loadModel,
    transcribe,
    dispose,
    checkModelReady,
  };
}
