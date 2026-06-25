import { type NoteEventTime } from "@spotify/basic-pitch";
import * as tf from "@tensorflow/tfjs";
import basicPitchWeightsUrl from "@spotify/basic-pitch/model/group1-shard1of1.bin?url";
import basicPitchModelUrl from "@spotify/basic-pitch/model/model.json?url";
import type { PitchFrame } from "./types";

const BASIC_PITCH_SAMPLE_RATE = 22_050;
const DEFAULT_MIN_FREQ_HZ = 180;
const DEFAULT_MAX_FREQ_HZ = 2800;
const DEFAULT_RMS_THRESHOLD = 0.008;
const WINDOW_SECONDS = 2.4;
const ANALYSIS_INTERVAL_MS = 950;
const STALE_RESULT_MS = 1800;
const RECENT_NOTE_LOOKBACK_SECONDS = 0.85;
const FFT_HOP = 256;
const MODEL_OUTPUT_CONTOURS = "Identity";
const MODEL_AUDIO_WINDOW_SECONDS = 2;
const MODEL_AUDIO_N_SAMPLES = BASIC_PITCH_SAMPLE_RATE * MODEL_AUDIO_WINDOW_SECONDS - FFT_HOP;
const MODEL_OVERLAPPING_FRAMES = 30;
const MODEL_OVERLAP_HALF_FRAMES = Math.floor(MODEL_OVERLAPPING_FRAMES / 2);
const MODEL_OVERLAP_LENGTH_SAMPLES = MODEL_OVERLAPPING_FRAMES * FFT_HOP;
const MODEL_HOP_SIZE = MODEL_AUDIO_N_SAMPLES - MODEL_OVERLAP_LENGTH_SAMPLES;
const MODEL_ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_SAMPLE_RATE / FFT_HOP);
const CONTOURS_BINS_PER_SEMITONE = 3;
const ANNOTATIONS_BASE_MIDI = 21;
const CONTOUR_DETECTION_THRESHOLD = 0.28;

type BasicPitchOptions = {
  minFreq: number;
  maxFreq: number;
  rmsThreshold: number;
};

export type BasicPitchPitchDetection = {
  timeSeconds: number;
  midiFloat: number;
  freqHz: number;
  cents: number;
  confidence: number;
  frameIndex: number;
  binIndex: number;
};

export type BasicPitchAnalysisFrame = {
  tMs: number;
  windowSeconds: number;
  analysisMs: number;
  profile: BasicPitchProfile;
  pitchDetections: BasicPitchPitchDetection[];
  selectedFrame: PitchFrame;
};

export type BasicPitchProfile = {
  inputSampleRate: number;
  inputSamples: number;
  resampledSamples: number;
  modelAlreadyLoaded: boolean;
  audioTapCopyMs: number;
  audioTapIntervalMs: number | null;
  appendMs: number;
  latestSamplesMs: number;
  resampleMs: number;
  modelLoadWaitMs: number;
  evaluateModelMs: number;
  tfPrepareMs: number;
  graphExecuteMs: number;
  tensorUnwrapMs: number;
  tensorToArrayMs: number;
  contourCallbackMs: number;
  contourPostprocessMs: number;
  frameSelectMs: number;
  totalAnalysisMs: number;
  contourFrames: number;
  pitchDetections: number;
};

type BasicPitchEstimatorOptions = Partial<BasicPitchOptions> & {
  onAnalysis?: (analysis: BasicPitchAnalysisFrame) => void;
};

type BasicPitchModelJson = {
  modelTopology: {};
  weightsManifest: Array<{
    weights: tf.io.WeightsManifestEntry[];
  }>;
};

let basicPitchPromise: Promise<tf.GraphModel> | null = null;
let basicPitchLoaded = false;

export class BasicPitchPitchEstimator {
  private readonly opts: BasicPitchOptions;
  private readonly ring: Float32Array;
  private writeIndex = 0;
  private samplesWritten = 0;
  private lastRms = 0;
  private lastResult: PitchFrame | null = null;
  private lastAnalysisStartedAtMs = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private failedError: Error | null = null;
  private readonly onAnalysis?: (analysis: BasicPitchAnalysisFrame) => void;
  private lastAudioTapCopyMs = 0;
  private lastAudioTapIntervalMs: number | null = null;
  private lastAppendMs = 0;

