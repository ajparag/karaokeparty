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
    setProgress('Connecting to AI separation service...');
    setError(null);

    abortControllerRef.current = new AbortController();

    try {
      setProgress('Uploading audio for processing...');
      
      const { data, error: fnError } = await supabase.functions.invoke('separate-vocals', {
        body: { audioUrl },
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
