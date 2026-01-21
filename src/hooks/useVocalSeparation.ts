import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getCachedTracks, saveCachedTracks, clearOldCache } from '@/lib/audioCache';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// Audio prefetch cache - stores downloaded blobs before separation starts
const audioPrefetchCache = new Map<string, { blob: Blob; timestamp: number }>();
const PREFETCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Prefetch audio in background (called on track hover/click)
export async function prefetchAudio(audioUrl: string): Promise<void> {
  // Already prefetched recently?
  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) {
    return;
  }

  try {
    console.log('[VocalSeparation] Prefetching audio:', audioUrl.slice(0, 50));
    const response = await fetch(audioUrl);
    if (response.ok) {
      const blob = await response.blob();
      audioPrefetchCache.set(audioUrl, { blob, timestamp: Date.now() });
      console.log('[VocalSeparation] Audio prefetched:', Math.round(blob.size / 1024), 'KB');
    }
  } catch (err) {
    console.warn('[VocalSeparation] Prefetch failed:', err);
  }
}

// Get prefetched audio or download fresh
async function getAudioBlob(audioUrl: string): Promise<Blob> {
  // Check prefetch cache first
  const cached = audioPrefetchCache.get(audioUrl);
  if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) {
    console.log('[VocalSeparation] Using prefetched audio');
    audioPrefetchCache.delete(audioUrl); // Clean up after use
    return cached.blob;
  }

  // Download fresh
  console.log('[VocalSeparation] Downloading audio...');
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.statusText}`);
  }
  return response.blob();
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
      // Clear old cache entries in background (non-blocking)
      clearOldCache(7).catch(console.error);

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
        setIsProcessing(false);
        return result;
      }

      setProgress('Preparing audio...');

      // Get audio blob (from prefetch cache or fresh download)
      const audioBlob = await getAudioBlob(audioUrl);
      setProgress(`Processing audio (${Math.round(audioBlob.size / 1024)}KB)...`);

      // Use FormData for streaming upload (no base64 overhead!)
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.mp4');
      
      setProgress('AI vocal separation (1-2 min)...');
      
      // Call edge function with FormData (streaming)
      const { data, error: fnError } = await supabase.functions.invoke('separate-vocals', {
        body: formData,
      });

      if (fnError) {
        throw new Error(fnError.message || 'Separation failed');
      }

      if (!data?.success || !data?.instrumentalUrl) {
        throw new Error(data?.error || 'Failed to get instrumental track');
      }

      setProgress('Downloading tracks...');

      // Download instrumental and vocals in parallel for faster availability
      const [instrumentalResponse, vocalsResponse] = await Promise.all([
        fetch(data.instrumentalUrl),
        data.vocalsUrl ? fetch(data.vocalsUrl) : Promise.resolve(null),
      ]);

      if (!instrumentalResponse.ok) {
        throw new Error('Failed to download instrumental track');
      }

      // Get blobs in parallel
      const [instrumentalBlob, vocalsBlob] = await Promise.all([
        instrumentalResponse.blob(),
        vocalsResponse?.ok ? vocalsResponse.blob() : Promise.resolve(undefined),
      ]);

      // Create object URLs immediately for playback
      const instrumentalUrl = URL.createObjectURL(instrumentalBlob);
      const vocalsUrl = vocalsBlob ? URL.createObjectURL(vocalsBlob) : undefined;

      const result: SeparationResult = {
        instrumentalUrl,
        vocalsUrl,
        fromCache: false,
      };

      // Set result immediately so playback can start
      setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);

      // Save to IndexedDB in background (non-blocking) - don't wait for this
      saveCachedTracks(audioUrl, instrumentalBlob, vocalsBlob)
        .then(() => console.log('[VocalSeparation] Cached tracks saved'))
        .catch((err) => console.error('[VocalSeparation] Failed to cache tracks:', err));

      return result;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setProgress('');
      setIsProcessing(false);
      return null;
    } finally {
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
