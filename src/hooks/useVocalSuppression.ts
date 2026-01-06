import { useRef, useCallback, useEffect, useState } from "react";

/**
 * Enhanced vocal suppression using Web Audio API with:
 * - Stereo phase cancellation (center-channel removal)
 * - Frequency filtering to protect bass and treble
 * - Vocal-range notch filtering for additional suppression
 */
export function useVocalSuppression() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const invertGain1Ref = useRef<GainNode | null>(null);
  const invertGain2Ref = useRef<GainNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  
  // Frequency filters for improved vocal isolation
  const lowShelfRef = useRef<BiquadFilterNode | null>(null);
  const highShelfRef = useRef<BiquadFilterNode | null>(null);
  const vocalNotch1Ref = useRef<BiquadFilterNode | null>(null);
  const vocalNotch2Ref = useRef<BiquadFilterNode | null>(null);
  const vocalNotch3Ref = useRef<BiquadFilterNode | null>(null);

  // Default OFF to prioritize reliable playback; user can enable suppression explicitly.
  const [isEnabled, setIsEnabled] = useState(false);
  const [strength, setStrength] = useState(0.85);

  // Keep stable refs so our callbacks don't change identity when state changes.
  const isEnabledRef = useRef(false);
  const strengthRef = useRef(0.85);
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
    const denom = Math.max(0.2, 1 - s);
    return Math.min(4, 1 / denom);
  }, []);

  const applyNodeParams = useCallback(
    (nextEnabled: boolean, nextStrength: number) => {
      const ctx = audioContextRef.current;
      if (!ctx) return;

      const now = ctx.currentTime;

      // Phase cancellation strength
      if (invertGain1Ref.current && invertGain2Ref.current) {
        const value = nextEnabled ? -nextStrength : 0;
        invertGain1Ref.current.gain.setTargetAtTime(value, now, 0.05);
        invertGain2Ref.current.gain.setTargetAtTime(value, now, 0.05);
      }

      // Makeup gain
      if (outputGainRef.current) {
        const gain = nextEnabled ? computeMakeupGain(nextStrength) : 1;
        outputGainRef.current.gain.setTargetAtTime(gain, now, 0.05);
      }

      // Apply frequency filters only when enabled
      if (nextEnabled) {
        // Boost bass preservation (vocals typically above 300Hz)
        if (lowShelfRef.current) {
          lowShelfRef.current.gain.setTargetAtTime(nextStrength * 6, now, 0.05);
        }
        
        // Boost treble preservation (vocals typically below 4kHz)
        if (highShelfRef.current) {
          highShelfRef.current.gain.setTargetAtTime(nextStrength * 4, now, 0.05);
        }

        // Apply vocal notch filters for additional suppression
        // Primary vocal presence ~1kHz-3kHz
        if (vocalNotch1Ref.current) {
          vocalNotch1Ref.current.gain.setTargetAtTime(-nextStrength * 6, now, 0.05);
        }
        // Secondary presence around 800Hz
        if (vocalNotch2Ref.current) {
          vocalNotch2Ref.current.gain.setTargetAtTime(-nextStrength * 4, now, 0.05);
        }
        // High vocal harmonics ~3.5kHz
        if (vocalNotch3Ref.current) {
          vocalNotch3Ref.current.gain.setTargetAtTime(-nextStrength * 3, now, 0.05);
        }
      } else {
        // Reset all filters to neutral
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
        if (vocalNotch3Ref.current) {
          vocalNotch3Ref.current.gain.setTargetAtTime(0, now, 0.05);
        }
      }
    },
    [computeMakeupGain]
  );

  const setupVocalSuppression = useCallback(
    (audioElement: HTMLAudioElement) => {
      if (connectedRef.current) return;

      try {
        audioElementRef.current = audioElement;

        // Create audio context with playback latency hint
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
          latencyHint: 'playback',
        });
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
        invertGain1Ref.current = invertGain1;

        const invertGain2 = audioContext.createGain();
        invertGain2Ref.current = invertGain2;

        // Create frequency filters
        // Low shelf to preserve bass frequencies
        const lowShelf = audioContext.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = 250;
        lowShelf.gain.value = 0;
        lowShelfRef.current = lowShelf;

        // High shelf to preserve treble frequencies
        const highShelf = audioContext.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 5000;
        highShelf.gain.value = 0;
        highShelfRef.current = highShelf;

        // Vocal notch filters targeting primary vocal frequencies
        // Main vocal presence ~1.5kHz
        const vocalNotch1 = audioContext.createBiquadFilter();
        vocalNotch1.type = 'peaking';
        vocalNotch1.frequency.value = 1500;
        vocalNotch1.Q.value = 1.5;
        vocalNotch1.gain.value = 0;
        vocalNotch1Ref.current = vocalNotch1;

        // Lower vocal fundamental ~800Hz
        const vocalNotch2 = audioContext.createBiquadFilter();
        vocalNotch2.type = 'peaking';
        vocalNotch2.frequency.value = 800;
        vocalNotch2.Q.value = 1.2;
        vocalNotch2.gain.value = 0;
        vocalNotch2Ref.current = vocalNotch2;

        // Vocal presence/clarity ~3.5kHz
        const vocalNotch3 = audioContext.createBiquadFilter();
        vocalNotch3.type = 'peaking';
        vocalNotch3.frequency.value = 3500;
        vocalNotch3.Q.value = 1.0;
        vocalNotch3.gain.value = 0;
        vocalNotch3Ref.current = vocalNotch3;

        // Output gain (makeup gain) to avoid near-silence on mono/dual-mono tracks
        const outputGain = audioContext.createGain();
        outputGainRef.current = outputGain;

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

        // Connect merger -> filters -> output
        merger.connect(lowShelf);
        lowShelf.connect(highShelf);
        highShelf.connect(vocalNotch1);
        vocalNotch1.connect(vocalNotch2);
        vocalNotch2.connect(vocalNotch3);
        vocalNotch3.connect(outputGain);
        outputGain.connect(audioContext.destination);

        // Apply initial params
        applyNodeParams(isEnabledRef.current, strengthRef.current);

        connectedRef.current = true;
        console.log("[VocalSuppression] Setup complete with frequency filtering");
      } catch (error) {
        console.error("[VocalSuppression] Failed to setup:", error);
        connectedRef.current = false;
      }
    },
    [applyNodeParams]
  );

  const updateStrength = useCallback(
    (newStrength: number) => {
      const clamped = Math.max(0, Math.min(1, newStrength));
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
      outputGainRef.current?.disconnect();
      lowShelfRef.current?.disconnect();
      highShelfRef.current?.disconnect();
      vocalNotch1Ref.current?.disconnect();
      vocalNotch2Ref.current?.disconnect();
      vocalNotch3Ref.current?.disconnect();
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
    outputGainRef.current = null;
    lowShelfRef.current = null;
    highShelfRef.current = null;
    vocalNotch1Ref.current = null;
    vocalNotch2Ref.current = null;
    vocalNotch3Ref.current = null;
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
