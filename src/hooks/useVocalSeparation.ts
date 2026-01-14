import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getCachedTracks, saveCachedTracks, clearOldCache } from '@/lib/audioCache';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string): Promise<SeparationResult | null> => {
    setIsProcessing(true);
    setProgress('Checking cache...');
    setError(null);

    abortControllerRef.current = new AbortController();

    try {
      // Clear old cache entries on first use
      await clearOldCache(7);

      // Check IndexedDB cache first
      const cached = await getCachedTracks(audioUrl);
      if (cached) {
        setProgress('Loading from cache...');
        const instrumentalUrl = URL.createObjectURL(cached.instrumentalBlob);
        const vocalsUrl = cached.vocalsBlob ? URL.createObjectURL(cached.vocalsBlob) : undefined;
        
        const result: SeparationResult = {
          instrumentalUrl,
          vocalsUrl,
          fromCache: true,
        };
        
        setSeparatedAudio(result);
        setProgress('');
        return result;
      }

      setProgress('Downloading audio for processing...');

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

      setProgress('Downloading separated tracks for caching...');

      // Download and cache the separated tracks
      const [instrumentalResponse, vocalsResponse] = await Promise.all([
        fetch(data.instrumentalUrl),
        data.vocalsUrl ? fetch(data.vocalsUrl) : Promise.resolve(null),
      ]);

      if (!instrumentalResponse.ok) {
        throw new Error('Failed to download instrumental track');
      }

      const instrumentalBlob = await instrumentalResponse.blob();
      const vocalsBlob = vocalsResponse?.ok ? await vocalsResponse.blob() : undefined;

      // Save to IndexedDB
      setProgress('Saving to cache...');
      await saveCachedTracks(audioUrl, instrumentalBlob, vocalsBlob);

      // Create object URLs from the blobs
      const instrumentalUrl = URL.createObjectURL(instrumentalBlob);
      const vocalsUrl = vocalsBlob ? URL.createObjectURL(vocalsBlob) : undefined;

      const result: SeparationResult = {
        instrumentalUrl,
        vocalsUrl,
        fromCache: false,
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
