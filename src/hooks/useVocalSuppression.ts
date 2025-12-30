import { useRef, useCallback, useState } from 'react';

interface VocalSuppressionOptions {
  enabled?: boolean;
  strength?: number; // 0-1, how much to suppress center channel
}

export function useVocalSuppression() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const gainLRef = useRef<GainNode | null>(null);
  const gainRRef = useRef<GainNode | null>(null);
  const invertGainRef = useRef<GainNode | null>(null);
  const [isEnabled, setIsEnabled] = useState(true);
  const [strength, setStrength] = useState(0.95);
  const connectedRef = useRef(false);

  const setupVocalSuppression = useCallback((audioElement: HTMLAudioElement) => {
    if (connectedRef.current) return;
    
    try {
      // Create audio context
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      // Create source from audio element
      const source = audioContext.createMediaElementSource(audioElement);
      sourceNodeRef.current = source;

      // Create channel splitter (stereo to 2 mono channels)
      const splitter = audioContext.createChannelSplitter(2);
      splitterRef.current = splitter;

      // Create channel merger (2 mono to stereo)
      const merger = audioContext.createChannelMerger(2);
      mergerRef.current = merger;

      // Create gain nodes for each channel
      const gainL = audioContext.createGain();
      const gainR = audioContext.createGain();
      gainLRef.current = gainL;
      gainRRef.current = gainR;

      // Create inverted gain for center removal
      // By subtracting right from left, we remove content common to both (center-panned vocals)
      const invertGain = audioContext.createGain();
      invertGain.gain.value = -strength; // Invert and scale
      invertGainRef.current = invertGain;

      // Connect the nodes for vocal suppression:
      // Left channel = L - (R * strength)
      // Right channel = R - (L * strength)
      
      source.connect(splitter);

      // Left output: Left channel minus inverted Right
      splitter.connect(gainL, 0); // Left channel
      splitter.connect(invertGain, 1); // Right channel to inverter
      gainL.connect(merger, 0, 0);
      invertGain.connect(merger, 0, 0);

      // Right output: Right channel minus inverted Left  
      const invertGain2 = audioContext.createGain();
      invertGain2.gain.value = -strength;
      splitter.connect(gainR, 1); // Right channel
      splitter.connect(invertGain2, 0); // Left channel to inverter
      gainR.connect(merger, 0, 1);
      invertGain2.connect(merger, 0, 1);

      // Connect to destination
      merger.connect(audioContext.destination);

      connectedRef.current = true;
      console.log('Vocal suppression enabled with strength:', strength);
    } catch (error) {
      console.error('Failed to setup vocal suppression:', error);
      // Fallback: just connect source directly
      if (sourceNodeRef.current && audioContextRef.current) {
        sourceNodeRef.current.connect(audioContextRef.current.destination);
      }
    }
  }, [strength]);

  const updateStrength = useCallback((newStrength: number) => {
    setStrength(newStrength);
    if (invertGainRef.current) {
      invertGainRef.current.gain.value = -newStrength;
    }
  }, []);

  const toggleSuppression = useCallback(() => {
    setIsEnabled(prev => !prev);
    if (invertGainRef.current) {
      invertGainRef.current.gain.value = isEnabled ? 0 : -strength;
    }
  }, [isEnabled, strength]);

  const cleanup = useCallback(() => {
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    sourceNodeRef.current = null;
    splitterRef.current = null;
    mergerRef.current = null;
    gainLRef.current = null;
    gainRRef.current = null;
    invertGainRef.current = null;
    connectedRef.current = false;
  }, []);

  const resumeContext = useCallback(async () => {
    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume();
    }
  }, []);

  return {
    setupVocalSuppression,
    updateStrength,
    toggleSuppression,
    cleanup,
    resumeContext,
    isEnabled,
    strength,
  };
}
