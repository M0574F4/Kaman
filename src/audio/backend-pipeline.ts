import type { MicHandle } from "./mic";
import type { PipelineHandle } from "./pipeline";
import type {
  PitchFrame,
  SpectrumFrame,
  TempoFrame,
  TempoResponsivenessLabel,
} from "./types";

export const DEFAULT_BACKEND_ENDPOINT = "http://127.0.0.1:8787";

type BackendHealth = {
  ok: boolean;
  service: string;
  platform: string;
};

type BackendPipelineConfig = {
  endpoint?: string;
  onError?: (error: Error) => void;
};

type BackendPipelineOptions = {
  stringPurityEnabled: boolean;
  targetBpm: number;
  peakThreshold: number;
  peakMergeMs: number;
  tolerancePct: number;
  correctionSource: TempoResponsivenessLabel;
  rmsThreshold: number;
};

type BackendFrameResponse = {
  pitchFrame: PitchFrame;
  spectrumFrame: Omit<SpectrumFrame, "magnitudesDb"> & {
    magnitudesDb: number[];
  };
  tempoFrame: TempoFrame;
};

export async function checkBackendAvailability(
  endpoint = DEFAULT_BACKEND_ENDPOINT,
): Promise<BackendHealth> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${endpoint}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Backend health check returned ${response.status}`);
    }
    return (await response.json()) as BackendHealth;
  } catch (error) {
    throw new Error(
      `Local backend is not reachable at ${endpoint}. Run npm run backend, then try again.`,
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function startBackendPitchPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
  onSpectrumFrame?: (frame: SpectrumFrame) => void,
  onTempoFrame?: (frame: TempoFrame) => void,
  initialPracticeTargetBpm = 80,
  config: BackendPipelineConfig = {},
): PipelineHandle {
  const endpoint = config.endpoint ?? DEFAULT_BACKEND_ENDPOINT;
  const sessionId = createSessionId();
  const buffer = new Float32Array(mic.analyser.fftSize);
  const spectrumBuffer = new Float32Array(mic.analyser.frequencyBinCount);
  const options: BackendPipelineOptions = {
    stringPurityEnabled: false,
    targetBpm: initialPracticeTargetBpm,
    peakThreshold: 50,
    peakMergeMs: 320,
    tolerancePct: 0.08,
    correctionSource: "Balanced",
    rmsThreshold: 0.008,
  };

  let rafId: number | null = null;
  let isRunning = true;
  let inFlight = false;
  let failureReported = false;

  const reportFailure = (error: unknown) => {
    if (failureReported || !isRunning) return;
    failureReported = true;
    isRunning = false;
    const normalized =
      error instanceof Error
        ? error
        : new Error("Local backend processing failed.");
    config.onError?.(normalized);
  };

  const tick = () => {
    if (!isRunning) return;

    if (!inFlight) {
      mic.analyser.getFloatTimeDomainData(buffer);
      mic.analyser.getFloatFrequencyData(spectrumBuffer);
      inFlight = true;
      void postFrame(endpoint, {
        sessionId,
        sampleRate: mic.context.sampleRate,
        fftSize: mic.analyser.fftSize,
        minDecibels: mic.analyser.minDecibels,
        maxDecibels: mic.analyser.maxDecibels,
        tMs: performance.now(),
        timeDomain: Array.from(buffer),
        spectrumDb: Array.from(spectrumBuffer),
        options,
      })
        .then((result) => {
          if (!isRunning) return;
          onFrame(result.pitchFrame);
          if (onTempoFrame) {
            onTempoFrame(result.tempoFrame);
          }
          if (onSpectrumFrame) {
            onSpectrumFrame({
              ...result.spectrumFrame,
              magnitudesDb: new Float32Array(result.spectrumFrame.magnitudesDb),
            });
          }
        })
        .catch(reportFailure)
        .finally(() => {
          inFlight = false;
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
      options.stringPurityEnabled = enabled;
    },
    setPracticeTargetBpm: (bpm: number) => {
      options.targetBpm = bpm;
    },
    setPracticePeakPicking: (peakThreshold: number, peakMergeMs: number) => {
      options.peakThreshold = peakThreshold;
      options.peakMergeMs = peakMergeMs;
    },
    setPracticeTolerancePct: (tolerancePct: number) => {
      options.tolerancePct = tolerancePct;
    },
    setPracticeCorrectionSource: (source: TempoResponsivenessLabel) => {
      options.correctionSource = source;
    },
    setPitchRmsThreshold: (rmsThreshold: number) => {
      options.rmsThreshold = rmsThreshold;
    },
    resetTempo: () => {
      void postControl(endpoint, sessionId, { type: "reset-tempo" }).catch(reportFailure);
    },
  };
}

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function postFrame(
  endpoint: string,
  payload: {
    sessionId: string;
    sampleRate: number;
    fftSize: number;
    minDecibels: number;
    maxDecibels: number;
    tMs: number;
    timeDomain: number[];
    spectrumDb: number[];
    options: BackendPipelineOptions;
  },
): Promise<BackendFrameResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${endpoint}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Backend processing returned ${response.status}`);
    }
    return (await response.json()) as BackendFrameResponse;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function postControl(
  endpoint: string,
  sessionId: string,
  payload: { type: "reset-tempo" },
): Promise<void> {
  const response = await fetch(`${endpoint}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload }),
  });
  if (!response.ok) {
    throw new Error(`Backend control returned ${response.status}`);
  }
}
