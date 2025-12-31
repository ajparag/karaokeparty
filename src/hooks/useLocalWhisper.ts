import { useState, useRef, useCallback } from 'react';

interface TranscriptionResult {
  text: string;
}

export function useLocalWhisper() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [isModelReady, setIsModelReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  const pipelineRef = useRef<any>(null);
  const isLoadingRef = useRef(false);
  const isModelReadyRef = useRef(false);

  const loadModel = useCallback(async () => {
    if (pipelineRef.current || isLoadingRef.current) return;
    
    isLoadingRef.current = true;
    setIsModelLoading(true);
    setError(null);
    
    try {
      // Dynamic import to avoid loading the library until needed
      const { pipeline } = await import('@huggingface/transformers');
      
      console.log('Loading Whisper model...');
      
      // Use the multilingual tiny model for Hindi support
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny',
        {
          device: 'webgpu', // Use WebGPU if available, falls back to WASM
          progress_callback: (progress: any) => {
            if (progress.status === 'progress' && progress.progress) {
              setLoadProgress(Math.round(progress.progress));
            }
          },
        }
      );
      
      pipelineRef.current = transcriber;
      isModelReadyRef.current = true;
      setIsModelReady(true);
      console.log('Whisper model loaded successfully');
    } catch (err) {
      console.error('Failed to load Whisper model:', err);
      
      // Try fallback without WebGPU
      try {
        const { pipeline } = await import('@huggingface/transformers');
        
        console.log('Retrying without WebGPU...');
        const transcriber = await pipeline(
          'automatic-speech-recognition',
          'onnx-community/whisper-tiny',
          {
            progress_callback: (progress: any) => {
              if (progress.status === 'progress' && progress.progress) {
                setLoadProgress(Math.round(progress.progress));
              }
            },
          }
        );
        
        pipelineRef.current = transcriber;
        isModelReadyRef.current = true;
        setIsModelReady(true);
        console.log('Whisper model loaded (WASM fallback)');
      } catch (fallbackErr) {
        console.error('Failed to load Whisper model (fallback):', fallbackErr);
        isModelReadyRef.current = false;
        setError('Failed to load speech recognition model');
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

        const result = await pipelineRef.current(audioData, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: false,
          // Force Hindi transcription (Devanagari), not translation
          task: 'transcribe',
          language: 'hi',
          generate_kwargs: {
            task: 'transcribe',
            language: 'hi',
          },
        });

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