  constructor(private readonly sampleRate: number, options?: BasicPitchEstimatorOptions) {
    this.opts = {
      minFreq: DEFAULT_MIN_FREQ_HZ,
      maxFreq: DEFAULT_MAX_FREQ_HZ,
      rmsThreshold: DEFAULT_RMS_THRESHOLD,
      ...options,
    };
    this.onAnalysis = options?.onAnalysis;
    this.ring = new Float32Array(Math.ceil(sampleRate * (WINDOW_SECONDS + 0.4)));
  }

  setRmsThreshold(rmsThreshold: number): void {
    this.opts.rmsThreshold = Math.max(0, rmsThreshold);
  }

  appendInput(input: Float32Array): void {
    const appendStartedAt = performance.now();
    this.lastRms = rootMeanSquare(input);
    for (let i = 0; i < input.length; i += 1) {
      this.ring[this.writeIndex] = input[i];
      this.writeIndex = (this.writeIndex + 1) % this.ring.length;
    }
    this.samplesWritten = Math.min(this.ring.length, this.samplesWritten + input.length);
    this.lastAppendMs = performance.now() - appendStartedAt;
  }

  recordAudioTap(copyMs: number, intervalMs: number | null): void {
    this.lastAudioTapCopyMs = copyMs;
    this.lastAudioTapIntervalMs = intervalMs;
  }

  process(tMs: number): PitchFrame {
    if (this.failedError) {
      return silentPitchFrame(tMs, 0);
    }

    if (this.lastRms < this.opts.rmsThreshold) {
      this.lastResult = null;
      return silentPitchFrame(tMs, 0);
    }

    if (this.hasEnoughAudio() && this.shouldAnalyze(tMs)) {
      this.startAnalysis(tMs);
    }

    if (this.lastResult && tMs - this.lastResult.tMs <= STALE_RESULT_MS) {
      return { ...this.lastResult, tMs };
    }

    return silentPitchFrame(tMs, 0);
  }

  getError(): Error | null {
    return this.failedError;
  }

  private hasEnoughAudio(): boolean {
    return this.samplesWritten >= Math.floor(this.sampleRate * WINDOW_SECONDS);
  }

  private shouldAnalyze(tMs: number): boolean {
    return !this.inFlight && tMs - this.lastAnalysisStartedAtMs >= ANALYSIS_INTERVAL_MS;
  }

