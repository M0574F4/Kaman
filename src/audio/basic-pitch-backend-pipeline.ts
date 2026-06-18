import type {
  BasicPitchAnalysisFrame,
  BasicPitchPitchDetection,
} from "./basic-pitch-estimator";
import type { MicHandle } from "./mic";
import type { PipelineHandle } from "./pipeline";
import type { PitchFrame } from "./types";

export const DEFAULT_BASIC_PITCH_BACKEND_ENDPOINT = "http://127.0.0.1:8790";

type BasicPitchBackendHealth = {
  ok: boolean;
  service: string;
  runtime: string;
  modelPath: string;
  platform: string;
};

type BasicPitchBackendResponse = {
  analysis: BasicPitchAnalysisFrame | null;
  pitchFrame: PitchFrame;
};

type BasicPitchBackendConfig = {
  endpoint?: string;
  onError?: (error: Error) => void;
  onAnalysis?: (analysis: BasicPitchAnalysisFrame) => void;
};

export async function checkBasicPitchBackendAvailability(
  endpoint = DEFAULT_BASIC_PITCH_BACKEND_ENDPOINT,
): Promise<BasicPitchBackendHealth> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${endpoint}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Basic Pitch backend health check returned ${response.status}`);
    }
    return (await response.json()) as BasicPitchBackendHealth;
  } catch (error) {
    throw new Error(
      `Basic Pitch OpenVINO backend is not reachable at ${endpoint}. Run npm run basic-pitch-backend, then try again.`,
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function startBasicPitchBackendPipeline(
  mic: MicHandle,
  onFrame: (frame: PitchFrame) => void,
  config: BasicPitchBackendConfig = {},
): PipelineHandle {
  const endpoint = config.endpoint ?? DEFAULT_BASIC_PITCH_BACKEND_ENDPOINT;
  const sessionId = createSessionId();
  const processor = mic.context.createScriptProcessor(4096, 1, 1);
  const silentGain = mic.context.createGain();
  silentGain.gain.value = 0;

  let isRunning = true;
  let failureReported = false;
  let lastCallbackMs: number | null = null;

  const reportFailure = (error: unknown) => {
    if (failureReported || !isRunning) return;
    failureReported = true;
    isRunning = false;
    config.onError?.(
      error instanceof Error ? error : new Error("Basic Pitch backend processing failed."),
    );
  };

  processor.onaudioprocess = (event) => {
    if (!isRunning) return;
    const nowMs = performance.now();
    const audioTapIntervalMs = lastCallbackMs === null ? null : nowMs - lastCallbackMs;
    lastCallbackMs = nowMs;
    const copyStartedAtMs = performance.now();
    const samples = Array.from(event.inputBuffer.getChannelData(0));
    const audioTapCopyMs = performance.now() - copyStartedAtMs;

    void postBasicPitchAudio(endpoint, {
      sessionId,
      sampleRate: mic.context.sampleRate,
      tMs: nowMs,
      samples,
      audioTapCopyMs,
      audioTapIntervalMs,
      options: {
        rmsThreshold: 0.008,
        minFreq: 180,
        maxFreq: 2800,
      },
    })
      .then((result) => {
        if (!isRunning) return;
        onFrame(result.pitchFrame);
        if (result.analysis) {
          config.onAnalysis?.(normalizeBackendAnalysis(result.analysis));
        }
      })
      .catch(reportFailure);
  };

  mic.source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(mic.context.destination);

  return {
    stop: () => {
      isRunning = false;
      processor.onaudioprocess = null;
      processor.disconnect();
      silentGain.disconnect();
    },
    setStringPurityEnabled: () => undefined,
    setPracticeTargetBpm: () => undefined,
    setPracticePeakPicking: () => undefined,
    setPracticeTolerancePct: () => undefined,
    setPracticeCorrectionSource: () => undefined,
    setPitchRmsThreshold: () => undefined,
    resetTempo: () => undefined,
  };
}

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `basic-pitch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function postBasicPitchAudio(
  endpoint: string,
  payload: {
    sessionId: string;
    sampleRate: number;
    tMs: number;
    samples: number[];
    audioTapCopyMs: number;
    audioTapIntervalMs: number | null;
    options: {
      rmsThreshold: number;
      minFreq: number;
      maxFreq: number;
    };
  },
): Promise<BasicPitchBackendResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${endpoint}/basic-pitch/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Basic Pitch backend returned ${response.status}`);
    }
    return (await response.json()) as BasicPitchBackendResponse;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeBackendAnalysis(analysis: BasicPitchAnalysisFrame): BasicPitchAnalysisFrame {
  return {
    ...analysis,
    pitchDetections: analysis.pitchDetections.map(normalizeDetection),
  };
}

function normalizeDetection(detection: BasicPitchPitchDetection): BasicPitchPitchDetection {
  return {
    timeSeconds: detection.timeSeconds,
    midiFloat: detection.midiFloat,
    freqHz: detection.freqHz,
    cents: detection.cents,
    confidence: detection.confidence,
    frameIndex: detection.frameIndex,
    binIndex: detection.binIndex,
  };
}
