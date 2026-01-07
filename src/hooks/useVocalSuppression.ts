import { useRef, useCallback, useEffect, useState } from "react";

/**
 * Enhanced vocal suppression using Web Audio API with:
 * - Dry/wet mixing to ensure audio always plays
 * - Stereo phase cancellation (center-channel removal)
 * - Frequency filtering to protect bass and treble
 */
export function useVocalSuppression() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const invertGain1Ref = useRef<GainNode | null>(null);
  const invertGain2Ref = useRef<GainNode | null>(null);
  
  // Dry/wet mixing - ensures audio always plays
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const finalMixerRef = useRef<GainNode | null>(null);
  
  // Frequency filters for improved vocal isolation
  const lowShelfRef = useRef<BiquadFilterNode | null>(null);
  const highShelfRef = useRef<BiquadFilterNode | null>(null);
  const vocalNotch1Ref = useRef<BiquadFilterNode | null>(null);
  const vocalNotch2Ref = useRef<BiquadFilterNode | null>(null);

  // Default OFF to prioritize reliable playback
  const [isEnabled, setIsEnabled] = useState(false);
  const [strength, setStrength] = useState(0.5); // Default 50%

  const isEnabledRef = useRef(false);
  const strengthRef = useRef(0.5);
  const connectedRef = useRef(false);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    isEnabledRef.current = isEnabled;
  }, [isEnabled]);

  useEffect(() => {
    strengthRef.current = strength;
  }, [strength]);

  const applyNodeParams = useCallback(
    (nextEnabled: boolean, nextStrength: number) => {
      const ctx = audioContextRef.current;
      if (!ctx) return;

      const now = ctx.currentTime;

      if (nextEnabled) {
        // Dry/wet crossfade: always keep some dry signal
        // At 100% strength: 40% dry, 60% wet (never fully silent)
        // At 20% strength: 80% dry, 20% wet
        const wetLevel = nextStrength * 0.6;
        const dryLevel = 1 - (nextStrength * 0.6);
        
        if (dryGainRef.current) {
          dryGainRef.current.gain.setTargetAtTime(dryLevel, now, 0.05);
        }
        if (wetGainRef.current) {
          wetGainRef.current.gain.setTargetAtTime(wetLevel, now, 0.05);
        }
        
        // Phase cancellation for wet signal (fixed at high value)
        if (invertGain1Ref.current && invertGain2Ref.current) {
          invertGain1Ref.current.gain.setTargetAtTime(-0.95, now, 0.05);
          invertGain2Ref.current.gain.setTargetAtTime(-0.95, now, 0.05);
        }

        // Apply vocal notch filters based on strength
        if (lowShelfRef.current) {
          lowShelfRef.current.gain.setTargetAtTime(nextStrength * 6, now, 0.05);
        }
        if (highShelfRef.current) {
          highShelfRef.current.gain.setTargetAtTime(nextStrength * 4, now, 0.05);
        }
        if (vocalNotch1Ref.current) {
          vocalNotch1Ref.current.gain.setTargetAtTime(-nextStrength * 8, now, 0.05);
        }
        if (vocalNotch2Ref.current) {
          vocalNotch2Ref.current.gain.setTargetAtTime(-nextStrength * 5, now, 0.05);
        }
      } else {
        // Disabled: full dry signal, no wet processing
        if (dryGainRef.current) {
          dryGainRef.current.gain.setTargetAtTime(1, now, 0.05);
        }
        if (wetGainRef.current) {
          wetGainRef.current.gain.setTargetAtTime(0, now, 0.05);
        }
        if (invertGain1Ref.current && invertGain2Ref.current) {
          invertGain1Ref.current.gain.setTargetAtTime(0, now, 0.05);
          invertGain2Ref.current.gain.setTargetAtTime(0, now, 0.05);
        }
        // Reset filters
        if (lowShelfRef.current) {
          lowShelfRef.current.gain.setTargetAtTime(0, now, 0.05);
        }
        if (highShelfRef.current) {
          highShelfRef.current.gain.setTargetAtTime(0, now, 0.05);
        }
        if (vocalNotch1Ref.current) {
          vocalNotch1Ref.current.gain.setTargetAtTime(0, now, 0.05);
        }
        if (vocalNotch2Ref.current) {
          vocalNotch2Ref.current.gain.setTargetAtTime(0, now, 0.05);
        }
      }
    },
    []
  );

  const setupVocalSuppression = useCallback(
    (audioElement: HTMLAudioElement) => {
      if (connectedRef.current) return;

      try {
        audioElementRef.current = audioElement;

        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
          latencyHint: 'playback',
        });
        audioContextRef.current = audioContext;

        // Check if audio element has crossOrigin set (required for CORS)
        // Note: crossOrigin can be "" (empty string) which is also valid
        if (audioElement.crossOrigin === null || audioElement.crossOrigin === undefined) {
          console.warn("[VocalSuppression] crossOrigin not set, skipping setup to preserve audio");
          return;
        }
        console.log("[VocalSuppression] Setting up with crossOrigin:", audioElement.crossOrigin);

        const source = audioContext.createMediaElementSource(audioElement);
        sourceNodeRef.current = source;

        // === DRY PATH: Original audio passes through ===
        const dryGain = audioContext.createGain();
        dryGain.gain.value = 1;
        dryGainRef.current = dryGain;

        // === WET PATH: Phase-cancelled audio ===
        const wetGain = audioContext.createGain();
        wetGain.gain.value = 0;
        wetGainRef.current = wetGain;

        const splitter = audioContext.createChannelSplitter(2);
        splitterRef.current = splitter;

        const merger = audioContext.createChannelMerger(2);
        mergerRef.current = merger;

        const invertGain1 = audioContext.createGain();
        invertGain1.gain.value = 0;
        invertGain1Ref.current = invertGain1;

        const invertGain2 = audioContext.createGain();
        invertGain2.gain.value = 0;
        invertGain2Ref.current = invertGain2;

        // Frequency filters for wet path
        const lowShelf = audioContext.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = 200;
        lowShelf.gain.value = 0;
        lowShelfRef.current = lowShelf;

        const highShelf = audioContext.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 6000;
        highShelf.gain.value = 0;
        highShelfRef.current = highShelf;

        const vocalNotch1 = audioContext.createBiquadFilter();
        vocalNotch1.type = 'peaking';
        vocalNotch1.frequency.value = 1200;
        vocalNotch1.Q.value = 1.5;
        vocalNotch1.gain.value = 0;
        vocalNotch1Ref.current = vocalNotch1;

        const vocalNotch2 = audioContext.createBiquadFilter();
        vocalNotch2.type = 'peaking';
        vocalNotch2.frequency.value = 3000;
        vocalNotch2.Q.value = 1.2;
        vocalNotch2.gain.value = 0;
        vocalNotch2Ref.current = vocalNotch2;

        // Final mixer
        const finalMixer = audioContext.createGain();
        finalMixer.gain.value = 1;
        finalMixerRef.current = finalMixer;

        // === ROUTING ===
        // Source splits to dry and wet paths
        source.connect(dryGain);
        source.connect(splitter);

        // Wet path: stereo phase cancellation
        // Left = L - R, Right = R - L
        splitter.connect(merger, 0, 0); // L -> Left
        splitter.connect(invertGain1, 1); // R -> inverter
        invertGain1.connect(merger, 0, 0); // -R -> Left

        splitter.connect(merger, 1, 1); // R -> Right
        splitter.connect(invertGain2, 0); // L -> inverter
        invertGain2.connect(merger, 0, 1); // -L -> Right

        // Wet path through filters
        merger.connect(lowShelf);
        lowShelf.connect(highShelf);
        highShelf.connect(vocalNotch1);
        vocalNotch1.connect(vocalNotch2);
        vocalNotch2.connect(wetGain);

        // Mix dry + wet
        dryGain.connect(finalMixer);
        wetGain.connect(finalMixer);
        finalMixer.connect(audioContext.destination);

        applyNodeParams(isEnabledRef.current, strengthRef.current);

        connectedRef.current = true;
        console.log("[VocalSuppression] Setup complete with dry/wet mixing");
      } catch (error) {
        console.error("[VocalSuppression] Failed to setup:", error);
        connectedRef.current = false;
      }
    },
    [applyNodeParams]
  );

  const updateStrength = useCallback(
    (newStrength: number) => {
      const clamped = Math.max(0.2, Math.min(1, newStrength));
      setStrength(clamped);
      strengthRef.current = clamped;
      applyNodeParams(isEnabledRef.current, clamped);
    },
    [applyNodeParams]
  );

  const toggleSuppression = useCallback(() => {
    const nextEnabled = !isEnabledRef.current;
    isEnabledRef.current = nextEnabled;
    setIsEnabled(nextEnabled);
    applyNodeParams(nextEnabled, strengthRef.current);
    console.log(`[VocalSuppression] ${nextEnabled ? 'Enabled' : 'Disabled'}`);
  }, [applyNodeParams]);

  const enable = useCallback(() => {
    if (!isEnabledRef.current) {
      isEnabledRef.current = true;
      setIsEnabled(true);
      applyNodeParams(true, strengthRef.current);
      console.log("[VocalSuppression] Enabled");
    }
  }, [applyNodeParams]);

  const disable = useCallback(() => {
    if (isEnabledRef.current) {
      isEnabledRef.current = false;
      setIsEnabled(false);
      applyNodeParams(false, strengthRef.current);
      console.log("[VocalSuppression] Disabled");
    }
  }, [applyNodeParams]);

  const cleanup = useCallback(() => {
    try {
      sourceNodeRef.current?.disconnect();
      splitterRef.current?.disconnect();
      mergerRef.current?.disconnect();
      invertGain1Ref.current?.disconnect();
      invertGain2Ref.current?.disconnect();
      dryGainRef.current?.disconnect();
      wetGainRef.current?.disconnect();
      finalMixerRef.current?.disconnect();
      lowShelfRef.current?.disconnect();
      highShelfRef.current?.disconnect();
      vocalNotch1Ref.current?.disconnect();
      vocalNotch2Ref.current?.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }

    audioContextRef.current = null;
    sourceNodeRef.current = null;
    splitterRef.current = null;
    mergerRef.current = null;
    invertGain1Ref.current = null;
    invertGain2Ref.current = null;
    dryGainRef.current = null;
    wetGainRef.current = null;
    finalMixerRef.current = null;
    lowShelfRef.current = null;
    highShelfRef.current = null;
    vocalNotch1Ref.current = null;
    vocalNotch2Ref.current = null;
    audioElementRef.current = null;
    connectedRef.current = false;
  }, []);

  const resumeContext = useCallback(async () => {
    if (audioContextRef.current?.state === "suspended") {
      try {
        await audioContextRef.current.resume();
        console.log("[VocalSuppression] Audio context resumed");
      } catch (error) {
        console.error("[VocalSuppression] Failed to resume audio context:", error);
      }
    }
  }, []);

  return {
    setupVocalSuppression,
    updateStrength,
    toggleSuppression,
    enable,
    disable,
    cleanup,
    resumeContext,
    isEnabled,
    strength,
    isConnected: connectedRef.current,
  };
}