  private startAnalysis(tMs: number): void {
    this.inFlight = true;
    this.lastAnalysisStartedAtMs = tMs;
    const totalStartedAtMs = performance.now();
    const latestSamplesStartedAtMs = performance.now();
    const source = this.latestSamples(Math.floor(this.sampleRate * WINDOW_SECONDS));
    const latestSamplesMs = performance.now() - latestSamplesStartedAtMs;
    const resampleStartedAtMs = performance.now();
    const resampled = resampleLinear(source, this.sampleRate, BASIC_PITCH_SAMPLE_RATE);
    const resampleMs = performance.now() - resampleStartedAtMs;
    const profileBase = {
      inputSampleRate: this.sampleRate,
      inputSamples: source.length,
      resampledSamples: resampled.length,
      audioTapCopyMs: this.lastAudioTapCopyMs,
      audioTapIntervalMs: this.lastAudioTapIntervalMs,
      appendMs: this.lastAppendMs,
      latestSamplesMs,
      resampleMs,
    };

    void analyzeBasicPitch(resampled, this.opts, tMs, profileBase, totalStartedAtMs)
      .then((analysis) => {
        const selectedFrame = {
          ...analysis.selectedFrame,
          tMs,
        };
        this.lastResult = selectedFrame;
        this.onAnalysis?.({
          ...analysis,
          tMs,
          analysisMs: analysis.profile.totalAnalysisMs,
          selectedFrame,
        });
      })
      .catch((error) => {
        this.failedError =
          error instanceof Error ? error : new Error("Basic Pitch inference failed.");
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private latestSamples(sampleCount: number): Float32Array {
    const count = Math.min(sampleCount, this.samplesWritten);
    const output = new Float32Array(count);
    const start = (this.writeIndex - count + this.ring.length) % this.ring.length;
    for (let i = 0; i < count; i += 1) {
      output[i] = this.ring[(start + i) % this.ring.length];
    }
    return output;
  }
}

async function analyzeBasicPitch(
  audio: Float32Array,
  options: BasicPitchOptions,
  tMs: number,
  profileBase: Pick<
    BasicPitchProfile,
    | "inputSampleRate"
    | "inputSamples"
    | "resampledSamples"
    | "audioTapCopyMs"
    | "audioTapIntervalMs"
    | "appendMs"
    | "latestSamplesMs"
    | "resampleMs"
  >,
  totalStartedAtMs: number,
): Promise<Omit<BasicPitchAnalysisFrame, "analysisMs">> {
  const modelAlreadyLoaded = basicPitchLoaded;
  const modelLoadStartedAtMs = performance.now();
  const model = await loadBasicPitchModel();
  const modelLoadWaitMs = performance.now() - modelLoadStartedAtMs;

  const evaluateStartedAtMs = performance.now();
  const {
    contours,
    tfPrepareMs,
    graphExecuteMs,
    tensorUnwrapMs,
    tensorToArrayMs,
    contourCallbackMs,
  } = await evaluateBasicPitchContoursOnly(model, audio);
  const evaluateModelMs = performance.now() - evaluateStartedAtMs;

  const windowSeconds = audio.length / BASIC_PITCH_SAMPLE_RATE;
  const contourPostprocessStartedAtMs = performance.now();
  const pitchDetections = contoursToPitchDetections(contours, options);
  const contourPostprocessMs = performance.now() - contourPostprocessStartedAtMs;
  const frameSelectStartedAtMs = performance.now();
  const selectedFrame = selectPitchDetectionFrame(pitchDetections, windowSeconds, tMs);
  const frameSelectMs = performance.now() - frameSelectStartedAtMs;
  const totalAnalysisMs = performance.now() - totalStartedAtMs;
  return {
    tMs,
    windowSeconds,
    profile: {
      ...profileBase,
      modelAlreadyLoaded,
      modelLoadWaitMs,
      evaluateModelMs,
      tfPrepareMs,
      graphExecuteMs,
      tensorUnwrapMs,
      tensorToArrayMs,
      contourCallbackMs,
      contourPostprocessMs,
      frameSelectMs,
      totalAnalysisMs,
      contourFrames: contours.length,
      pitchDetections: pitchDetections.length,
    },
    pitchDetections,
    selectedFrame,
  };
}

export function selectBasicPitchFrame(
  notes: NoteEventTime[],
  windowSeconds: number,
  tMs: number,
): PitchFrame {
  const recentStart = Math.max(0, windowSeconds - RECENT_NOTE_LOOKBACK_SECONDS);
  const recentNotes = notes.filter((note) => {
    const endSeconds = note.startTimeSeconds + note.durationSeconds;
    return endSeconds >= recentStart && note.startTimeSeconds <= windowSeconds;
  });

  if (recentNotes.length === 0) {
    return silentPitchFrame(tMs, 0);
  }

  const best = recentNotes.reduce((selected, note) => {
    if (note.startTimeSeconds > selected.startTimeSeconds + 0.08) return note;
    if (
      Math.abs(note.startTimeSeconds - selected.startTimeSeconds) <= 0.08 &&
      note.amplitude > selected.amplitude
    ) {
      return note;
    }
    return selected;
  });

  const midiFloat = pitchBendAdjustedMidi(best);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  const freqHz = 440 * 2 ** ((midiFloat - 69) / 12);
  const noteEndSeconds = Math.min(windowSeconds, best.startTimeSeconds + best.durationSeconds);

  return {
    tMs,
    detectedAtMs: tMs - windowSeconds * 1000 + noteEndSeconds * 1000,
    freqHz,
    midiFloat,
    midi,
    cents,
    confidence: clamp01(best.amplitude),
    stringPurity: null,
    adjacentBleedRatio: null,
    primaryString: null,
    bleedString: null,
  };
}

async function loadBasicPitchModel(): Promise<tf.GraphModel> {
  if (!basicPitchPromise) {
    basicPitchPromise = createBasicPitchModel();
  }
  return basicPitchPromise;
}

async function createBasicPitchModel(): Promise<tf.GraphModel> {
  const [modelJson, weightData] = await Promise.all([
    fetchJson<BasicPitchModelJson>(basicPitchModelUrl),
    fetchArrayBuffer(basicPitchWeightsUrl),
  ]);
  const weightSpecs = modelJson.weightsManifest.flatMap((group) => group.weights);
  const model = await tf.loadGraphModel(
    tf.io.fromMemory({
      modelTopology: modelJson.modelTopology,
      weightSpecs,
      weightData,
    }),
  );
  basicPitchLoaded = true;
  return model;
}

async function evaluateBasicPitchContoursOnly(
  model: tf.GraphModel,
  audio: Float32Array,
): Promise<{
  contours: number[][];
  tfPrepareMs: number;
  graphExecuteMs: number;
  tensorUnwrapMs: number;
  tensorToArrayMs: number;
  contourCallbackMs: number;
}> {
  let tfPrepareMs = 0;
  let graphExecuteMs = 0;
  let tensorUnwrapMs = 0;
  let tensorToArrayMs = 0;
  let contourCallbackMs = 0;
  const contours: number[][] = [];

  const prepareStartedAtMs = performance.now();
  const padding = tf.zeros([Math.floor(MODEL_OVERLAP_LENGTH_SAMPLES / 2)], "float32") as tf.Tensor1D;
  const audioTensor = tf.tensor1d(audio);
  const wavSamples = tf.concat1d([padding, audioTensor]);
  padding.dispose();
  audioTensor.dispose();
  const reshapedInput = tf.expandDims(
    tf.signal.frame(wavSamples, MODEL_AUDIO_N_SAMPLES, MODEL_HOP_SIZE, true, 0),
    -1,
  );
  wavSamples.dispose();
  tfPrepareMs = performance.now() - prepareStartedAtMs;

  const outputFrameCount = Math.floor(audio.length * (MODEL_ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE));
  let calculatedFrames = 0;

  try {
    for (let batchIndex = 0; batchIndex < reshapedInput.shape[0]; batchIndex += 1) {
      const singleBatch = tf.slice(reshapedInput, batchIndex, 1);
      const executeStartedAtMs = performance.now();
      const output = model.execute(singleBatch, MODEL_OUTPUT_CONTOURS) as tf.Tensor;
      graphExecuteMs += performance.now() - executeStartedAtMs;
      singleBatch.dispose();

      const unwrapStartedAtMs = performance.now();
      const unwrapped = unwrapBasicPitchOutput(output);
      output.dispose();
      const availableFrames = unwrapped.shape[0];
      const framesToOutput =
        calculatedFrames + availableFrames >= outputFrameCount
          ? outputFrameCount - calculatedFrames
          : availableFrames;
      const clipped =
        framesToOutput < availableFrames
          ? unwrapped.slice([0, 0], [Math.max(0, framesToOutput), -1])
          : unwrapped;
      tensorUnwrapMs += performance.now() - unwrapStartedAtMs;

      if (framesToOutput <= 0 || calculatedFrames >= outputFrameCount) {
        clipped.dispose();
        if (clipped !== unwrapped) {
          unwrapped.dispose();
        }
        continue;
      }

      const arrayStartedAtMs = performance.now();
      const nextContours = (await clipped.array()) as number[][];
      tensorToArrayMs += performance.now() - arrayStartedAtMs;
      const callbackStartedAtMs = performance.now();
      contours.push(...nextContours);
      contourCallbackMs += performance.now() - callbackStartedAtMs;
      calculatedFrames += availableFrames;

      clipped.dispose();
      if (clipped !== unwrapped) {
        unwrapped.dispose();
      }
      if (calculatedFrames >= outputFrameCount) {
        break;
      }
    }
  } finally {
    reshapedInput.dispose();
  }

  return {
    contours,
    tfPrepareMs,
    graphExecuteMs,
    tensorUnwrapMs,
    tensorToArrayMs,
    contourCallbackMs,
  };
}

function unwrapBasicPitchOutput(result: tf.Tensor): tf.Tensor2D {
  const timeFrames = result.shape[1] ?? 0;
  const rawOutput = result.slice(
    [0, MODEL_OVERLAP_HALF_FRAMES, 0],
    [-1, timeFrames - 2 * MODEL_OVERLAP_HALF_FRAMES, -1],
  );
  const outputShape = rawOutput.shape;
  const batches = outputShape[0] ?? 0;
  const frames = outputShape[1] ?? 0;
  const bins = outputShape[2] ?? 0;
  const unwrapped = rawOutput.reshape([batches * frames, bins]) as tf.Tensor2D;
  rawOutput.dispose();
  return unwrapped;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load Basic Pitch model metadata (${response.status}).`);
  }
  return (await response.json()) as T;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load Basic Pitch model weights (${response.status}).`);
  }
  return response.arrayBuffer();
}

function pitchBendAdjustedMidi(note: NoteEventTime): number {
  if (!note.pitchBends || note.pitchBends.length === 0) {
    return note.pitchMidi;
  }
  const recentBends = note.pitchBends.slice(Math.floor(note.pitchBends.length * 0.6));
  const avgBend =
    recentBends.reduce((sum, bend) => sum + bend, 0) / Math.max(1, recentBends.length);
  return note.pitchMidi + avgBend / 3;
}

function contoursToPitchDetections(
  contours: number[][],
  options: BasicPitchOptions,
): BasicPitchPitchDetection[] {
  const detections: BasicPitchPitchDetection[] = [];

  for (let frameIndex = 0; frameIndex < contours.length; frameIndex += 1) {
    const row = contours[frameIndex];
    for (let binIndex = 1; binIndex < row.length - 1; binIndex += 1) {
      const confidence = row[binIndex];
      if (
        confidence < CONTOUR_DETECTION_THRESHOLD ||
        confidence < row[binIndex - 1] ||
        confidence < row[binIndex + 1]
      ) {
        continue;
      }

      const binFloat = binIndex + parabolicPeakOffset(
        row[binIndex - 1],
        confidence,
        row[binIndex + 1],
      );
      const midiFloat = ANNOTATIONS_BASE_MIDI + binFloat / CONTOURS_BINS_PER_SEMITONE;
      const freqHz = 440 * 2 ** ((midiFloat - 69) / 12);
      if (freqHz < options.minFreq || freqHz > options.maxFreq) {
        continue;
      }
      const nearestMidi = Math.round(midiFloat);

      detections.push({
        timeSeconds: (frameIndex * FFT_HOP) / BASIC_PITCH_SAMPLE_RATE,
        midiFloat,
        freqHz,
        cents: (midiFloat - nearestMidi) * 100,
        confidence: clamp01(confidence),
        frameIndex,
        binIndex,
      });
    }
  }

  return detections;
}

function selectPitchDetectionFrame(
  detections: BasicPitchPitchDetection[],
  windowSeconds: number,
  tMs: number,
): PitchFrame {
  const recentStart = Math.max(0, windowSeconds - RECENT_NOTE_LOOKBACK_SECONDS);
  const recentDetections = detections.filter((detection) => detection.timeSeconds >= recentStart);
  if (recentDetections.length === 0) {
    return silentPitchFrame(tMs, 0);
  }

  const best = recentDetections.reduce((selected, detection) => {
    if (detection.timeSeconds > selected.timeSeconds + 0.04) return detection;
    if (
      Math.abs(detection.timeSeconds - selected.timeSeconds) <= 0.04 &&
      detection.confidence > selected.confidence
    ) {
      return detection;
    }
    return selected;
  });
  const midi = Math.round(best.midiFloat);

  return {
    tMs,
    detectedAtMs: tMs - windowSeconds * 1000 + best.timeSeconds * 1000,
    freqHz: best.freqHz,
    midiFloat: best.midiFloat,
    midi,
    cents: best.cents,
    confidence: best.confidence,
    stringPurity: null,
    adjacentBleedRatio: null,
    primaryString: null,
    bleedString: null,
  };
}

function parabolicPeakOffset(left: number, center: number, right: number): number {
  const denom = left - 2 * center + right;
  if (Math.abs(denom) < 1e-9) {
    return 0;
  }
  return clamp(0.5 * (left - right) / denom, -0.5, 0.5);
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) {
    return input.slice();
  }

  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const fraction = sourceIndex - leftIndex;
    output[i] = input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction;
  }

  return output;
}

function silentPitchFrame(tMs: number, confidence: number): PitchFrame {
  return {
    tMs,
    freqHz: null,
    midiFloat: null,
    midi: null,
    cents: null,
    confidence,
    stringPurity: null,
    adjacentBleedRatio: null,
    primaryString: null,
    bleedString: null,
  };
}

function rootMeanSquare(buffer: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sumSq += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSq / buffer.length);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
