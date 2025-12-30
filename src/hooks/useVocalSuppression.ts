import { useRef, useCallback, useState } from 'react';

export function useVocalSuppression() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const invertGain1Ref = useRef<GainNode | null>(null);
  const invertGain2Ref = useRef<GainNode | null>(null);
  const [isEnabled, setIsEnabled] = useState(true);
  const [strength, setStrength] = useState(0.95);
  const connectedRef = useRef(false);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const setupVocalSuppression = useCallback((audioElement: HTMLAudioElement) => {
    if (connectedRef.current) return;
    
    try {
      audioElementRef.current = audioElement;
      
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

      // Create gain nodes for center channel removal
      // Left output = L - R * strength
      // Right output = R - L * strength
      const invertGain1 = audioContext.createGain();
      invertGain1.gain.value = -strength;
      invertGain1Ref.current = invertGain1;

      const invertGain2 = audioContext.createGain();
      invertGain2.gain.value = -strength;
      invertGain2Ref.current = invertGain2;

      // Connect: source -> splitter
      source.connect(splitter);

      // Left channel path: L direct + (-R * strength)
      splitter.connect(merger, 0, 0); // L -> Left output
      splitter.connect(invertGain1, 1); // R -> inverter
      invertGain1.connect(merger, 0, 0); // inverted R -> Left output

      // Right channel path: R direct + (-L * strength)
      splitter.connect(merger, 1, 1); // R -> Right output
      splitter.connect(invertGain2, 0); // L -> inverter
      invertGain2.connect(merger, 0, 1); // inverted L -> Right output

      // Connect to destination
      merger.connect(audioContext.destination);

      connectedRef.current = true;
      console.log('Vocal suppression setup complete, strength:', strength);
    } catch (error) {
      console.error('Failed to setup vocal suppression:', error);
      // If setup fails, try to connect source directly to output
      if (sourceNodeRef.current && audioContextRef.current) {
        sourceNodeRef.current.connect(audioContextRef.current.destination);
        connectedRef.current = true;
      }
    }
  }, [strength]);

  const updateStrength = useCallback((newStrength: number) => {
    setStrength(newStrength);
    if (invertGain1Ref.current && invertGain2Ref.current) {
      invertGain1Ref.current.gain.value = -newStrength;
      invertGain2Ref.current.gain.value = -newStrength;
    }
  }, []);

  const toggleSuppression = useCallback(() => {
    const newEnabled = !isEnabled;
    setIsEnabled(newEnabled);
    if (invertGain1Ref.current && invertGain2Ref.current) {
      const value = newEnabled ? -strength : 0;
      invertGain1Ref.current.gain.value = value;
      invertGain2Ref.current.gain.value = value;
    }
  }, [isEnabled, strength]);

  const cleanup = useCallback(() => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    splitterRef.current = null;
    mergerRef.current = null;
    invertGain1Ref.current = null;
    invertGain2Ref.current = null;
    audioElementRef.current = null;
    connectedRef.current = false;
  }, []);

  const resumeContext = useCallback(async () => {
    if (audioContextRef.current?.state === 'suspended') {
      try {
        await audioContextRef.current.resume();
        console.log('Audio context resumed');
      } catch (error) {
        console.error('Failed to resume audio context:', error);
      }
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
