import { useState, useRef, useCallback, useEffect } from 'react';
import {
  cleanupAudio,
  createAudioContext,
  formatMicrophoneError,
  requestMicrophone,
} from '@/lib/audioPermissions';
import {
  detectPitchAC,
  rmsFloat,
  dbEnergy,
  clamp100,
  scoreRhythm,
  scoreTechnique,
  scorePitchFrame,
  SILENCE_RMS,
  ONSET_WINDOW_MS,
} from '@/lib/vocalScoring';

export interface VocalsComparisonMetrics {
  pitchMatch: number;
  rhythmMatch: number;
  techniqueMatch: number;
  volume: number;
  isVoiceDetected: boolean;
  referenceActive: boolean;
  debug?: {
    voiceThreshold: number;
    noiseFloor: number;
    audioCtxState: AudioContextState | 'unknown';
    micFallback: boolean;
    userVolumeRmsFloat: number;
    userFreqEnergyDb: number;
  };
}

interface UseVocalsComparisonOptions {
  /** URL of the separated vocals track to analyse against */
  vocalsUrl?: string;
  currentTime?: number;
  isPlaying?: boolean;
  onMetricsUpdate?: (metrics: VocalsComparisonMetrics) => void;
}

const FFT_SIZE = 2048;
const HISTORY_FRAMES = 60;

// EMA alpha for the pitch tracker (~30-frame memory window).
// High enough to respond quickly to improvement; low enough to smooth jitter.
const PITCH_EMA_ALPHA = 0.065;

// EMA alpha for the display layer (UI smoothing only, no scoring impact).
const DISPLAY_ALPHA = 0.08;

// Tolerance for amateur-friendly scoring (semitone = 100 cents; we allow 1.5 semitones)
const PITCH_TOLERANCE_CENTS = 150; // was 60 — much more forgiving for amateurs

