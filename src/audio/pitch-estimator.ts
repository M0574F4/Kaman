import type { InstrumentStringName, PitchFrame } from "./types";
import { DEFAULT_INSTRUMENT_STRINGS } from "../shared/instrument-profile";

export interface PitchEstimator {
  process(input: Float32Array, tMs: number): PitchFrame;
}

type EstimatorOptions = {
  minFreq: number;
  maxFreq: number;
  rmsThreshold: number;
  clarityThreshold: number;
};

const DEFAULT_OPTIONS: EstimatorOptions = {
  minFreq: 180,
  maxFreq: 2800,
  rmsThreshold: 0.008,
  clarityThreshold: 0.55,
};

export class AutoCorrelationPitchEstimator implements PitchEstimator {
  private readonly opts: EstimatorOptions;
  private stringPurityEnabled = false;

  constructor(
    private readonly sampleRate: number,
    options?: Partial<EstimatorOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  setStringPurityEnabled(enabled: boolean): void {
    this.stringPurityEnabled = enabled;
  }

  setRmsThreshold(rmsThreshold: number): void {
    this.opts.rmsThreshold = Math.max(0, rmsThreshold);
  }

  process(input: Float32Array, tMs: number): PitchFrame {
    const rms = rootMeanSquare(input);
    if (rms < this.opts.rmsThreshold) {
      return {
        tMs,
        freqHz: null,
        midiFloat: null,
        midi: null,
        cents: null,
        confidence: 0,
        stringPurity: null,
        adjacentBleedRatio: null,
        primaryString: null,
        bleedString: null,
      };
    }

    const minLag = Math.max(2, Math.floor(this.sampleRate / this.opts.maxFreq));
    const maxLag = Math.min(input.length - 2, Math.floor(this.sampleRate / this.opts.minFreq));

    let bestLag = -1;
    let bestScore = -1;
    const scores = new Float32Array(maxLag + 1);

    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let ac = 0;
      let e1 = 0;
      let e2 = 0;

      const end = input.length - lag;
      for (let i = 0; i < end; i += 1) {
        const x = input[i];
        const y = input[i + lag];
        ac += x * y;
        e1 += x * x;
        e2 += y * y;
      }

      const denom = Math.sqrt(e1 * e2) + 1e-12;
      const normalized = ac / denom;
      scores[lag] = normalized;

      if (normalized > bestScore) {
        bestScore = normalized;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestScore < this.opts.clarityThreshold) {
      return {
        tMs,
        freqHz: null,
        midiFloat: null,
        midi: null,
        cents: null,
        confidence: Math.max(0, bestScore),
        stringPurity: null,
        adjacentBleedRatio: null,
        primaryString: null,
        bleedString: null,
      };
    }

    const refinedLag = refineLagWithParabola(bestLag, scores);
    const freqHz = this.sampleRate / refinedLag;
    if (!Number.isFinite(freqHz) || freqHz <= 0) {
      return {
        tMs,
        freqHz: null,
        midiFloat: null,
        midi: null,
        cents: null,
        confidence: 0,
        stringPurity: null,
        adjacentBleedRatio: null,
        primaryString: null,
        bleedString: null,
      };
    }

    const midiFloat = 69 + 12 * Math.log2(freqHz / 440);
    const midi = Math.round(midiFloat);
    const cents = (midiFloat - midi) * 100;
    const contamination = this.stringPurityEnabled
      ? estimateAdjacentStringBleed(input, this.sampleRate, freqHz, this.opts.maxFreq)
      : null;

    return {
      tMs,
      freqHz,
      midiFloat,
      midi,
      cents,
      confidence: Math.max(0, Math.min(1, bestScore)),
      stringPurity: contamination?.purity ?? null,
      adjacentBleedRatio: contamination?.bleedRatio ?? null,
      primaryString: contamination?.primaryString ?? null,
      bleedString: contamination?.bleedString ?? null,
    };
  }
}

type OpenString = {
  id: InstrumentStringName;
  freqHz: number;
};

const OPEN_STRINGS: OpenString[] = DEFAULT_INSTRUMENT_STRINGS.map((string) => ({
  id: string.id,
  freqHz: string.openHz,
}));

type ContaminationMetrics = {
  purity: number;
  bleedRatio: number;
  primaryString: InstrumentStringName;
  bleedString: InstrumentStringName | null;
};

function estimateAdjacentStringBleed(
  buffer: Float32Array,
  sampleRate: number,
  detectedFreqHz: number,
  maxFreqHz: number,
): ContaminationMetrics {
  const primaryIndex = nearestOpenStringIndex(detectedFreqHz);
  const primary = OPEN_STRINGS[primaryIndex];
  const adjacentIndices = adjacentStringIndices(primaryIndex);

  const targetEnergy = harmonicSeriesEnergy(buffer, sampleRate, detectedFreqHz, 4, maxFreqHz);
  const adjacentEnergies = adjacentIndices.map((index) => ({
    index,
    energy: harmonicSeriesEnergy(buffer, sampleRate, OPEN_STRINGS[index].freqHz, 3, maxFreqHz),
  }));

  let strongestAdjacent = adjacentEnergies[0];
  for (const item of adjacentEnergies) {
    if (item.energy > strongestAdjacent.energy) {
      strongestAdjacent = item;
    }
  }

  const adjacentEnergy = strongestAdjacent?.energy ?? 0;
  const bleedRatio = adjacentEnergy / (targetEnergy + adjacentEnergy + 1e-9);
  const purity = clamp01(1 - bleedRatio * 1.25);
  const bleedString = OPEN_STRINGS[strongestAdjacent.index].id;

  return {
    purity,
    bleedRatio,
    primaryString: primary.id,
    bleedString,
  };
}

function harmonicSeriesEnergy(
  buffer: Float32Array,
  sampleRate: number,
  baseFreqHz: number,
  maxHarmonic: number,
  maxFreqHz: number,
): number {
  let energy = 0;
  for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
    const frequency = baseFreqHz * harmonic;
    if (frequency >= maxFreqHz) {
      break;
    }
    // Small frequency spread helps tolerate intonation drift.
    const low = goertzelPower(buffer, sampleRate, frequency * 0.985);
    const center = goertzelPower(buffer, sampleRate, frequency);
    const high = goertzelPower(buffer, sampleRate, frequency * 1.015);
    energy += (low + center + high) / harmonic;
  }
  return energy;
}

