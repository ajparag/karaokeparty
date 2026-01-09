import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
}

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string): Promise<SeparationResult | null> => {
    setIsProcessing(true);
    setProgress('Downloading audio for processing...');
    setError(null);

    abortControllerRef.current = new AbortController();

    try {
      // Fetch the audio from client side (works with CORS) and convert to base64
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
      }
      
      const audioBlob = await audioResponse.blob();
      setProgress(`Converting audio (${Math.round(audioBlob.size / 1024)}KB)...`);
      
      // Convert blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const audioBase64 = btoa(binary);
      
      setProgress('Sending to AI for vocal separation (this may take 1-2 minutes)...');
      
      const { data, error: fnError } = await supabase.functions.invoke('separate-vocals', {
        body: { audioBase64 },
      });

      if (fnError) {
        throw new Error(fnError.message || 'Separation failed');
      }

      if (!data?.success || !data?.instrumentalUrl) {
        throw new Error(data?.error || 'Failed to get instrumental track');
      }

      const result: SeparationResult = {
        instrumentalUrl: data.instrumentalUrl,
        vocalsUrl: data.vocalsUrl,
      };

      setSeparatedAudio(result);
      setProgress('');
      return result;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setProgress('');
      return null;
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessing(false);
    setProgress('');
    setError(null);
    setSeparatedAudio(null);
  }, []);

  return {
    isProcessing,
    progress,
    error,
    separatedAudio,
    separateVocals,
    reset,
  };
}
