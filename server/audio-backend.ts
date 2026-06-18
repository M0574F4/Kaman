import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { AutoCorrelationPitchEstimator } from "../src/audio/pitch-estimator";
import { TempoEstimator } from "../src/audio/tempo-estimator";
import type {
  PracticePattern,
  PracticePatternLoopMode,
  PracticePatternNote,
} from "../src/features/practice/patterns";
import type {
  PitchFrame,
  TempoFrame,
  TempoResponsivenessLabel,
} from "../src/audio/types";

type BackendPipelineOptions = {
  stringPurityEnabled: boolean;
  targetBpm: number;
  peakThreshold: number;
  peakMergeMs: number;
  tolerancePct: number;
  correctionSource: TempoResponsivenessLabel;
  rmsThreshold: number;
};

type ProcessPayload = {
  sessionId: string;
  sampleRate: number;
  fftSize: number;
  minDecibels: number;
  maxDecibels: number;
  tMs: number;
  timeDomain: number[];
  spectrumDb: number[];
  options: BackendPipelineOptions;
};

type ControlPayload = {
  sessionId: string;
  type: "reset-tempo";
};

type SavePatternPayload = {
  name: string;
  defaultLoop: boolean;
  defaultLoopMode: PracticePatternLoopMode;
  defaultCountInBeats: number;
  tempoRamp?: PracticePattern["tempoRamp"];
  notes: PracticePatternNote[];
};

type BackendSession = {
  sampleRate: number;
  fftSize: number;
  pitchEstimator: AutoCorrelationPitchEstimator;
  tempoEstimator: TempoEstimator;
  lastUsedAt: number;
};

const PORT = Number.parseInt(process.env.KAMAN_AUDIO_BACKEND_PORT ?? "8787", 10);
const HOST = process.env.KAMAN_AUDIO_BACKEND_HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 4_000_000;
const SESSION_TTL_MS = 5 * 60_000;
const CUSTOM_PATTERN_DIR = join(process.cwd(), ".kaman");
const CUSTOM_PATTERN_FILE = join(CUSTOM_PATTERN_DIR, "custom-patterns.json");
const MAX_CUSTOM_PATTERNS = 200;
const MAX_PATTERN_NOTES = 256;
const sessions = new Map<string, BackendSession>();

