import type { PitchFrame } from "./types";
import { AutoCorrelationPitchEstimator } from "./pitch-estimator";
import type { MicHandle } from "./mic";

export type PipelineHandle = {
  stop: () => void;
  setStringPurityEnabled: (enabled: boolean) => void;
};

export function startPitchPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
): PipelineHandle {
  const estimator = new AutoCorrelationPitchEstimator(mic.context.sampleRate);
  const buffer = new Float32Array(mic.analyser.fftSize);

  let rafId: number | null = null;
  let isRunning = true;

  const tick = () => {
    if (!isRunning) return;
    mic.analyser.getFloatTimeDomainData(buffer);
    const frame = estimator.process(buffer, performance.now());
    onFrame(frame);
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
