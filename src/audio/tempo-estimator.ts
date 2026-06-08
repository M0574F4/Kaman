import type { PitchFrame, TempoDebugFrame, TempoFrame, TempoStatus } from "./types";

type TempoEstimatorOptions = {
  targetBpm: number;
  minBpm: number;
  maxBpm: number;
  sampleStepMs: number;
  windowMs: number;
  minWindowMs: number;
  tolerancePct: number;
  minConfidence: number;
  onsetRefractoryMs: number;
  minSignalRms: number;
  noiseGateRatio: number;
  sustainGateRatio: number;
  minSustainRms: number;
};

const DEFAULT_OPTIONS: TempoEstimatorOptions = {
  targetBpm: 80,
  minBpm: 30,
  maxBpm: 240,
  sampleStepMs: 20,
  windowMs: 8000,
  minWindowMs: 2800,
  tolerancePct: 0.055,
  minConfidence: 0.16,
  onsetRefractoryMs: 95,
  minSignalRms: 0.012,
  noiseGateRatio: 3.2,
  sustainGateRatio: 1.45,
  minSustainRms: 0.0035,
};

type NoveltySample = {
  tMs: number;
  value: number;
  active: boolean;
};

type TempoEstimate = {
  bpm: number;
  confidence: number;
};

type OnsetPeak = {
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
  private smoothedEstimate: TempoEstimate | null = null;
  private noiseFloorRms = 0.004;
  private lastActiveMs: number | null = null;
  private lastStrongSignalMs: number | null = null;
  private lastRms = 0;
  private lastActive = false;
  private lastActiveRatio = 0;
  private lastRecentActiveRatio = 0;
  private lastAutocorrelationEstimate: TempoEstimate | null = null;
  private lastPeakEstimate: TempoEstimate | null = null;

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
    this.smoothedEstimate = null;
    this.noiseFloorRms = 0.004;
    this.lastActiveMs = null;
    this.lastStrongSignalMs = null;
    this.lastRms = 0;
    this.lastActive = false;
    this.lastActiveRatio = 0;
    this.lastRecentActiveRatio = 0;
    this.lastAutocorrelationEstimate = null;
    this.lastPeakEstimate = null;
  }

  process(
    timeDomain: Float32Array,
    spectrumDb: Float32Array,
    pitchFrame: PitchFrame,
    tMs: number,
  ): TempoFrame {
    const rms = rootMeanSquare(timeDomain);
    const active = this.isSignalActive(rms, pitchFrame, tMs);
    this.lastRms = rms;
    this.lastActive = active;
    const novelty = this.computeNovelty(timeDomain, spectrumDb, pitchFrame, rms, active);
    this.pushNoveltySample(tMs, novelty, active);
    if (active) {
      this.lastActiveMs = tMs;
    }

    const estimate = this.estimateTempo(tMs);
    const debug = this.buildDebugFrame(tMs);
    if (!estimate) {
      return {
        tMs,
        targetBpm: this.opts.targetBpm,
        estimatedBpm: null,
        differenceBpm: null,
        confidence: 0,
        status: this.samples.length === 0 ? "idle" : "insufficient",
        novelty,
        debug,
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
      debug,
    };
  }

  private computeNovelty(
    timeDomain: Float32Array,
    spectrumDb: Float32Array,
    pitchFrame: PitchFrame,
    rms: number,
    active: boolean,
  ): number {
    if (!active) {
      this.updateNoiseFloor(rms, pitchFrame);
      this.previousRms = rms;
      this.previousSpectrum =
        this.previousSpectrum && this.previousSpectrum.length === spectrumDb.length
          ? this.previousSpectrum
          : new Float32Array(spectrumDb.length);
      this.previousSpectrum.set(spectrumDb);
      this.previousMidiFloat = null;
      this.previousPitchWasPresent = false;
      this.smoothedNovelty *= 0.86;
      return 0;
    }

    const energyNovelty =
      this.previousRms === null
        ? 0
        : Math.max(0, Math.log(rms + 1e-5) - Math.log(this.previousRms + 1e-5)) * 1.6;
    this.previousRms = rms;

    const spectralNovelty = this.computeSpectralFlux(spectrumDb);
    const pitchNovelty = this.computePitchNovelty(pitchFrame);

    const rawNovelty = spectralNovelty * 0.66 + energyNovelty * 0.22 + pitchNovelty * 0.44;
    this.smoothedNovelty = this.smoothedNovelty * 0.72 + rawNovelty * 0.28;

    return clamp01(rawNovelty - this.smoothedNovelty * 0.35);
  }

  private isSignalActive(rms: number, pitchFrame: PitchFrame, tMs: number): boolean {
    const hasConfidentPitch =
      pitchFrame.midiFloat !== null &&
      pitchFrame.freqHz !== null &&
      pitchFrame.confidence >= 0.32;
    if (hasConfidentPitch) {
      this.lastStrongSignalMs = tMs;
      return true;
    }

    const gate = Math.max(this.opts.minSignalRms, this.noiseFloorRms * this.opts.noiseGateRatio);
    if (rms >= gate) {
      this.lastStrongSignalMs = tMs;
      return true;
    }

    const sustainGate = Math.max(this.opts.minSustainRms, this.noiseFloorRms * this.opts.sustainGateRatio);
    const targetPeriodMs = 60_000 / this.opts.targetBpm;
    const holdMs = clamp(targetPeriodMs * 1.65, 950, 2600);
    const recentlyStrong =
      this.lastStrongSignalMs !== null && tMs - this.lastStrongSignalMs <= holdMs;
    return recentlyStrong && rms >= sustainGate;
  }

  private updateNoiseFloor(rms: number, pitchFrame: PitchFrame): void {
    const hasPitch = pitchFrame.midiFloat !== null && pitchFrame.confidence >= 0.28;
    if (hasPitch) {
      return;
    }

    const smoothing = rms < this.noiseFloorRms ? 0.08 : 0.015;
    this.noiseFloorRms = this.noiseFloorRms * (1 - smoothing) + rms * smoothing;
    this.noiseFloorRms = clamp(this.noiseFloorRms, 0.0015, 0.025);
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
      flux += diff > 0 ? diff * diff : Math.abs(diff) * 0.14;
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

  private pushNoveltySample(tMs: number, novelty: number, active: boolean): void {
    if (this.lastSampleMs === null) {
      this.samples.push({ tMs, value: novelty, active });
      this.lastSampleMs = tMs;
      return;
    }

    if (tMs <= this.lastSampleMs) {
      return;
    }

    if (tMs - this.lastSampleMs > 500) {
      this.samples.push({ tMs, value: novelty, active });
      this.lastSampleMs = tMs;
      return;
    }

    let nextSampleMs = this.lastSampleMs + this.opts.sampleStepMs;
    while (nextSampleMs <= tMs) {
      this.samples.push({ tMs: nextSampleMs, value: novelty, active });
      this.lastSampleMs = nextSampleMs;
      nextSampleMs += this.opts.sampleStepMs;
    }

    const earliestMs = tMs - this.opts.windowMs;
    while (this.samples.length > 0 && this.samples[0].tMs < earliestMs) {
      this.samples.shift();
    }
  }

  private estimateTempo(tMs: number): TempoEstimate | null {
    this.lastAutocorrelationEstimate = null;
    this.lastPeakEstimate = null;

    const inactiveResetMs = clamp((60_000 / this.opts.targetBpm) * 1.45, 900, 2600);
    if (this.lastActiveMs === null || tMs - this.lastActiveMs > inactiveResetMs) {
      this.smoothedEstimate = null;
      this.lastActiveRatio = 0;
      this.lastRecentActiveRatio = 0;
      return null;
    }

    const activeSamples = this.samples.filter((sample) => tMs - sample.tMs <= this.opts.windowMs);
    if (activeSamples.length < 40) {
      return null;
    }

    const spanMs = activeSamples[activeSamples.length - 1].tMs - activeSamples[0].tMs;
    if (spanMs < this.opts.minWindowMs) {
      return null;
    }

    const recentSamples = activeSamples.filter((sample) => tMs - sample.tMs <= 1800);
    const recentActiveCount = recentSamples.filter((sample) => sample.active).length;
    const activeCount = activeSamples.filter((sample) => sample.active).length;
    const activeRatio = activeCount / activeSamples.length;
    const recentActiveRatio = recentSamples.length === 0 ? 0 : recentActiveCount / recentSamples.length;
    this.lastActiveRatio = activeRatio;
    this.lastRecentActiveRatio = recentActiveRatio;
    if (activeRatio < 0.18 || recentActiveRatio < 0.16 || recentActiveCount < 8) {
      this.smoothedEstimate = null;
      return null;
    }

    const values = activeSamples.map((sample) => sample.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const centered = values.map((value) => value - mean);
    const energy = centered.reduce((sum, value) => sum + value * value, 0);
    const peakEnergy = values.filter((value) => value > 0.065).reduce((sum, value) => sum + value, 0);
    if (energy < 0.035 || peakEnergy < 0.75) {
      return null;
    }

    const autocorrelationEstimate = this.estimateFromAutocorrelation(centered);
    const peakEstimate = this.estimateFromOnsetPeaks(activeSamples);
    this.lastAutocorrelationEstimate = autocorrelationEstimate;
    this.lastPeakEstimate = peakEstimate;
    const rawEstimate = combineTempoEstimates(autocorrelationEstimate, peakEstimate);
    if (!rawEstimate) {
      return null;
    }

    return this.stabilizeEstimate(rawEstimate);
  }

  private buildDebugFrame(tMs: number): TempoDebugFrame {
    const activeSamples = this.samples.filter((sample) => tMs - sample.tMs <= this.opts.windowMs);
    const peaks = pickOnsetPeaks(activeSamples, this.onsetRefractoryMsForTarget());
    const pointStep = Math.max(1, Math.ceil(activeSamples.length / 96));
    const decimated = activeSamples.filter((_, index) => index % pointStep === 0);
    const peakPointIndexes = new Set<number>();
    for (const peak of peaks) {
      let closestIndex = -1;
      let closestDistance = Infinity;
      for (let i = 0; i < decimated.length; i += 1) {
        const distance = Math.abs(decimated[i].tMs - peak.tMs);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = i;
        }
      }
      if (closestIndex >= 0) {
        peakPointIndexes.add(closestIndex);
      }
    }

    const points = decimated.map((sample, index) => ({
      ageMs: tMs - sample.tMs,
      value: sample.value,
      active: sample.active,
      peak: peakPointIndexes.has(index),
    }));
    const sustainGateRms = Math.max(
      this.opts.minSustainRms,
      this.noiseFloorRms * this.opts.sustainGateRatio,
    );

    return {
      rms: this.lastRms,
      noiseFloorRms: this.noiseFloorRms,
      gateRms: Math.max(this.opts.minSignalRms, this.noiseFloorRms * this.opts.noiseGateRatio),
      sustainGateRms,
      active: this.lastActive,
      activeRatio: this.lastActiveRatio,
      recentActiveRatio: this.lastRecentActiveRatio,
      peakCount: peaks.length,
      autocorrelationBpm: this.lastAutocorrelationEstimate?.bpm ?? null,
      autocorrelationConfidence: this.lastAutocorrelationEstimate?.confidence ?? 0,
      peakBpm: this.lastPeakEstimate?.bpm ?? null,
      peakConfidence: this.lastPeakEstimate?.confidence ?? 0,
      points,
    };
  }

  private estimateFromAutocorrelation(centered: number[]): TempoEstimate | null {
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
    const confidence = clamp01(bestScore * 0.62 + dominance * 1.25);
    return { bpm: bestBpm, confidence };
  }

  private estimateFromOnsetPeaks(samples: NoveltySample[]): TempoEstimate | null {
    const peaks = pickOnsetPeaks(samples, this.onsetRefractoryMsForTarget());
    if (peaks.length < 3) {
      return null;
    }

    let bestBpm = 0;
    let bestScore = -Infinity;
    let secondScore = -Infinity;

    for (let bpm = this.opts.minBpm; bpm <= this.opts.maxBpm; bpm += 1) {
      const rawScore = this.onsetIntervalScore(peaks, bpm);
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
    const confidence = clamp01(bestScore * 0.72 + dominance * 1.55);
    return { bpm: bestBpm, confidence };
  }

  private onsetIntervalScore(peaks: OnsetPeak[], bpm: number): number {
    const periodMs = 60_000 / bpm;
    const intervalRatios = [
      { ratio: 0.5, weight: 0.42 },
      { ratio: 1, weight: 1 },
      { ratio: 2, weight: 0.72 },
      { ratio: 3, weight: 0.48 },
      { ratio: 4, weight: 0.32 },
    ];
    const toleranceMs = Math.max(55, Math.min(150, periodMs * 0.12));
    let score = 0;
    let support = 0;

    for (let i = 0; i < peaks.length; i += 1) {
      for (let j = i + 1; j < peaks.length; j += 1) {
        const intervalMs = peaks[j].tMs - peaks[i].tMs;
        if (intervalMs > periodMs * 4.35) {
          break;
        }

        let bestPairScore = 0;
        for (const { ratio, weight } of intervalRatios) {
          const expectedMs = periodMs * ratio;
          const errorMs = Math.abs(intervalMs - expectedMs);
          if (errorMs > toleranceMs * 2.7) {
            continue;
          }
          const closeness = Math.exp(-0.5 * (errorMs / toleranceMs) ** 2);
          bestPairScore = Math.max(bestPairScore, closeness * weight);
        }

        if (bestPairScore > 0) {
          const strength = Math.sqrt(peaks[i].value * peaks[j].value);
          score += bestPairScore * (0.45 + strength);
          support += 1;
        }
      }
    }

    if (support === 0) {
      return 0;
    }

    return clamp01(score / Math.max(2.5, peaks.length * 1.3));
  }

  private onsetRefractoryMsForTarget(): number {
    const targetPeriodMs = 60_000 / this.opts.targetBpm;
    return clamp(targetPeriodMs * 0.42, this.opts.onsetRefractoryMs, 260);
  }

  private stabilizeEstimate(next: TempoEstimate): TempoEstimate {
    if (!this.smoothedEstimate) {
      this.smoothedEstimate = next;
      return next;
    }

    const octaveDistance = Math.abs(Math.log2(next.bpm / this.smoothedEstimate.bpm));
    if (octaveDistance <= 0.18) {
      const bpm = this.smoothedEstimate.bpm * 0.62 + next.bpm * 0.38;
      const confidence = Math.max(
        next.confidence,
        this.smoothedEstimate.confidence * 0.78 + next.confidence * 0.22,
      );
      this.smoothedEstimate = { bpm, confidence };
      return this.smoothedEstimate;
    }

    if (next.confidence > this.smoothedEstimate.confidence + 0.12 || this.smoothedEstimate.confidence < 0.18) {
      this.smoothedEstimate = next;
      return next;
    }

    this.smoothedEstimate = {
      bpm: this.smoothedEstimate.bpm,
      confidence: this.smoothedEstimate.confidence * 0.94,
    };
    return this.smoothedEstimate;
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

function pickOnsetPeaks(samples: NoveltySample[], refractoryMs: number): OnsetPeak[] {
  if (samples.length < 5) {
    return [];
  }

  const values = samples.map((sample) => sample.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const percentile75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  const threshold = Math.max(0.055, mean + stdDev * 0.45, percentile75 * 0.82);
  const peaks: OnsetPeak[] = [];

  for (let i = 2; i < samples.length - 2; i += 1) {
    const current = samples[i].value;
    const isLocalPeak =
      current >= samples[i - 1].value &&
      current > samples[i + 1].value &&
      current >= samples[i - 2].value &&
      current >= samples[i + 2].value;
    if (!isLocalPeak || current < threshold) {
      continue;
    }

    const previousPeak = peaks[peaks.length - 1] ?? null;
    if (previousPeak && samples[i].tMs - previousPeak.tMs < refractoryMs) {
      if (current > previousPeak.value) {
        previousPeak.tMs = samples[i].tMs;
        previousPeak.value = current;
      }
      continue;
    }

    peaks.push({ tMs: samples[i].tMs, value: current });
  }

  return peaks;
}

function combineTempoEstimates(
  autocorrelationEstimate: TempoEstimate | null,
  peakEstimate: TempoEstimate | null,
): TempoEstimate | null {
  if (!autocorrelationEstimate) return peakEstimate;
  if (!peakEstimate) return autocorrelationEstimate;

  const octaveDistance = Math.abs(Math.log2(peakEstimate.bpm / autocorrelationEstimate.bpm));
  if (octaveDistance <= 0.16) {
    const peakWeight = 0.64 + peakEstimate.confidence * 0.18;
    const autoWeight = 1 - peakWeight;
    return {
      bpm: peakEstimate.bpm * peakWeight + autocorrelationEstimate.bpm * autoWeight,
      confidence: clamp01(peakEstimate.confidence * 0.68 + autocorrelationEstimate.confidence * 0.42),
    };
  }

  const peakIsStronger = peakEstimate.confidence >= autocorrelationEstimate.confidence * 0.88;
  return peakIsStronger ? peakEstimate : autocorrelationEstimate;
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
