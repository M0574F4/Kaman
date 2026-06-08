import type { PitchFrame, TempoFrame, TempoStatus } from "./types";

type TempoEstimatorOptions = {
  targetBpm: number;
  minBpm: number;
  maxBpm: number;
  sampleStepMs: number;
  windowMs: number;
  minWindowMs: number;
  tolerancePct: number;
  minConfidence: number;
};

const DEFAULT_OPTIONS: TempoEstimatorOptions = {
  targetBpm: 80,
  minBpm: 30,
  maxBpm: 240,
  sampleStepMs: 20,
  windowMs: 8000,
  minWindowMs: 2800,
  tolerancePct: 0.055,
  minConfidence: 0.18,
};

type NoveltySample = {
  tMs: number;
  value: number;
};

export class TempoEstimator {
  private readonly opts: TempoEstimatorOptions;
  private previousSpectrum: Float32Array | null = null;
  private previousRms: number | null = null;
  private previousMidiFloat: number | null = null;
  private previousPitchWasPresent = false;
  private lastSampleMs: number | null = null;
  private smoothedNovelty = 0;
  private samples: NoveltySample[] = [];

  constructor(
    private readonly sampleRate: number,
    private readonly fftSize: number,
    options?: Partial<TempoEstimatorOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  setTargetBpm(targetBpm: number): void {
    this.opts.targetBpm = clamp(targetBpm, this.opts.minBpm, this.opts.maxBpm);
  }

  reset(): void {
    this.previousSpectrum = null;
    this.previousRms = null;
    this.previousMidiFloat = null;
    this.previousPitchWasPresent = false;
    this.lastSampleMs = null;
    this.smoothedNovelty = 0;
    this.samples = [];
  }

  process(
    timeDomain: Float32Array,
    spectrumDb: Float32Array,
    pitchFrame: PitchFrame,
    tMs: number,
  ): TempoFrame {
    const novelty = this.computeNovelty(timeDomain, spectrumDb, pitchFrame);
    this.pushNoveltySample(tMs, novelty);

    const estimate = this.estimateTempo(tMs);
    if (!estimate) {
      return {
        tMs,
        targetBpm: this.opts.targetBpm,
        estimatedBpm: null,
        differenceBpm: null,
        confidence: 0,
        status: this.samples.length === 0 ? "idle" : "insufficient",
        novelty,
      };
    }

    const differenceBpm = estimate.bpm - this.opts.targetBpm;
    const relativeError = Math.abs(differenceBpm) / this.opts.targetBpm;
    const status = statusForEstimate(
      estimate.confidence,
      relativeError,
      differenceBpm,
      this.opts.tolerancePct,
      this.opts.minConfidence,
    );

    return {
      tMs,
      targetBpm: this.opts.targetBpm,
      estimatedBpm: estimate.bpm,
      differenceBpm,
      confidence: estimate.confidence,
      status,
      novelty,
    };
  }

  private computeNovelty(
    timeDomain: Float32Array,
    spectrumDb: Float32Array,
    pitchFrame: PitchFrame,
  ): number {
    const rms = rootMeanSquare(timeDomain);
    const energyNovelty =
      this.previousRms === null
        ? 0
        : Math.max(0, Math.log(rms + 1e-5) - Math.log(this.previousRms + 1e-5)) * 1.6;
    this.previousRms = rms;

    const spectralNovelty = this.computeSpectralFlux(spectrumDb);
    const pitchNovelty = this.computePitchNovelty(pitchFrame);

    const rawNovelty = spectralNovelty * 0.62 + energyNovelty * 0.2 + pitchNovelty * 0.42;
    this.smoothedNovelty = this.smoothedNovelty * 0.72 + rawNovelty * 0.28;

    return clamp01(rawNovelty - this.smoothedNovelty * 0.35);
  }

  private computeSpectralFlux(spectrumDb: Float32Array): number {
    if (!this.previousSpectrum || this.previousSpectrum.length !== spectrumDb.length) {
      this.previousSpectrum = new Float32Array(spectrumDb);
      return 0;
    }

    let flux = 0;
    let bins = 0;
    const binHz = this.sampleRate / this.fftSize;
    const lowBin = Math.max(1, Math.floor(120 / binHz));
    const highBin = Math.min(spectrumDb.length - 1, Math.ceil(5200 / binHz));

    for (let i = lowBin; i <= highBin; i += 1) {
      const current = normalizeDb(spectrumDb[i]);
      const previous = normalizeDb(this.previousSpectrum[i]);
      const diff = current - previous;
      if (diff > 0) {
        flux += diff * diff;
      }
      bins += 1;
    }

    this.previousSpectrum.set(spectrumDb);
    if (bins === 0) return 0;
    return clamp01(Math.sqrt(flux / bins) * 5.4);
  }

  private computePitchNovelty(frame: PitchFrame): number {
    const hasPitch =
      frame.midiFloat !== null &&
      frame.freqHz !== null &&
      frame.confidence >= 0.28;

    if (!hasPitch) {
      this.previousMidiFloat = null;
      this.previousPitchWasPresent = false;
      return 0;
    }

    const midiFloat = frame.midiFloat ?? 0;
    let novelty = 0;
    if (!this.previousPitchWasPresent) {
      novelty = 0.28;
    } else if (this.previousMidiFloat !== null) {
      novelty = clamp01(Math.abs(midiFloat - this.previousMidiFloat) / 1.35);
    }

    this.previousMidiFloat = midiFloat;
    this.previousPitchWasPresent = true;
    return novelty;
  }

  private pushNoveltySample(tMs: number, novelty: number): void {
    if (this.lastSampleMs === null) {
      this.samples.push({ tMs, value: novelty });
      this.lastSampleMs = tMs;
      return;
    }

    if (tMs <= this.lastSampleMs) {
      return;
    }

    if (tMs - this.lastSampleMs > 500) {
      this.samples.push({ tMs, value: novelty });
      this.lastSampleMs = tMs;
      return;
    }

    let nextSampleMs = this.lastSampleMs + this.opts.sampleStepMs;
    while (nextSampleMs <= tMs) {
      this.samples.push({ tMs: nextSampleMs, value: novelty });
      this.lastSampleMs = nextSampleMs;
      nextSampleMs += this.opts.sampleStepMs;
    }

    const earliestMs = tMs - this.opts.windowMs;
    while (this.samples.length > 0 && this.samples[0].tMs < earliestMs) {
      this.samples.shift();
    }
  }

  private estimateTempo(tMs: number): { bpm: number; confidence: number } | null {
    const activeSamples = this.samples.filter((sample) => tMs - sample.tMs <= this.opts.windowMs);
    if (activeSamples.length < 40) {
      return null;
    }

    const spanMs = activeSamples[activeSamples.length - 1].tMs - activeSamples[0].tMs;
    if (spanMs < this.opts.minWindowMs) {
      return null;
    }

    const values = activeSamples.map((sample) => sample.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const centered = values.map((value) => value - mean);
    const energy = centered.reduce((sum, value) => sum + value * value, 0);
    const peakEnergy = values.filter((value) => value > 0.08).reduce((sum, value) => sum + value, 0);
    if (energy < 0.05 || peakEnergy < 1.5) {
      return null;
    }

    let bestBpm = 0;
    let bestScore = -Infinity;
    let secondScore = -Infinity;

    for (let bpm = this.opts.minBpm; bpm <= this.opts.maxBpm; bpm += 1) {
      const rawScore = this.autocorrelationScore(centered, bpm);
      const score = rawScore * this.targetPrior(bpm);

      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestBpm = bpm;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    if (bestBpm <= 0 || bestScore <= 0) {
      return null;
    }

    const dominance = bestScore - Math.max(0, secondScore);
    const confidence = clamp01(bestScore * 0.72 + dominance * 1.2);
    return { bpm: bestBpm, confidence };
  }

  private autocorrelationScore(centered: number[], bpm: number): number {
    const lag = Math.round((60_000 / bpm) / this.opts.sampleStepMs);
    if (lag < 4 || lag >= centered.length - 2) {
      return 0;
    }

    const primary = normalizedLagCorrelation(centered, lag);
    const doubleLag = lag * 2 < centered.length ? normalizedLagCorrelation(centered, lag * 2) : 0;
    const halfLag = lag >= 8 ? normalizedLagCorrelation(centered, Math.round(lag / 2)) : 0;

    return Math.max(0, primary * 0.72 + doubleLag * 0.22 + halfLag * 0.06);
  }

  private targetPrior(bpm: number): number {
    const ratio = Math.log2(bpm / this.opts.targetBpm);
    return 0.34 + 0.66 * Math.exp(-(ratio * ratio) / (2 * 0.68 * 0.68));
  }
}

function normalizedLagCorrelation(values: number[], lag: number): number {
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;

  for (let i = lag; i < values.length; i += 1) {
    const left = values[i];
    const right = values[i - lag];
    numerator += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }

  const denominator = Math.sqrt(leftEnergy * rightEnergy) + 1e-9;
  return numerator / denominator;
}

function statusForEstimate(
  confidence: number,
  relativeError: number,
  differenceBpm: number,
  tolerancePct: number,
  minConfidence: number,
): TempoStatus {
  if (confidence < minConfidence) {
    return "insufficient";
  }
  if (relativeError <= tolerancePct) {
    return "on-tempo";
  }
  return differenceBpm < 0 ? "play-faster" : "play-slower";
}

function normalizeDb(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp01((value + 92) / 70);
}

function rootMeanSquare(input: Float32Array): number {
  let sum = 0;
  for (const sample of input) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
