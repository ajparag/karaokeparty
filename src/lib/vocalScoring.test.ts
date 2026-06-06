import { describe, it, expect } from 'vitest';
import {
  rmsFloat,
  detectPitchAC,
  centsDiff,
  scorePitchFrame,
  applyMissPenalty,
  scoreRhythm,
  scoreTechnique,
  sineBuffer,
  PITCH_TOLERANCE_CENTS,
} from './vocalScoring';

const SR = 44100;
const N = 2048;

describe('rmsFloat', () => {
  it('is 0 for silence', () => {
    expect(rmsFloat(new Float32Array(N))).toBe(0);
  });
  it('matches 0.5/sqrt(2) for a full-scale 0.5-amplitude sine', () => {
    const buf = sineBuffer(440, SR, N, 0.5);
    const r = rmsFloat(buf);
    expect(r).toBeGreaterThan(0.34);
    expect(r).toBeLessThan(0.36);
  });
});

describe('detectPitchAC', () => {
  it('returns 0 for silence', () => {
    expect(detectPitchAC(new Float32Array(N), SR)).toBe(0);
  });
  it('detects 440 Hz within 5 Hz', () => {
    const hz = detectPitchAC(sineBuffer(440, SR, N, 0.5), SR);
    expect(Math.abs(hz - 440)).toBeLessThan(5);
  });
  it('detects 220 Hz within 5 Hz', () => {
    const hz = detectPitchAC(sineBuffer(220, SR, N, 0.5), SR);
    expect(Math.abs(hz - 220)).toBeLessThan(5);
  });
  it('detects 880 Hz within 10 Hz', () => {
    const hz = detectPitchAC(sineBuffer(880, SR, N, 0.5), SR);
    expect(Math.abs(hz - 880)).toBeLessThan(10);
  });
});

describe('centsDiff', () => {
  it('is 0 for identical pitches', () => {
    expect(centsDiff(440, 440)).toBe(0);
  });
  it('is ~100 cents for a semitone (440 → 466.16)', () => {
    expect(Math.abs(centsDiff(440, 466.16) - 100)).toBeLessThan(1);
  });
  it('is ~1200 cents for an octave', () => {
    expect(Math.abs(centsDiff(440, 880) - 1200)).toBeLessThan(0.001);
  });
  it('returns Infinity if either input is 0', () => {
    expect(centsDiff(0, 440)).toBe(Infinity);
    expect(centsDiff(440, 0)).toBe(Infinity);
  });
});

describe('scorePitchFrame', () => {
  it('returns 0 when user voice not detected', () => {
    expect(scorePitchFrame(440, 440, false)).toBe(0);
  });
  it('returns 100 for a perfect match', () => {
    expect(scorePitchFrame(440, 440, true)).toBe(100);
  });
  it('returns ~80 at the edge of tolerance (60 cents)', () => {
    const off = 440 * Math.pow(2, PITCH_TOLERANCE_CENTS / 1200);
    expect(scorePitchFrame(off, 440, true)).toBeCloseTo(80, 0);
  });
  it('drops into 40–80 band at ~90 cents off', () => {
    const off = 440 * Math.pow(2, 90 / 1200);
    const s = scorePitchFrame(off, 440, true);
    expect(s).toBeGreaterThan(40);
    expect(s).toBeLessThan(80);
  });
  it('returns 5 for a wildly off pitch (>4× tolerance)', () => {
    const off = 440 * Math.pow(2, 400 / 1200);
    expect(scorePitchFrame(off, 440, true)).toBe(5);
  });
});

describe('applyMissPenalty', () => {
  it('no penalty at 0% missed', () => {
    expect(applyMissPenalty(80, 0)).toBe(80);
  });
  it('50% penalty at 100% missed', () => {
    expect(applyMissPenalty(80, 1)).toBe(40);
  });
  it('25% penalty at 50% missed', () => {
    expect(applyMissPenalty(80, 0.5)).toBe(60);
  });
});

describe('scoreRhythm', () => {
  it('returns 50 with no reference data', () => {
    expect(scoreRhythm([100, 200], [])).toBe(50);
  });
  it('returns 0 when user never sang', () => {
    expect(scoreRhythm([], [100, 200, 300])).toBe(0);
  });
  it('returns 100 for perfect onset alignment', () => {
    const ref = [100, 500, 900, 1300];
    expect(scoreRhythm(ref.slice(), ref)).toBe(100);
  });
  it('drops to ~75 when every onset is at the tolerance edge', () => {
    const ref = [100, 500, 900, 1300];
    const user = ref.map((t) => t + 180);
    expect(scoreRhythm(user, ref)).toBeCloseTo(75, 0);
  });
  it('returns 0 when all onsets are well outside tolerance', () => {
    const ref = [100, 500, 900];
    const user = [10_000, 10_500, 10_900];
    expect(scoreRhythm(user, ref)).toBe(0);
  });
  it('applies extra-onset penalty for over-singing', () => {
    const ref = [100, 500, 900];
    const user = [100, 500, 900, 1500, 2000, 2500, 3000, 3500];
    const s = scoreRhythm(user, ref);
    expect(s).toBe(100 - 15); // capped 15-pt penalty
  });
});

describe('scoreTechnique', () => {
  it('returns 50 when not enough data', () => {
    expect(scoreTechnique([0.1, 0.1], [0.1, 0.1])).toBe(50);
  });
  it('scores ~100 when user sustains steadily through reference', () => {
    const u = new Array(60).fill(0.1);
    const r = new Array(60).fill(0.1);
    expect(scoreTechnique(u, r)).toBeGreaterThan(95);
  });
  it('scores low when user is mostly silent during reference', () => {
    const u = new Array(60).fill(0).map((_, i) => (i < 5 ? 0.1 : 0));
    const r = new Array(60).fill(0.1);
    expect(scoreTechnique(u, r)).toBeLessThan(50);
  });
  it('penalises jagged energy (poor breath control)', () => {
    const u = new Array(60).fill(0).map((_, i) => (i % 2 === 0 ? 0.2 : 0.01));
    const r = new Array(60).fill(0.1);
    const jagged = scoreTechnique(u, r);
    const smooth = scoreTechnique(new Array(60).fill(0.1), r);
    expect(jagged).toBeLessThan(smooth);
  });
});