const server = createServer((request, response) => {
  setCorsHeaders(request, response);
  if (!isAllowedOrigin(request.headers.origin)) {
    sendJson(response, 403, { error: "Origin not allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "kaman-audio-backend",
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/patterns") {
    void readCustomPatterns()
      .then((patterns) => {
        sendJson(response, 200, { patterns });
      })
      .catch((error) => {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "Could not read patterns",
        });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/patterns") {
    void readJson<SavePatternPayload>(request)
      .then((payload) => saveCustomPattern(payload))
      .then((pattern) => {
        sendJson(response, 201, { pattern });
      })
      .catch((error) => {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid pattern",
        });
      });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/patterns/")) {
    const id = decodeURIComponent(url.pathname.slice("/patterns/".length));
    void deleteCustomPattern(id)
      .then((deleted) => {
        sendJson(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Pattern not found" });
      })
      .catch((error) => {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Could not delete pattern",
        });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/process") {
    void readJson<ProcessPayload>(request)
      .then((payload) => {
        const result = processFrame(payload);
        sendJson(response, 200, result);
      })
      .catch((error) => {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid processing request",
        });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/control") {
    void readJson<ControlPayload>(request)
      .then((payload) => {
        const session = sessions.get(payload.sessionId);
        if (payload.type === "reset-tempo" && session) {
          session.tempoEstimator.reset();
          session.lastUsedAt = Date.now();
        }
        sendJson(response, 200, { ok: true });
      })
      .catch((error) => {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid control request",
        });
      });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Kaman audio backend listening at http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Kaman audio backend failed to start: ${message}`);
  console.error("Check that the port is free, or set KAMAN_AUDIO_BACKEND_PORT to another port.");
  process.exit(1);
});

function processFrame(payload: ProcessPayload): {
  pitchFrame: PitchFrame;
  spectrumFrame: {
    tMs: number;
    sampleRate: number;
    fftSize: number;
    minDecibels: number;
    maxDecibels: number;
    magnitudesDb: number[];
  };
  tempoFrame: TempoFrame;
} {
  validateProcessPayload(payload);
  cleanupSessions();

  const session = getSession(payload.sessionId, payload.sampleRate, payload.fftSize);
  const timeDomain = Float32Array.from(payload.timeDomain);
  const spectrumDb = Float32Array.from(payload.spectrumDb);

  session.pitchEstimator.setStringPurityEnabled(payload.options.stringPurityEnabled);
  session.pitchEstimator.setRmsThreshold(payload.options.rmsThreshold);
  session.tempoEstimator.setTargetBpm(payload.options.targetBpm);
  session.tempoEstimator.setPeakPickingOptions(
    payload.options.peakThreshold,
    payload.options.peakMergeMs,
  );
  session.tempoEstimator.setTolerancePct(payload.options.tolerancePct);
  session.tempoEstimator.setCorrectionEstimateLabel(payload.options.correctionSource);
  session.lastUsedAt = Date.now();

  const pitchFrame = session.pitchEstimator.process(timeDomain, payload.tMs);
  const tempoFrame = session.tempoEstimator.process(
    timeDomain,
    spectrumDb,
    pitchFrame,
    payload.tMs,
  );

  return {
    pitchFrame,
    spectrumFrame: {
      tMs: pitchFrame.tMs,
      sampleRate: payload.sampleRate,
      fftSize: payload.fftSize,
      minDecibels: payload.minDecibels,
      maxDecibels: payload.maxDecibels,
      magnitudesDb: payload.spectrumDb,
    },
    tempoFrame,
  };
}

function getSession(sessionId: string, sampleRate: number, fftSize: number): BackendSession {
  const existing = sessions.get(sessionId);
  if (existing && existing.sampleRate === sampleRate && existing.fftSize === fftSize) {
    return existing;
  }

  const session = {
    sampleRate,
    fftSize,
    pitchEstimator: new AutoCorrelationPitchEstimator(sampleRate),
    tempoEstimator: new TempoEstimator(sampleRate, fftSize, { targetBpm: 80 }),
    lastUsedAt: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

function cleanupSessions(): void {
  const expiresBefore = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions) {
    if (session.lastUsedAt < expiresBefore) {
      sessions.delete(sessionId);
    }
  }
}

function validateProcessPayload(payload: ProcessPayload): void {
  if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId) {
    throw new Error("Missing sessionId");
  }
  if (!Number.isFinite(payload.sampleRate) || payload.sampleRate <= 0) {
    throw new Error("Invalid sampleRate");
  }
  if (!Number.isFinite(payload.fftSize) || payload.fftSize <= 0) {
    throw new Error("Invalid fftSize");
  }
  if (!Number.isFinite(payload.tMs)) {
    throw new Error("Invalid tMs");
  }
  if (!Array.isArray(payload.timeDomain) || payload.timeDomain.length === 0) {
    throw new Error("Missing timeDomain buffer");
  }
  if (!Array.isArray(payload.spectrumDb) || payload.spectrumDb.length === 0) {
    throw new Error("Missing spectrumDb buffer");
  }
}

async function readCustomPatterns(): Promise<PracticePattern[]> {
  try {
    const text = await readFile(CUSTOM_PATTERN_FILE, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => normalizeStoredPattern(item))
      .filter((pattern): pattern is PracticePattern => pattern !== null)
      .slice(0, MAX_CUSTOM_PATTERNS);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveCustomPattern(payload: SavePatternPayload): Promise<PracticePattern> {
  const existing = await readCustomPatterns();
  if (existing.length >= MAX_CUSTOM_PATTERNS) {
    throw new Error("Too many custom patterns saved");
  }
  const pattern = normalizeNewPattern(payload, existing);
  await writeCustomPatterns([...existing, pattern]);
  return pattern;
}

async function deleteCustomPattern(id: string): Promise<boolean> {
  if (!/^custom-[a-z0-9-]{1,96}$/.test(id)) {
    throw new Error("Invalid pattern id");
  }
  const existing = await readCustomPatterns();
  const next = existing.filter((pattern) => pattern.id !== id);
  if (next.length === existing.length) {
    return false;
  }
  await writeCustomPatterns(next);
  return true;
}

async function writeCustomPatterns(patterns: PracticePattern[]): Promise<void> {
  await mkdir(CUSTOM_PATTERN_DIR, { recursive: true });
  await writeFile(CUSTOM_PATTERN_FILE, `${JSON.stringify(patterns, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeNewPattern(payload: SavePatternPayload, existing: PracticePattern[]): PracticePattern {
  const name = sanitizePatternName(payload.name);
  const slug = slugify(name);
  const existingIds = new Set(existing.map((pattern) => pattern.id));
  let id = `custom-${slug}-${Date.now().toString(36)}`;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `custom-${slug}-${Date.now().toString(36)}-${suffix}`;
    suffix += 1;
  }

  const notes = normalizePatternNotes(payload.notes);
  return {
    id,
    name,
    defaultLoop: Boolean(payload.defaultLoop),
    defaultLoopMode: normalizeLoopMode(payload.defaultLoopMode),
    defaultCountInBeats: normalizeCountIn(payload.defaultCountInBeats),
    tempoRamp: normalizeTempoRamp(payload.tempoRamp),
    notes,
  };
}

function normalizeStoredPattern(value: unknown): PracticePattern | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Partial<PracticePattern>;
  if (typeof item.id !== "string" || !/^custom-[a-z0-9-]{1,96}$/.test(item.id)) {
    return null;
  }
  try {
    return {
      id: item.id,
      name: sanitizePatternName(item.name),
      defaultLoop: Boolean(item.defaultLoop),
      defaultLoopMode: normalizeLoopMode(item.defaultLoopMode),
      defaultCountInBeats: normalizeCountIn(item.defaultCountInBeats),
      tempoRamp: normalizeTempoRamp(item.tempoRamp),
      notes: normalizePatternNotes(item.notes),
    };
  } catch {
    return null;
  }
}

function sanitizePatternName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Pattern name is required");
  }
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 1) {
    throw new Error("Pattern name is required");
  }
  if (name.length > 60) {
    throw new Error("Pattern name must be 60 characters or less");
  }
  return name;
}