export function useVocalsComparison(options: UseVocalsComparisonOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalsComparisonMetrics>({
    pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
    volume: 0, isVoiceDetected: false, referenceActive: false,
  });

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ── User mic refs ──────────────────────────────────────────────────────────
  const userAudioCtxRef = useRef<AudioContext | null>(null);
  const userAnalyserRef = useRef<AnalyserNode | null>(null);
  const userGainRef = useRef<GainNode | null>(null);
  const userKeepAliveRef = useRef<GainNode | null>(null);
  const userSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const userStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const didFallbackRef = useRef(false);
  const lowSignalFramesRef = useRef(0);
  const noiseFloorRef = useRef(0.0015);

  // ── Reference vocals refs ──────────────────────────────────────────────────
  // The hook owns its own Audio element for the vocals track.
  // Routing: element → refSource → refAnalyser → refOutputGain → destination
  // refOutputGain controls what the user HEARS (volume slider).
  // refAnalyser is before the gain, so it always sees the full signal.
  const refAudioCtxRef = useRef<AudioContext | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);
  const refOutputGainRef = useRef<GainNode | null>(null); // user-facing volume
  const refSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refAudioElRef = useRef<HTMLAudioElement | null>(null);
  const refInitialisedUrlRef = useRef<string | null>(null); // prevents double-init

  // ── Scoring state ──────────────────────────────────────────────────────────
  // Pitch uses an EMA so early cold/warm-up frames cannot permanently drag the
  // score down (the key fix over the cumulative-average approach).
  const pitchEmaRef = useRef<number | null>(null);
  const warmupFramesRef = useRef(0);

  // Onsets stored as song-relative seconds (currentTime) so user and ref are
  // on the same timeline and scoreRhythm comparisons are meaningful.
  const userOnsetsRef = useRef<number[]>([]);
  const refOnsetsRef = useRef<number[]>([]);
  const lastUserOnsetRef = useRef(0);
  const lastRefOnsetRef = useRef(0);
  const userEnergyHistRef = useRef<number[]>([]);
  const refEnergyHistRef = useRef<number[]>([]);

  // Display-level EMA — smooths UI jitter only, no scoring impact
  const smoothPitchRef = useRef(0);
  const smoothRhythmRef = useRef(0);
  const smoothTechRef = useRef(0);

  const prevUserSilentRef = useRef(true);
  const prevRefSilentRef = useRef(true);

  // ─── setRefVolume: let Sing.tsx control the vocals playback volume ─────────
  // Call this whenever vocalsVolume or vocalsEnabled changes.
  // volume: 0.0 – 1.0 linear
  const setRefVolume = useCallback((volume: number) => {
    if (refOutputGainRef.current) {
      refOutputGainRef.current.gain.value = Math.max(0, Math.min(1, volume));
    }
    // Also update the element volume in case Web Audio isn't connected yet
    if (refAudioElRef.current) {
      refAudioElRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, []);

  // ─── Connect user mic stream ───────────────────────────────────────────────
  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    if (!ctx || !analyser) return;

    try { userSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { userGainRef.current?.disconnect(); } catch { /* ignore */ }

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 10;
    source.connect(gain);
    gain.connect(analyser);

    if (!userKeepAliveRef.current) {
      userKeepAliveRef.current = ctx.createGain();
      userKeepAliveRef.current.gain.value = 0.00001;
    }
    try { analyser.disconnect(); } catch { /* ignore */ }
    analyser.connect(userKeepAliveRef.current);
    userKeepAliveRef.current.connect(ctx.destination);

    userSourceRef.current = source;
    userGainRef.current = gain;
  }, []);

  // ─── Init reference vocals from URL ───────────────────────────────────────
  // This is the ONLY way reference audio is connected — via vocalsUrl.
  // The hook owns the Audio element so it controls the full Web Audio graph:
  //   element → source → analyser → outputGain → destination
  //
  // outputGain starts at 0.3 (30%) and is updated via setRefVolume().
  // The analyser is BEFORE outputGain, so it always sees the full signal
  // regardless of the user's volume setting — referenceActive works correctly.
  const initRefFromUrl = useCallback(async (vocalsUrl: string) => {
    if (refInitialisedUrlRef.current === vocalsUrl) return; // already done
    refInitialisedUrlRef.current = vocalsUrl;

    try {
      // Tear down previous ref context if any
      if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
        try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
        try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
        try { refOutputGainRef.current?.disconnect(); } catch { /* ignore */ }
        await refAudioCtxRef.current.close();
      }
      if (refAudioElRef.current) {
        refAudioElRef.current.pause();
        refAudioElRef.current.src = '';
      }
      refAudioCtxRef.current = null;
      refAnalyserRef.current = null;
      refOutputGainRef.current = null;
      refSourceRef.current = null;
      refAudioElRef.current = null;

      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.preload = 'auto';
      // Don't set audio.volume here — it will be controlled via outputGain in Web Audio.
      // We set it to 1.0 so the full signal enters the Web Audio graph.
      audio.volume = 1.0;
      refAudioElRef.current = audio;

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') {
        for (let i = 0; i < 3; i++) {
          await ctx.resume();
          if (ctx.state === 'running') break;
          await new Promise(r => setTimeout(r, 150 * (i + 1)));
        }
      }
      refAudioCtxRef.current = ctx;

      // Wait for enough data to be buffered
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 2) { resolve(); return; }
        audio.oncanplay = () => resolve();
        audio.onerror = () => resolve();
        setTimeout(resolve, 4000);
        audio.load();
      });

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      // outputGain: this is what the user hears, controlled by setRefVolume()
      const outputGain = ctx.createGain();
      outputGain.gain.value = 0.3; // default 30%
      refOutputGainRef.current = outputGain;

      const source = ctx.createMediaElementSource(audio);
      // Routing: source → analyser → outputGain → destination
      // Analyser is BEFORE the output gain so it reads the full unattenuated signal.
      source.connect(analyser);
      analyser.connect(outputGain);
      outputGain.connect(ctx.destination);
      refSourceRef.current = source;

      // If we were already playing, start the ref audio now
      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play().catch(() => {});
      }

      console.log('[vocals-comparison] Ref audio URL initialised, Web Audio graph connected');
    } catch (e) {
      refInitialisedUrlRef.current = null; // allow retry
      console.error('[vocals-comparison] Failed to init ref from URL:', e);
    }
  }, []);

  // ─── Watch vocalsUrl and connect when it arrives ───────────────────────────
  useEffect(() => {
    const url = options.vocalsUrl;
    if (!url) return;
    if (refInitialisedUrlRef.current === url) return;
    initRefFromUrl(url);
  }, [options.vocalsUrl, initRefFromUrl]);

  // ─── Sync ref audio playback with main player ─────────────────────────────
  useEffect(() => {
    const audio = refAudioElRef.current;
    if (!audio) return;

    if (options.isPlaying) {
      // Sync time to within 0.3s tolerance before playing
      const target = options.currentTime ?? 0;
      if (Math.abs(audio.currentTime - target) > 0.3) {
        audio.currentTime = target;
      }
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [options.isPlaying, options.currentTime]);

  // ─── Main analysis loop ────────────────────────────────────────────────────
  const startAnalysis = useCallback(async () => {
    console.log('[vocals-comparison] startAnalysis called');
    try {
      setError(null);
      didFallbackRef.current = false;
      lowSignalFramesRef.current = 0;

      const stream = await requestMicrophone();
      userStreamRef.current = stream;
      setHasPermission(true);

      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -120;
      analyser.maxDecibels = -10;
      userAnalyserRef.current = analyser;

      connectUserStream(stream);

      // Init ref audio if URL is already available
      const url = optionsRef.current.vocalsUrl;
      if (url) {
        await initRefFromUrl(url);
      }

      const freqByte = new Uint8Array(analyser.frequencyBinCount);
      const timeFloat = new Float32Array(analyser.fftSize);
      const freqDb = new Float32Array(analyser.frequencyBinCount);
      let frameCount = 0;

      const analyze = () => {
        if (!userAnalyserRef.current || !userAudioCtxRef.current) return;

        userAnalyserRef.current.getByteFrequencyData(freqByte);
        userAnalyserRef.current.getFloatTimeDomainData(timeFloat);
        userAnalyserRef.current.getFloatFrequencyData(freqDb);

        const userRms = rmsFloat(timeFloat);
        const userDbE = dbEnergy(freqDb);
        const userVolume = Math.max(userRms, userDbE * 0.4);

        if (Number.isFinite(userVolume)) {
          const nf = noiseFloorRef.current;
          const candidate = userVolume < 0.03 ? userVolume : nf;
          noiseFloorRef.current = nf * 0.98 + candidate * 0.02;
        }
        const voiceThreshold = Math.max(0.005, noiseFloorRef.current * 4);
        const isVoiceDetected = userVolume > voiceThreshold;
        const userPitch = detectPitchAC(timeFloat, userAudioCtxRef.current.sampleRate);

        // Mic fallback for persistent low signal
        if (!didFallbackRef.current) {
          if (userVolume < voiceThreshold * 0.6) lowSignalFramesRef.current++;
          else lowSignalFramesRef.current = 0;
          if (lowSignalFramesRef.current > 120) {
            didFallbackRef.current = true;
            lowSignalFramesRef.current = 0;
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            }).then(raw => {
              userStreamRef.current?.getTracks().forEach(t => t.stop());
              userStreamRef.current = raw;
              connectUserStream(raw);
            }).catch(() => {});
          }
        }

        userEnergyHistRef.current.push(userRms);
        if (userEnergyHistRef.current.length > HISTORY_FRAMES * 5) userEnergyHistRef.current.shift();

        const userIsSilent = userVolume <= voiceThreshold;
        if (prevUserSilentRef.current && !userIsSilent) {
          const songTime = optionsRef.current.currentTime ?? 0;
          if (songTime - lastUserOnsetRef.current > 0.1) {
            userOnsetsRef.current.push(songTime);
            lastUserOnsetRef.current = songTime;
            if (userOnsetsRef.current.length > 200) userOnsetsRef.current.shift();
          }
        }
        prevUserSilentRef.current = userIsSilent;

        // ── Reference vocals readings ────────────────────────────────────────
        // The analyser is before the output gain in the graph, so it reads the
        // full-amplitude signal from the vocals track regardless of volume setting.
        let refPitch = 0;
        let refVolume = 0;
        let referenceActive = false;

        if (refAnalyserRef.current && refAudioCtxRef.current) {
          const refTimeFloat = new Float32Array(refAnalyserRef.current.fftSize);
          refAnalyserRef.current.getFloatTimeDomainData(refTimeFloat);
          refVolume = rmsFloat(refTimeFloat);
          referenceActive = refVolume > SILENCE_RMS;

          if (referenceActive) {
            refPitch = detectPitchAC(refTimeFloat, refAudioCtxRef.current.sampleRate);
          }

          refEnergyHistRef.current.push(refVolume);
          if (refEnergyHistRef.current.length > HISTORY_FRAMES * 5) refEnergyHistRef.current.shift();

          const refIsSilent = refVolume <= SILENCE_RMS;
          if (prevRefSilentRef.current && !refIsSilent) {
            const songTime = optionsRef.current.currentTime ?? 0;
            if (songTime - lastRefOnsetRef.current > 0.1) {
              refOnsetsRef.current.push(songTime);
              lastRefOnsetRef.current = songTime;
              if (refOnsetsRef.current.length > 200) refOnsetsRef.current.shift();
            }
          }
          prevRefSilentRef.current = refIsSilent;
        }

        // ── Per-frame pitch scoring with EMA ────────────────────────────────
        // EMA reflects CURRENT performance (~30-frame window), not a cumulative
        // average from frame 0. Early warm-up frames are skipped entirely.
        // Missed frames do NOT update the EMA (score holds, not drops).
        if (referenceActive) {
          warmupFramesRef.current++;
          if (warmupFramesRef.current > 15) {
            let frameScore: number | null = null;

            if (!isVoiceDetected) {
              // User is silent during reference phrase — penalise
              frameScore = 0;
            } else if (refPitch > 0 && userPitch > 0) {
              // Both voices pitched — score the match with amateur-friendly tolerance
              frameScore = scorePitchFrameAmateur(userPitch, refPitch);
            } else if (refPitch === 0 && isVoiceDetected) {
              // Reference unpitched but user sings — near-neutral
              frameScore = 60;
            } else if (refPitch > 0 && userPitch === 0) {
              // Reference pitched, user pitch undetected — partial credit
              // (may be singing quietly or pitch detection failed)
              frameScore = 40;
            }

            if (frameScore !== null) {
              if (pitchEmaRef.current === null) {
                pitchEmaRef.current = frameScore;
              } else {
                pitchEmaRef.current =
                  pitchEmaRef.current * (1 - PITCH_EMA_ALPHA) +
                  frameScore * PITCH_EMA_ALPHA;
              }
            }
          }
        }

        const pitchFinal = pitchEmaRef.current ?? 0;

        const rawRhythm = scoreRhythm(userOnsetsRef.current, refOnsetsRef.current, ONSET_WINDOW_MS);
        const rawTech = scoreTechnique(userEnergyHistRef.current, refEnergyHistRef.current, SILENCE_RMS);

        smoothPitchRef.current = smoothPitchRef.current * (1 - DISPLAY_ALPHA) + pitchFinal * DISPLAY_ALPHA;
        smoothRhythmRef.current = smoothRhythmRef.current * (1 - DISPLAY_ALPHA) + rawRhythm * DISPLAY_ALPHA;
        smoothTechRef.current = smoothTechRef.current * (1 - DISPLAY_ALPHA) + rawTech * DISPLAY_ALPHA;

        frameCount++;
        if (frameCount % 60 === 0) {
          console.log('[vocals-comparison]', {
            userVol: userVolume.toFixed(4),
            voiceDetected: isVoiceDetected,
            userPitch: userPitch.toFixed(1),
            refPitch: refPitch.toFixed(1),
            refActive: referenceActive,
            refVol: refVolume.toFixed(4),
            pitchEma: (pitchEmaRef.current ?? 0).toFixed(1),
            pitch: smoothPitchRef.current.toFixed(1),
            rhythm: smoothRhythmRef.current.toFixed(1),
            tech: smoothTechRef.current.toFixed(1),
          });
        }

        const newMetrics: VocalsComparisonMetrics = {
          pitchMatch: clamp100(Math.round(smoothPitchRef.current)),
          rhythmMatch: clamp100(Math.round(smoothRhythmRef.current)),
          techniqueMatch: clamp100(Math.round(smoothTechRef.current)),
          volume: userVolume,
          isVoiceDetected,
          referenceActive,
          debug: {
            voiceThreshold,
            noiseFloor: noiseFloorRef.current,
            audioCtxState: userAudioCtxRef.current?.state ?? 'unknown',
            micFallback: didFallbackRef.current,
            userVolumeRmsFloat: userRms,
            userFreqEnergyDb: userDbE,
          },
        };

        setMetrics(newMetrics);
        optionsRef.current.onMetricsUpdate?.(newMetrics);

        rafRef.current = requestAnimationFrame(analyze);
      };

      setIsActive(true);
      analyze();
      console.log('[vocals-comparison] Analysis started');

    } catch (err) {
      console.error('[vocals-comparison] Error:', err);
      setError(formatMicrophoneError(err));
      setHasPermission(false);
    }
  }, [connectUserStream, initRefFromUrl]);

  // ─── Stop ──────────────────────────────────────────────────────────────────
  const stopAnalysis = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    cleanupAudio(userStreamRef.current, userAudioCtxRef.current);
    userStreamRef.current = null;
    userAudioCtxRef.current = null;
    userAnalyserRef.current = null;
    userGainRef.current = null;
    userKeepAliveRef.current = null;
    userSourceRef.current = null;

    // Clean up ref audio
    try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
    try { refOutputGainRef.current?.disconnect(); } catch { /* ignore */ }
    if (refAudioCtxRef.current && refAudioCtxRef.current.state !== 'closed') {
      refAudioCtxRef.current.close().catch(() => {});
    }
    if (refAudioElRef.current) {
      refAudioElRef.current.pause();
      refAudioElRef.current.src = '';
    }
    refAudioCtxRef.current = null;
    refAnalyserRef.current = null;
    refOutputGainRef.current = null;
    refSourceRef.current = null;
    refAudioElRef.current = null;
    refInitialisedUrlRef.current = null;

    setIsActive(false);
    console.log('[vocals-comparison] Analysis stopped');
  }, []);

  // ─── Reset ─────────────────────────────────────────────────────────────────
  const resetScores = useCallback(() => {
    pitchEmaRef.current = null;
    warmupFramesRef.current = 0;
    userOnsetsRef.current = [];
    refOnsetsRef.current = [];
    userEnergyHistRef.current = [];
    refEnergyHistRef.current = [];
    smoothPitchRef.current = 0;
    smoothRhythmRef.current = 0;
    smoothTechRef.current = 0;
    prevUserSilentRef.current = true;
    prevRefSilentRef.current = true;
    lastUserOnsetRef.current = 0;
    lastRefOnsetRef.current = 0;
    setMetrics({
      pitchMatch: 0, rhythmMatch: 0, techniqueMatch: 0,
      volume: 0, isVoiceDetected: false, referenceActive: false,
    });
  }, []);

  useEffect(() => { return () => { stopAnalysis(); }; }, [stopAnalysis]);

  return { isActive, hasPermission, error, metrics, startAnalysis, stopAnalysis, resetScores, setRefVolume };
}

