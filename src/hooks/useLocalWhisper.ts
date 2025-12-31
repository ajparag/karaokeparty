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

  const loadModel = useCallback(async () => {
    if (pipelineRef.current || isLoadingRef.current) return;
    
    isLoadingRef.current = true;
    setIsModelLoading(true);
    setError(null);
    
    try {
      // Dynamic import to avoid loading the library until needed
      const { pipeline } = await import('@huggingface/transformers');
      
      console.log('Loading Whisper model...');
      
      // Use the tiny English model for faster loading and inference
      // It's about 40MB and works well for short audio clips
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny.en',
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
          'onnx-community/whisper-tiny.en',
          {
            progress_callback: (progress: any) => {
              if (progress.status === 'progress' && progress.progress) {
                setLoadProgress(Math.round(progress.progress));
              }
            },
          }
        );
        
        pipelineRef.current = transcriber;
        setIsModelReady(true);
        console.log('Whisper model loaded (WASM fallback)');
      } catch (fallbackErr) {
        console.error('Failed to load Whisper model (fallback):', fallbackErr);
        setError('Failed to load speech recognition model');
      }
    } finally {
      setIsModelLoading(false);
      isLoadingRef.current = false;
    }
  }, []);

  const transcribe = useCallback(async (audioBlob: Blob): Promise<TranscriptionResult | null> => {
    if (!pipelineRef.current) {
      console.warn('Whisper model not loaded');
      return null;
    }

    try {
      // Convert blob to array buffer
      const arrayBuffer = await audioBlob.arrayBuffer();
      
      // Create audio context to decode the audio
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get mono audio data
      const channelData = audioBuffer.getChannelData(0);
      
      // Convert Float32Array to the format the model expects
      const audioData = new Float32Array(channelData);
      
      // Run transcription
      const result = await pipelineRef.current(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      });
      
      await audioContext.close();
      
      return { text: result.text || '' };
    } catch (err) {
      console.error('Transcription error:', err);
      return null;
    }
  }, []);

  const dispose = useCallback(() => {
    if (pipelineRef.current) {
      pipelineRef.current = null;
      setIsModelReady(false);
    }
  }, []);

  return {
    isModelLoading,
    isModelReady,
    loadProgress,
    error,
    loadModel,
    transcribe,
    dispose,
  };
}
