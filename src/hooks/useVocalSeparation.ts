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

// Track if HF space has been warmed up this session
let hfSpaceWarmedUp = false;
let hfWarmUpPromise: Promise<void> | null = null;

// Warm up HuggingFace space proactively (non-blocking, singleton)
export async function warmUpHFSpace(): Promise<void> {
  if (hfSpaceWarmedUp) return Promise.resolve();
  if (hfWarmUpPromise) return hfWarmUpPromise;

  hfWarmUpPromise = (async () => {
    try {
      console.log('[VocalSeparation] Warming up HF space...');
      const { data } = await supabase.functions.invoke('separate-vocals', {
        body: { warmUp: true },
      });
      if (data?.ready) {
        hfSpaceWarmedUp = true;
        console.log('[VocalSeparation] HF space is warm!');
      }
    } catch (err) {
      console.warn('[VocalSeparation] HF warm-up failed (non-critical):', err);
    } finally {
      hfWarmUpPromise = null;
    }
  })();

  return hfWarmUpPromise;
}

// Prefetch audio in background (called on track hover/click)
export async function prefetchAudio(audioUrl: string): Promise<void> {
  // Start warming up HF space in parallel
  warmUpHFSpace();

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

// Compress audio using Web Audio API to reduce upload size
async function compressAudio(audioBlob: Blob): Promise<Blob> {
  try {
    // Only compress if larger than 1MB
    if (audioBlob.size < 1 * 1024 * 1024) {
      console.log('[VocalSeparation] Audio small enough, skipping compression');
      return audioBlob;
    }

    console.log('[VocalSeparation] Compressing audio...', Math.round(audioBlob.size / 1024), 'KB');
    
    // Create audio context
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Decode the audio
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Calculate target sample rate (downsample to 16000 Hz for faster upload/processing)
    const targetSampleRate = Math.min(16000, audioBuffer.sampleRate);
    
    // Create offline context for resampling
    const offlineContext = new OfflineAudioContext(
      1, // Mono for smaller size
      Math.ceil(audioBuffer.duration * targetSampleRate),
      targetSampleRate
    );
    
    // Create buffer source
    const source = offlineContext.createBufferSource();
    
    // Mix down to mono if stereo
    const monoBuffer = offlineContext.createBuffer(
      1,
      audioBuffer.length,
      audioBuffer.sampleRate
    );
    const monoData = monoBuffer.getChannelData(0);
    
    if (audioBuffer.numberOfChannels === 2) {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      for (let i = 0; i < monoData.length; i++) {
        monoData[i] = (left[i] + right[i]) / 2;
      }
    } else {
      monoData.set(audioBuffer.getChannelData(0));
    }
    
    source.buffer = monoBuffer;
    source.connect(offlineContext.destination);
    source.start();
    
    // Render the resampled audio
    const renderedBuffer = await offlineContext.startRendering();
    
    // Convert to WAV (simple, no complex encoding needed)
    const wavBlob = audioBufferToWav(renderedBuffer);
    
    await audioContext.close();
    
    console.log('[VocalSeparation] Compressed to:', Math.round(wavBlob.size / 1024), 'KB',
      `(${Math.round((1 - wavBlob.size / audioBlob.size) * 100)}% reduction)`);
    
    return wavBlob;
  } catch (err) {
    console.warn('[VocalSeparation] Compression failed, using original:', err);
    return audioBlob;
  }
}

// Convert AudioBuffer to WAV blob
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  
  const samples = buffer.getChannelData(0);
  const dataLength = samples.length * bytesPerSample;
  const bufferLength = 44 + dataLength;
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  
  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferLength - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  
  // Convert float samples to 16-bit PCM
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
      }
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId != null) window.clearTimeout(timeoutId);
  });
}

