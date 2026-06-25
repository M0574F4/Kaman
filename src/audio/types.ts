import type { InstrumentStringId } from "../shared/instrument-profile";

export type InstrumentStringName = InstrumentStringId;

export type PitchDetectionEngine = "autocorrelation" | "basic-pitch";

export type PitchFrame = {
  tMs: number;
  detectedAtMs?: number;
  freqHz: number | null;
  midiFloat: number | null;
  midi: number | null;
  cents: number | null;
  confidence: number;
  stringPurity: number | null;
  adjacentBleedRatio: number | null;
  primaryString: InstrumentStringName | null;
  bleedString: InstrumentStringName | null;
};

export type SpectrumFrame = {
  tMs: number;
  sampleRate: number;
  fftSize: number;
  minDecibels: number;
  maxDecibels: number;
  magnitudesDb: Float32Array;
};

export type TempoStatus =
  | "idle"
  | "insufficient"
  | "play-faster"
  | "play-slower"
  | "on-tempo";

export type TempoFrame = {
  tMs: number;
  targetBpm: number;
  estimatedBpm: number | null;
  differenceBpm: number | null;
  confidence: number;
  status: TempoStatus;
  novelty: number;
  debug: TempoDebugFrame;
};

export type TempoDebugPoint = {
  ageMs: number;
  value: number;
  active: boolean;
  peak: boolean;
};

export type TempoResponsivenessLabel = "Fast" | "Balanced" | "Stable";

export type TempoResponsivenessEstimate = {
  label: TempoResponsivenessLabel;
  intervalCount: number;
  bpm: number | null;
  confidence: number;
  intervalsMs: number[];
};

export type TempoDebugFrame = {
  rms: number;
  noiseFloorRms: number;
  gateRms: number;
  sustainGateRms: number;
  active: boolean;
  activeRatio: number;
  recentActiveRatio: number;
  peakCount: number;
  peakThreshold: number;
  peakMergeMs: number;
  recentIntervalsMs: number[];
  responsivenessEstimates: TempoResponsivenessEstimate[];
  recentPeakBpm: number | null;
  recentPeakConfidence: number;
  autocorrelationBpm: number | null;
  autocorrelationConfidence: number;
  peakBpm: number | null;
  peakConfidence: number;
  points: TempoDebugPoint[];
};

export type SequenceSettings = {
  bpm: number;
  timeSignature: "2/2" | "2/4" | "3/4" | "4/4" | "6/8";
  quantization: "1/4" | "1/8" | "1/16";
  minNoteMs: number;
  minRestMs: number;
};

export type NoteEvent = {
  startMs: number;
  endMs: number;
  midi: number;
  confidenceAvg: number;
};

export type LiveSettings = {
  a4Hz: number;
  minMidi: number;
  maxMidi: number;
  confidenceThreshold: number;
};
