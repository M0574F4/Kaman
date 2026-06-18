import type {
  BasicPitchAnalysisFrame,
  BasicPitchPitchEstimator,
} from "./basic-pitch-estimator";
import type {
  PitchDetectionEngine,
  PitchFrame,
  SpectrumFrame,
  TempoFrame,
  TempoResponsivenessLabel,
} from "./types";
import { AutoCorrelationPitchEstimator } from "./pitch-estimator";
import { TempoEstimator } from "./tempo-estimator";
import type { MicHandle } from "./mic";

export type PipelineHandle = {
  stop: () => void;
  setStringPurityEnabled: (enabled: boolean) => void;
  setPracticeTargetBpm: (bpm: number) => void;
  setPracticePeakPicking: (peakThreshold: number, peakMergeMs: number) => void;
  setPracticeTolerancePct: (tolerancePct: number) => void;
  setPracticeCorrectionSource: (source: TempoResponsivenessLabel) => void;
  setPitchRmsThreshold: (rmsThreshold: number) => void;
  resetTempo: () => void;
};

type PitchPipelineOptions = {
  pitchEngine?: PitchDetectionEngine;
  onError?: (error: Error) => void;
  onBasicPitchAnalysis?: (analysis: BasicPitchAnalysisFrame) => void;
};

export async function startPitchPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
  onSpectrumFrame?: (frame: SpectrumFrame) => void,
  onTempoFrame?: (frame: TempoFrame) => void,
  initialPracticeTargetBpm = 80,
  options: PitchPipelineOptions = {},
): Promise<PipelineHandle> {
  const pitchEngine = options.pitchEngine ?? "autocorrelation";
  const basicPitchEstimator: BasicPitchPitchEstimator | null =
    pitchEngine === "basic-pitch"
      ? new (await import("./basic-pitch-estimator")).BasicPitchPitchEstimator(
          mic.context.sampleRate,
          { onAnalysis: options.onBasicPitchAnalysis },
        )
      : null;
  const autocorrelationEstimator =
    basicPitchEstimator === null
      ? new AutoCorrelationPitchEstimator(mic.context.sampleRate)
      : null;
  const tempoEstimator = new TempoEstimator(mic.context.sampleRate, mic.analyser.fftSize, {
    targetBpm: initialPracticeTargetBpm,
  });
  const buffer = new Float32Array(mic.analyser.fftSize);
  const spectrumBuffer = new Float32Array(mic.analyser.frequencyBinCount);
  const basicPitchTap =
    basicPitchEstimator !== null
      ? createBasicPitchAudioTap(mic, (input, copyMs, intervalMs) => {
          basicPitchEstimator.recordAudioTap(copyMs, intervalMs);
          basicPitchEstimator.appendInput(input);
        })
      : null;

  let rafId: number | null = null;
  let isRunning = true;

  const tick = () => {
    if (!isRunning) return;
    mic.analyser.getFloatTimeDomainData(buffer);
    const nowMs = performance.now();
    const frame =
      basicPitchEstimator !== null
        ? basicPitchEstimator.process(nowMs)
        : autocorrelationEstimator!.process(buffer, nowMs);
    if (basicPitchEstimator !== null) {
      const error = basicPitchEstimator.getError();
      if (error) {
        isRunning = false;
        options.onError?.(error);
        return;
      }
    }
    onFrame(frame);
    if (onSpectrumFrame || onTempoFrame) {
      mic.analyser.getFloatFrequencyData(spectrumBuffer);
    }
    if (onTempoFrame) {
      onTempoFrame(tempoEstimator.process(buffer, spectrumBuffer, frame, frame.tMs));
    }
    if (onSpectrumFrame) {
      onSpectrumFrame({
        tMs: frame.tMs,
        sampleRate: mic.context.sampleRate,
        fftSize: mic.analyser.fftSize,
        minDecibels: mic.analyser.minDecibels,
        maxDecibels: mic.analyser.maxDecibels,
        magnitudesDb: spectrumBuffer,
      });
    }
    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);

  return {
    stop: () => {
      isRunning = false;
      basicPitchTap?.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    },
    setStringPurityEnabled: (enabled: boolean) => {
      autocorrelationEstimator?.setStringPurityEnabled(enabled);
    },
    setPracticeTargetBpm: (bpm: number) => {
      tempoEstimator.setTargetBpm(bpm);
    },
    setPracticePeakPicking: (peakThreshold: number, peakMergeMs: number) => {
      tempoEstimator.setPeakPickingOptions(peakThreshold, peakMergeMs);
    },
    setPracticeTolerancePct: (tolerancePct: number) => {
      tempoEstimator.setTolerancePct(tolerancePct);
    },
    setPracticeCorrectionSource: (source: TempoResponsivenessLabel) => {
      tempoEstimator.setCorrectionEstimateLabel(source);
    },
    setPitchRmsThreshold: (rmsThreshold: number) => {
      basicPitchEstimator?.setRmsThreshold(rmsThreshold);
      autocorrelationEstimator?.setRmsThreshold(rmsThreshold);
    },
    resetTempo: () => {
      tempoEstimator.reset();
    },
  };
}

function createBasicPitchAudioTap(
  mic: MicHandle,
  onInput: (input: Float32Array, copyMs: number, intervalMs: number | null) => void,
): { disconnect: () => void } {
  const processor = mic.context.createScriptProcessor(4096, 1, 1);
  const silentGain = mic.context.createGain();
  silentGain.gain.value = 0;
  let lastCallbackMs: number | null = null;

  processor.onaudioprocess = (event) => {
    const nowMs = performance.now();
    const intervalMs = lastCallbackMs === null ? null : nowMs - lastCallbackMs;
    lastCallbackMs = nowMs;
    const copyStartedAtMs = performance.now();
    const input = event.inputBuffer.getChannelData(0).slice();
    const copyMs = performance.now() - copyStartedAtMs;
    onInput(input, copyMs, intervalMs);
  };

  mic.source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(mic.context.destination);

  return {
    disconnect: () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      silentGain.disconnect();
    },
  };
}