// ── Amateur-friendly pitch scoring ─────────────────────────────────────────
// Uses a wider tolerance (1.5 semitones = 150 cents vs the old 60 cents).
// Scoring bands are also more generous — a singer who is "in the ballpark"
// still gets a decent score rather than the minimum 5.
//
// Score breakdown:
//  0–150 cents off  → 80–100  (in the zone — reward clearly)
//  150–300 cents off → 50–80  (close-ish — still positive)
//  300–600 cents off → 20–50  (off but trying)
//  >600 cents off   → 10      (very wrong note, but not 0 — they're singing)
function scorePitchFrameAmateur(userHz: number, refHz: number): number {
  if (userHz <= 0 || refHz <= 0) return 40; // can't tell — give benefit of the doubt
  const cents = Math.abs(1200 * Math.log2(userHz / refHz));
  if (cents <= PITCH_TOLERANCE_CENTS) {
    return 100 - (cents / PITCH_TOLERANCE_CENTS) * 20; // 80..100
  }
  if (cents <= PITCH_TOLERANCE_CENTS * 2) {
    return 50 + (1 - (cents - PITCH_TOLERANCE_CENTS) / PITCH_TOLERANCE_CENTS) * 30; // 50..80
  }
  if (cents <= PITCH_TOLERANCE_CENTS * 4) {
    return 20 + (1 - (cents - PITCH_TOLERANCE_CENTS * 2) / (PITCH_TOLERANCE_CENTS * 2)) * 30; // 20..50
  }
  return 10; // very off — but they are singing, so not 0
}
