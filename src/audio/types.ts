export type ViolinStringName = "G" | "D" | "A" | "E";

export type PitchFrame = {
  tMs: number;
  freqHz: number | null;
  midiFloat: number | null;
  midi: number | null;
  cents: number | null;
  confidence: number;
  stringPurity: number | null;
  adjacentBleedRatio: number | null;
  primaryString: ViolinStringName | null;
  bleedString: ViolinStringName | null;
};

export type SpectrumFrame = {
  tMs: number;
  sampleRate: number;
  fftSize: number;
  minDecibels: number;
  maxDecibels: number;
  magnitudesDb: Float32Array;
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