function goertzelPower(buffer: Float32Array, sampleRate: number, frequency: number): number {
  const normalized = frequency / sampleRate;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized >= 0.5) {
    return 0;
  }

  const omega = 2 * Math.PI * normalized;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < buffer.length; i += 1) {
    s0 = buffer[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function nearestOpenStringIndex(freqHz: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < OPEN_STRINGS.length; i += 1) {
    const distance = Math.abs(Math.log2(freqHz / OPEN_STRINGS[i].freqHz));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function adjacentStringIndices(index: number): number[] {
  if (index <= 0) return [1];
  if (index >= OPEN_STRINGS.length - 1) return [OPEN_STRINGS.length - 2];
  return [index - 1, index + 1];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rootMeanSquare(buffer: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sumSq += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSq / buffer.length);
}

function refineLagWithParabola(lag: number, scores: Float32Array): number {
  const left = scores[lag - 1] ?? scores[lag];
  const center = scores[lag];
  const right = scores[lag + 1] ?? scores[lag];

  const denom = left - 2 * center + right;
  if (Math.abs(denom) < 1e-9) {
    return lag;
  }

  const delta = 0.5 * (left - right) / denom;
  if (!Number.isFinite(delta) || Math.abs(delta) > 1) {
    return lag;
  }

  return lag + delta;
}