function normalizeLoopMode(value: unknown): PracticePatternLoopMode {
  return value === "back-and-forth" ? "back-and-forth" : "restart";
}

function normalizeCountIn(value: unknown): number {
  const count = typeof value === "number" ? value : 4;
  return clampInteger(count, 0, 8);
}

function normalizeTempoRamp(value: unknown): PracticePattern["tempoRamp"] {
  const fallback = { initialBpm: 40, stepBpm: 0, maxBpm: 140 };
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const ramp = value as Partial<NonNullable<PracticePattern["tempoRamp"]>>;
  const initialBpm = clampInteger(ramp.initialBpm, 30, 240);
  const stepBpm = clampInteger(ramp.stepBpm, 0, 60);
  const maxBpm = clampInteger(ramp.maxBpm, initialBpm, 240);
  return { initialBpm, stepBpm, maxBpm };
}

function normalizePatternNotes(value: unknown): PracticePatternNote[] {
  if (!Array.isArray(value)) {
    throw new Error("Pattern notes are required");
  }
  if (value.length < 1) {
    throw new Error("Pattern needs at least one note");
  }
  if (value.length > MAX_PATTERN_NOTES) {
    throw new Error(`Pattern can contain at most ${MAX_PATTERN_NOTES} notes`);
  }
  return value.map((note) => {
    if (!note || typeof note !== "object") {
      throw new Error("Invalid note");
    }
    const item = note as Partial<PracticePatternNote>;
    const midi = clampInteger(item.midi, 0, 127);
    const durationBeats = normalizeNoteDurationBeats(item.durationBeats);
    const label = typeof item.label === "string"
      ? item.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24)
      : "";
    return {
      midi,
      label: label || `MIDI ${midi}`,
      durationBeats,
    };
  });
}

function normalizeNoteDurationBeats(value: unknown): number {
  const numeric = typeof value === "number" ? value : 1;
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(0.25, Math.min(16, Math.round(numeric * 4) / 4));
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return slug || "pattern";
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function readJson<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (isAllowedOrigin(origin)) {
    response.setHeader("access-control-allow-origin", origin ?? "null");
  }
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-private-network", "true");
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}
