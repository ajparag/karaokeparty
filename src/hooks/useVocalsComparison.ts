// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (initial) — Basic real-time mic vs reference vocals comparison hook
//
// v2 — Fixed options object instability
//   - Stored options in optionsRef so callbacks don't re-create on every render
//   - initRefAnalysis now takes vocalsUrl as parameter (not from closure)
//
// v3 — Fixed 60fps seek bug (score always 0)
//   - Sync effect deps changed from [isPlaying, currentTime] to [isPlaying] only
//   - currentTime was updating 60x/sec, causing audio.currentTime to reset every
//     16ms, flushing decoded buffer → analyser always read silence → score = 0
//
// v4 — Fixed inverted scores (score rose when silent, dropped when singing)
//   - Hook audio was playing at outputGain=0.3 through speakers
//   - Mic (echoCancellation:false) was picking up reference vocals from speakers
//   - Fix: audio.volume=0, route analyser → keepAlive(0.00001) → destination
//   - Fix: setRefVolume() made no-op; audible vocals moved to Sing.tsx vocalsAudioRef
//   - Fix: echoCancellation enabled on all platforms in audioPermissions.ts
//
// v5 — Fixed audio.muted=true blocking Web Audio pipeline
//   - muted=true prevented Safari/Chrome from decoding through Web Audio graph
//   - Analyser always read silence → referenceActive=false → score=0
//   - Fix: removed audio.muted=true, kept audio.volume=0 only
//
// v6 — Fixed two AudioContext instances suspending on iOS
//   - initRefFromUrl was creating its own new AudioContext separately
//   - On iOS only one AudioContext can be active at a time; second stayed suspended
//   - Fix: reuse userAudioCtxRef singleton when available
//
// v7 — Fixed double-init of blob URL causing audio error (score=0)
//   - stopAnalysis was resetting refInitialisedUrlRef=null, causing startAnalysis
//     to call initRefFromUrl a second time on the same blob URL
//   - createMediaElementSource() already claimed the blob pipeline on first init
//   - Second element got audio error; analyser read silence forever → score=0
//   - Fix: never reset refInitialisedUrlRef in stopAnalysis
//   - Fix: keep entire ref audio graph alive through stop/start cycles
//
// v8 — CURRENT: Fixed audio player broken by premature AudioContext creation
//   - initRefFromUrl was creating its own new AudioContext when userAudioCtxRef=null
//   - On iOS/Chrome: an active AudioContext captures HTMLAudioElement output routing
//   - The main instrumental player (plain HTMLAudioElement) went silent because
//     the premature context intercepted its audio output pipeline
//   - Fix: initRefFromUrl now ONLY creates the Audio element and buffers it
//     (no AudioContext, no Web Audio graph)
//   - New connectRefAudioGraph() function handles Web Audio connection separately
//   - startAnalysis calls connectRefAudioGraph() after singleton ctx is ready
//   - This guarantees the main audio player is never affected
//   - startAnalysis was resetting refInitialisedUrlRef = null then calling
//     initRefFromUrl again for the same blob URL
//   - createMediaElementSource() already claimed the blob's decode pipeline
//     on the first init; second Audio element for same URL threw audio error
//   - analyser graph connected but produced silence → refVolume=0 → score=0
//   - Fix: removed the reset in startAnalysis; only init if not already done
//   - Diagnostic console logs added throughout for future debugging
// =============================================================================

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
  // no-op: hook audio is muted for analysis only.
  // Audible vocals volume is controlled by Sing.tsx's vocalsAudioRef.
  const setRefVolume = useCallback((_volume: number) => { /* no-op */ }, []);

  // ─── Connect user mic stream ───────────────────────────────────────────────
  const connectUserStream = useCallback((stream: MediaStream) => {
    const ctx = userAudioCtxRef.current;
    const analyser = userAnalyserRef.current;
    console.log('[MIC] connectUserStream: ctx=', ctx?.state ?? 'null', 'analyser=', !!analyser);
    if (!ctx || !analyser) {
      console.warn('[MIC] connectUserStream: missing ctx or analyser — not connected');
      return;
    }

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
  const initRefFromUrl = useCallback(async (vocalsUrl: string) => {
    if (refInitialisedUrlRef.current === vocalsUrl) return;
    refInitialisedUrlRef.current = vocalsUrl;

    console.log('[REF-AUDIO] Step 1: Creating audio element for', vocalsUrl.slice(0,40));
    try {
      // Tear down any previous ref audio element only
      if (refAudioElRef.current) {
        refAudioElRef.current.pause();
        refAudioElRef.current.src = '';
      }
      // Disconnect previous graph nodes if they exist
      try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
      try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
      try { refOutputGainRef.current?.disconnect(); } catch { /* ignore */ }
      refAnalyserRef.current = null;
      refOutputGainRef.current = null;
      refSourceRef.current = null;
      refAudioElRef.current = null;

      // Create audio element.
      // volume=0: analysis only — must never reach speakers.
      // Do NOT set muted=true: on Safari/Chrome it prevents Web Audio decoding,
      // making the analyser always read silence (score stays 0).
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = vocalsUrl;
      audio.preload = 'auto';
      audio.volume = 0;
      refAudioElRef.current = audio;
      console.log('[REF-AUDIO] Step 1 done: element created, readyState=', audio.readyState);

      // ── DO NOT create an AudioContext here. ──────────────────────────────
      // Creating a temporary AudioContext before startAnalysis runs
      // interferes with the main instrumental audio player on iOS and some
      // Chrome versions — the browser routes HTMLAudioElement output through
      // whichever Web Audio context is active, causing the player to go silent.
      //
      // Instead: buffer the audio element now, and connect it to the Web Audio
      // graph in connectRefAudioGraph() which is called by startAnalysis once
      // the singleton context is available.
      console.log('[REF-AUDIO] Step 3: Waiting for audio to buffer (no AudioContext yet)');
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 2) { resolve(); return; }
        audio.oncanplay = () => {
          console.log('[REF-AUDIO] Step 3: canplay fired, readyState=', audio.readyState);
          resolve();
        };
        audio.onerror = (e) => {
          console.error('[REF-AUDIO] Step 3: audio error', e);
          refInitialisedUrlRef.current = null; // allow retry
          resolve();
        };
        setTimeout(() => {
          console.warn('[REF-AUDIO] Step 3: timeout, readyState=', audio.readyState);
          resolve();
        }, 4000);
        audio.load();
      });
      console.log('[REF-AUDIO] Step 3 done: readyState=', audio.readyState);

      // If startAnalysis has already run and ctx is available, connect now
      if (userAudioCtxRef.current && userAudioCtxRef.current.state !== 'closed') {
        connectRefAudioGraph(audio, userAudioCtxRef.current);
      } else {
        console.log('[REF-AUDIO] Deferring graph connection until startAnalysis provides ctx');
      }

    } catch (e) {
      refInitialisedUrlRef.current = null;
      console.error('[REF-AUDIO] Failed to init ref audio:', e);
    }
  }, []);

  // ─── Connect ref audio element to Web Audio graph ─────────────────────────
  // Called either at end of initRefFromUrl (if ctx already exists) or
  // at start of startAnalysis (after ctx is created).
  // Separated from initRefFromUrl so we never create a ctx prematurely.
  const connectRefAudioGraph = useCallback((
    audio: HTMLAudioElement,
    ctx: AudioContext
  ) => {
    try {
      // Disconnect previous nodes if any
      try { refSourceRef.current?.disconnect(); } catch { /* ignore */ }
      try { refAnalyserRef.current?.disconnect(); } catch { /* ignore */ }
      try { refOutputGainRef.current?.disconnect(); } catch { /* ignore */ }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;
      refAnalyserRef.current = analyser;

      // ANALYSIS-ONLY routing: source → analyser → keepAlive(~0) → destination
      // keepAlive is near-zero so nothing audible reaches speakers.
      const keepAlive = ctx.createGain();
      keepAlive.gain.value = 0.00001;
      refOutputGainRef.current = keepAlive;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(keepAlive);
      keepAlive.connect(ctx.destination);
      refSourceRef.current = source;
      refAudioCtxRef.current = ctx;

      // Start playing if we should be
      if (optionsRef.current.isPlaying) {
        audio.currentTime = optionsRef.current.currentTime ?? 0;
        audio.play()
          .then(() => console.log('[REF-AUDIO] Step 5: play() succeeded'))
          .catch(e => console.error('[REF-AUDIO] Step 5: play() failed', e));
      }
      console.log('[REF-AUDIO] Step 4 done: graph connected, ctx state=', ctx.state);
    } catch (e) {
      console.error('[REF-AUDIO] connectRefAudioGraph failed:', e);
    }
  }, []);

  // ─── Watch vocalsUrl──────
  useEffect(() => {
    const url = options.vocalsUrl;
    console.log('[HOOK] watchVocalsUrl fired: url=', url ? url.slice(0,40) : 'null',
      'alreadyInit=', refInitialisedUrlRef.current === url,
      'ctxReady=', !!userAudioCtxRef.current);
    if (!url) return;
    if (refInitialisedUrlRef.current === url) return;
    // initRefFromUrl creates the audio element and buffers it.
    // If ctx is already available (startAnalysis ran first), it also connects
    // the graph inside initRefFromUrl. Otherwise deferred to startAnalysis.
    initRefFromUrl(url);
  }, [options.vocalsUrl, initRefFromUrl]);

  // ─── Sync ref audio playback with main player ─────────────────────────────
  // Depends on isPlaying ONLY — not currentTime.
  // currentTime updates 60x/sec via rAF; including it would call audio.play()
  // 60x/sec which can interfere with the Web Audio analyser on some browsers.
  // We seek once at play-start then let both elements run freely in sync.
  const lastIsPlayingRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const audio = refAudioElRef.current;
    console.log('[HOOK] syncPlay fired: isPlaying=', options.isPlaying,
      'audioExists=', !!audio, 'changed=', options.isPlaying !== lastIsPlayingRef.current);
    if (!audio) return;
    if (options.isPlaying === lastIsPlayingRef.current) return;
    lastIsPlayingRef.current = options.isPlaying;
    if (options.isPlaying) {
      audio.currentTime = optionsRef.current.currentTime ?? 0;
      audio.play()
        .then(() => console.log('[HOOK] syncPlay: ref audio play() ok'))
        .catch(e => console.error('[HOOK] syncPlay: ref audio play() failed', e));
    } else {
      audio.pause();
      console.log('[HOOK] syncPlay: ref audio paused');
    }
  }, [options.isPlaying]);

  // ─── Main analysis loop ────────────────────────────────────────────────────
  const startAnalysis = useCallback(async () => {
    console.log('[vocals-comparison] startAnalysis called');
    try {
      setError(null);
      didFallbackRef.current = false;
      lowSignalFramesRef.current = 0;

      console.log('[MIC] Requesting microphone...');
      const stream = await requestMicrophone();
      userStreamRef.current = stream;
      setHasPermission(true);
      console.log('[MIC] Granted:', stream.getAudioTracks()[0]?.label);
      console.log('[MIC] Creating AudioContext...');
      const ctx = await createAudioContext();
      userAudioCtxRef.current = ctx;
      console.log('[MIC] AudioContext ready: state=', ctx.state, 'sampleRate=', ctx.sampleRate);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -120;
      analyser.maxDecibels = -10;
      userAnalyserRef.current = analyser;

      connectUserStream(stream);

      const url = optionsRef.current.vocalsUrl;
      console.log('[HOOK] startAnalysis: vocalsUrl=', url ? url.slice(0,40) : 'null',
        'alreadyInit=', !!refInitialisedUrlRef.current,
        'refElExists=', !!refAudioElRef.current,
        'refAnalyserOk=', !!refAnalyserRef.current);

      // Step 1: ensure the audio element exists and is buffered
      if (url && !refInitialisedUrlRef.current) {
        // Not yet initialised — create element and buffer audio (no ctx created)
        await initRefFromUrl(url);
      }

      // Step 2: connect element to Web Audio graph using the singleton ctx.
      // initRefFromUrl defers graph connection if ctx wasn't ready yet.
      // We do it here now that ctx is guaranteed running.
      if (refAudioElRef.current && !refAnalyserRef.current) {
        // Element exists but graph not yet connected — connect now
        console.log('[HOOK] startAnalysis: connecting ref graph to singleton ctx');
        connectRefAudioGraph(refAudioElRef.current, ctx);
      } else if (refAudioElRef.current && refAnalyserRef.current) {
        // Graph already connected (stop/start cycle) — just play
        console.log('[HOOK] startAnalysis: ref graph already connected, resuming play');
        if (optionsRef.current.isPlaying) {
          refAudioElRef.current.currentTime = optionsRef.current.currentTime ?? 0;
          refAudioElRef.current.play()
            .then(() => console.log('[HOOK] startAnalysis: ref play() ok'))
            .catch(e => console.warn('[HOOK] startAnalysis: ref play() failed', e));
        }
      } else {
        console.warn('[HOOK] startAnalysis: no ref audio element — will connect when vocalsUrl arrives');
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
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

        // Every 60 frames, log diagnostic info
        frameCount++;
        if (frameCount % 60 === 0) {
          // Log if ref analyser is missing
          if (!refAnalyserRef.current) {
            console.warn('[REF-AUDIO] WARNING: refAnalyserRef is NULL - ref audio not set up');
          }
          if (refAnalyserRef.current && refVolume === 0) {
            console.warn('[REF-AUDIO] WARNING: refAnalyser exists but refVolume=0 - audio not playing or silent');
          }
          console.log('[SCORE]', {
            userVol: userVolume.toFixed(4),
            voiceDetected: isVoiceDetected,
            userPitch: userPitch.toFixed(1),
            refPitch: refPitch.toFixed(1),
            refActive: referenceActive,
            refVol: refVolume.toFixed(4),
            pitchFrames: pitchFramesRef.current,
            missedFrames: missedFramesRef.current,
            pitch: smoothPitchRef.current.toFixed(1),
            rhythm: smoothRhythmRef.current.toFixed(1),
            tech: smoothTechRef.current.toFixed(1),
            refAnalyserOk: !!refAnalyserRef.current,
            refCtxState: refAudioCtxRef.current?.state ?? 'null',
            userCtxState: userAudioCtxRef.current?.state ?? 'null',
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

    // Pause ref audio but KEEP the entire Web Audio graph intact.
    // The ref AudioContext, analyser, source, and audio element must all survive
    // stop/start cycles. Here is why:
    //
    // createMediaElementSource() permanently claims the blob URL's decode pipeline.
    // If we destroy the element (src='') or close the AudioContext and then
    // try to create a new element for the same blob URL, the new element gets
    // an audio error and the analyser reads silence forever (score stays 0).
    //
    // By keeping everything alive, startAnalysis just calls play() on the
    // existing element — no re-init, no error, analyser keeps reading signal.
    if (refAudioElRef.current) {
      refAudioElRef.current.pause();
      console.log('[HOOK] stopAnalysis: ref audio paused (graph kept intact)');
    }
    // Do NOT close refAudioCtxRef — that breaks the analyser graph.
    // Do NOT disconnect refSourceRef/refAnalyserRef — same reason.
    // Do NOT null out any ref audio refs.
    // Do NOT reset refInitialisedUrlRef — prevents double-init on next startAnalysis.

    setIsActive(false);
    console.log('[HOOK] Analysis stopped. Final: pitchFrames=',
      pitchFramesRef.current, 'missedFrames=', missedFramesRef.current,
      'pitch=', smoothPitchRef.current.toFixed(1),
      'rhythm=', smoothRhythmRef.current.toFixed(1),
      'tech=', smoothTechRef.current.toFixed(1));
  }, []);

  // ─── Reset ─────────────────────────────────────────────────────────────────
  const resetScores = useCallback(() => {
    console.log('[HOOK] resetScores called');
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
