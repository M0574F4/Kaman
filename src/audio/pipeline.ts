import type { PitchFrame, SpectrumFrame } from "./types";
import { AutoCorrelationPitchEstimator } from "./pitch-estimator";
import type { MicHandle } from "./mic";

export type PipelineHandle = {
  stop: () => void;
  setStringPurityEnabled: (enabled: boolean) => void;
};

export function startPitchPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
  onSpectrumFrame?: (frame: SpectrumFrame) => void,
): PipelineHandle {
  const estimator = new AutoCorrelationPitchEstimator(mic.context.sampleRate);
  const buffer = new Float32Array(mic.analyser.fftSize);
  const spectrumBuffer = new Float32Array(mic.analyser.frequencyBinCount);

  let rafId: number | null = null;
  let isRunning = true;

  const tick = () => {
    if (!isRunning) return;
    mic.analyser.getFloatTimeDomainData(buffer);
    const frame = estimator.process(buffer, performance.now());
    onFrame(frame);
    if (onSpectrumFrame) {
      mic.analyser.getFloatFrequencyData(spectrumBuffer);
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
  };
}
