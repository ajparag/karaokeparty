import { useRef, useCallback, useEffect, useState } from "react";

export function useVocalSuppression() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const invertGain1Ref = useRef<GainNode | null>(null);
  const invertGain2Ref = useRef<GainNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);

  // Default OFF to prioritize reliable playback; user can enable suppression explicitly.
  const [isEnabled, setIsEnabled] = useState(false);
  const [strength, setStrength] = useState(0.95);

  // Keep stable refs so our callbacks don't change identity when state changes.
  // This prevents consumers (like Sing.tsx) from recreating the Audio element on every toggle.
  const isEnabledRef = useRef(false);
  const strengthRef = useRef(0.95);


  const connectedRef = useRef(false);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    isEnabledRef.current = isEnabled;
  }, [isEnabled]);

  useEffect(() => {
    strengthRef.current = strength;
  }, [strength]);

  const computeMakeupGain = useCallback((s: number) => {
    // When L≈R (mono/dual-mono), center-cancel can reduce the entire signal to ~ (1-s).
    // Apply limited makeup gain so backing track stays audible.
    const denom = Math.max(0.15, 1 - s);
    return Math.min(6, 1 / denom);
  }, []);

  const applyNodeParams = useCallback(
    (nextEnabled: boolean, nextStrength: number) => {
      if (invertGain1Ref.current && invertGain2Ref.current) {
        const value = nextEnabled ? -nextStrength : 0;
        invertGain1Ref.current.gain.value = value;
        invertGain2Ref.current.gain.value = value;
      }

      if (outputGainRef.current) {
        outputGainRef.current.gain.value = nextEnabled ? computeMakeupGain(nextStrength) : 1;
      }
    },
    [computeMakeupGain]
  );

  const setupVocalSuppression = useCallback(
    (audioElement: HTMLAudioElement) => {
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

        // Output gain (makeup gain) to avoid near-silence on mono/dual-mono tracks
        const outputGain = audioContext.createGain();
        outputGainRef.current = outputGain;

        // Create gain nodes for center channel removal
        // Left output = L - R * strength
        // Right output = R - L * strength
        const invertGain1 = audioContext.createGain();
        invertGain1Ref.current = invertGain1;

        const invertGain2 = audioContext.createGain();
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
        merger.connect(outputGain);
        outputGain.connect(audioContext.destination);

        // Apply initial params
        applyNodeParams(isEnabledRef.current, strengthRef.current);

        connectedRef.current = true;
        console.log("Vocal suppression setup complete, strength:", strengthRef.current);
      } catch (error) {
        console.error("Failed to setup vocal suppression:", error);

        // If setup fails, just let the audio element play normally (no WebAudio graph).
        connectedRef.current = false;
      }
    },
    [applyNodeParams]
  );

  const updateStrength = useCallback(
    (newStrength: number) => {
      setStrength(newStrength);
      strengthRef.current = newStrength;
      applyNodeParams(isEnabledRef.current, newStrength);
    },
    [applyNodeParams]
  );

  const toggleSuppression = useCallback(() => {
    const nextEnabled = !isEnabledRef.current;
    isEnabledRef.current = nextEnabled;
    setIsEnabled(nextEnabled);
    applyNodeParams(nextEnabled, strengthRef.current);
  }, [applyNodeParams]);

  const cleanup = useCallback(() => {
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }

    audioContextRef.current = null;
    sourceNodeRef.current = null;
    splitterRef.current = null;
    mergerRef.current = null;
    invertGain1Ref.current = null;
    invertGain2Ref.current = null;
    outputGainRef.current = null;
    audioElementRef.current = null;

    connectedRef.current = false;
  }, []);

  const resumeContext = useCallback(async () => {
    if (audioContextRef.current?.state === "suspended") {
      try {
        await audioContextRef.current.resume();
        console.log("Audio context resumed");
      } catch (error) {
        console.error("Failed to resume audio context:", error);
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