async function downloadWithStreaming(url: string, opts?: { timeoutMs?: number; label?: string }): Promise<Blob> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const label = opts?.label ?? 'download';

  const controller = new AbortController();
  const downloadPromise = (async () => {
    const response = await fetch(url, {
      signal: controller.signal,
      // HF can be finicky with caching/redirects; these hints reduce “stuck” fetches.
      cache: 'no-store',
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Failed to download (${response.status}): ${response.statusText}`);
    }

    // Use streaming if available; otherwise fall back to blob.
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }

      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }

      return new Blob([result]);
    }

    return await response.blob();
  })();

  return withTimeout(downloadPromise, timeoutMs, label, () => controller.abort());
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
      
      // Skip client-side compression - it converts compressed AAC to uncompressed WAV
      // which actually increases file size. Send original AAC directly to HuggingFace.
      console.log('[VocalSeparation] Uploading original audio:', Math.round(audioBlob.size / 1024), 'KB');
      
      setProgress(`Uploading (${Math.round(audioBlob.size / 1024)}KB)...`);

      // Use FormData for streaming upload (no base64 overhead!)
      const formData = new FormData();
      // Determine file extension from blob type
      const extension = audioBlob.type.includes('wav') ? 'audio.wav' 
        : audioBlob.type.includes('mp4') || audioBlob.type.includes('m4a') ? 'audio.m4a'
        : audioBlob.type.includes('mpeg') ? 'audio.mp3'
        : 'audio.mp4';
      formData.append('audio', audioBlob, extension);
      
      setProgress('AI vocal separation...');
      
      // Call edge function with FormData - use fetch directly to handle binary response
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      const response = await fetch(`${supabaseUrl}/functions/v1/separate-vocals`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Separation failed: ${response.status} - ${errorText}`);
      }

      let instrumentalBlob: Blob;
      let vocalsBlob: Blob | undefined;

      const contentType = response.headers.get('Content-Type') || '';
      
      // Handle binary blob response (preferred - no base64 overhead)
      if (contentType.includes('application/octet-stream')) {
        const audioFormat = response.headers.get('X-Audio-Format') || 'wav';
        const mimeType = audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        setProgress(`Processing ${audioFormat.toUpperCase()} tracks...`);
        
        const binaryData = await response.arrayBuffer();
        const view = new DataView(binaryData);
        const instrumentalSize = view.getUint32(0, true); // little-endian
        const vocalsSize = binaryData.byteLength - 4 - instrumentalSize;
        
        console.log('[VocalSeparation] Received binary tracks:', {
          format: audioFormat,
          instrumentalSize: `${Math.round(instrumentalSize / 1024)}KB`,
          vocalsSize: vocalsSize > 0 ? `${Math.round(vocalsSize / 1024)}KB` : 'none',
          totalSize: `${Math.round(binaryData.byteLength / 1024)}KB`,
        });

        // Extract instrumental
        instrumentalBlob = new Blob(
          [new Uint8Array(binaryData, 4, instrumentalSize)],
          { type: mimeType }
        );

        // Extract vocals if present
        if (vocalsSize > 0) {
          vocalsBlob = new Blob(
            [new Uint8Array(binaryData, 4 + instrumentalSize, vocalsSize)],
            { type: mimeType }
          );
        }
      }
      // Handle JSON response (fallback mode with URLs)
      else {
        const data = await response.json();
        
        if (!data?.success) {
          throw new Error(data?.error || 'Separation failed');
        }

        if (!data.instrumentalUrl) {
          throw new Error('No audio data in response');
        }

        setProgress('Downloading tracks...');

        // Download both tracks in PARALLEL for speed.
        const instrumentalPromise = downloadWithStreaming(data.instrumentalUrl, {
          label: 'Instrumental download',
          timeoutMs: 90_000,
        });

        const vocalsPromise = data.vocalsUrl
          ? downloadWithStreaming(data.vocalsUrl, {
              label: 'Vocals download',
              timeoutMs: 90_000,
            }).catch((e) => {
              console.warn('[VocalSeparation] Vocals download failed; continuing instrumental-only:', e);
              return undefined;
            })
          : Promise.resolve(undefined);

        [instrumentalBlob, vocalsBlob] = await Promise.all([instrumentalPromise, vocalsPromise]) as [Blob, Blob | undefined];
      }

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
