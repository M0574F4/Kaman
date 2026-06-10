import type { PitchFrame, SpectrumFrame, TempoFrame, TempoResponsivenessLabel } from "./types";
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

export function startPitchPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
  onSpectrumFrame?: (frame: SpectrumFrame) => void,
  onTempoFrame?: (frame: TempoFrame) => void,
  initialPracticeTargetBpm = 80,
): PipelineHandle {
  const estimator = new AutoCorrelationPitchEstimator(mic.context.sampleRate);
  const tempoEstimator = new TempoEstimator(mic.context.sampleRate, mic.analyser.fftSize, {
    targetBpm: initialPracticeTargetBpm,
  });
  const buffer = new Float32Array(mic.analyser.fftSize);
  const spectrumBuffer = new Float32Array(mic.analyser.frequencyBinCount);

  let rafId: number | null = null;
  let isRunning = true;

  const tick = () => {
    if (!isRunning) return;
    mic.analyser.getFloatTimeDomainData(buffer);
    const frame = estimator.process(buffer, performance.now());
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
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    },
    setStringPurityEnabled: (enabled: boolean) => {
      estimator.setStringPurityEnabled(enabled);
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
      estimator.setRmsThreshold(rmsThreshold);
    },
    resetTempo: () => {
      tempoEstimator.reset();
    },
  };
}
