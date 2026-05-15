import type { NoteEvent, PitchFrame, SequenceSettings } from "../audio/types";

type ActiveNote = {
  startMs: number;
  endMs: number;
  midi: number;
  midiFloat: number;
  confidenceAvg: number;
  confidenceCount: number;
};

type CandidateNote = {
  startMs: number;
  lastMs: number;
  midi: number;
  midiFloat: number;
  confidenceAvg: number;
};

const CONFIDENCE_THRESHOLD = 0.25;
const ONSET_STABLE_MS = 90;
const CHANGE_STABLE_MS = 110;
const DEADBAND_CENTS = 35;

export function initialSequenceSettings(): SequenceSettings {
  return {
    bpm: 80,
    timeSignature: "4/4",
    quantization: "1/8",
    minNoteMs: 100,
    minRestMs: 140,
  };
}

export class SequenceCollector {
  private settings: SequenceSettings;
  private active: ActiveNote | null = null;
  private candidate: CandidateNote | null = null;
  private readonly events: NoteEvent[] = [];

  constructor(initialSettings?: SequenceSettings) {
    this.settings = initialSettings ? { ...initialSettings } : initialSequenceSettings();
  }

  addFrame(frame: PitchFrame): void {
    const observation = toObservation(frame);

    if (!this.active) {
      if (!observation) {
        this.candidate = null;
        return;
      }

      this.updateCandidate(observation, frame.tMs);
      if (this.candidateDurationMs() >= ONSET_STABLE_MS) {
        this.startActiveFromCandidate();
      }
      return;
    }

    if (!observation) {
      this.candidate = null;
      if (frame.tMs - this.active.endMs >= this.settings.minRestMs) {
        this.flushActive();
      }
      return;
    }

    if (isWithinDeadband(this.active, observation, DEADBAND_CENTS)) {
      this.extendActive(observation, frame.tMs);
      this.candidate = null;
      return;
    }

    this.updateCandidate(observation, frame.tMs);
    if (this.candidateDurationMs() >= CHANGE_STABLE_MS) {
      const splitAt = this.candidate ? this.candidate.startMs : frame.tMs;
      this.flushActive(splitAt);
      this.startActiveFromCandidate();
    }
  }

  stop(finalTimeMs: number): NoteEvent[] {
    if (this.active) {
      if (finalTimeMs > this.active.endMs) {
        this.active.endMs = finalTimeMs;
      }
      this.flushActive();
    }
    this.candidate = null;
    return cleanupMicroNotes(this.events, this.settings.minNoteMs);
  }

  reset(): void {
    this.active = null;
    this.candidate = null;
    this.events.length = 0;
  }

  setSettings(nextSettings: SequenceSettings): void {
    this.settings = { ...nextSettings };
  }

  snapshot(nowMs: number): NoteEvent[] {
    const base = cleanupMicroNotes(this.events, this.settings.minNoteMs);
    if (!this.active) {
      return base;
    }

    const preview: NoteEvent = {
      startMs: this.active.startMs,
      endMs: Math.max(this.active.endMs, nowMs),
      midi: this.active.midi,
      confidenceAvg: this.active.confidenceAvg,
    };

    return cleanupMicroNotes([...base, preview], this.settings.minNoteMs);
  }

  private updateCandidate(observation: Observation, tMs: number): void {
    if (!this.candidate || this.candidate.midi !== observation.midi) {
      this.candidate = {
        startMs: tMs,
        lastMs: tMs,
        midi: observation.midi,
        midiFloat: observation.midiFloat,
        confidenceAvg: observation.confidence,
      };
      return;
    }

    this.candidate.lastMs = tMs;
    this.candidate.midiFloat = smooth(this.candidate.midiFloat, observation.midiFloat);
    this.candidate.confidenceAvg = smooth(this.candidate.confidenceAvg, observation.confidence);
  }

  private candidateDurationMs(): number {
    if (!this.candidate) return 0;
    return this.candidate.lastMs - this.candidate.startMs;
  }

  private startActiveFromCandidate(): void {
    if (!this.candidate) return;
    this.active = {
      startMs: this.candidate.startMs,
      endMs: this.candidate.lastMs,
      midi: this.candidate.midi,
      midiFloat: this.candidate.midiFloat,
      confidenceAvg: this.candidate.confidenceAvg,
      confidenceCount: 1,
    };
    this.candidate = null;
  }

  private extendActive(observation: Observation, tMs: number): void {
    if (!this.active) return;

    this.active.endMs = tMs;
    this.active.midiFloat = smooth(this.active.midiFloat, observation.midiFloat);
    this.active.confidenceCount += 1;
    this.active.confidenceAvg +=
      (observation.confidence - this.active.confidenceAvg) / this.active.confidenceCount;
  }

  private flushActive(endMsOverride?: number): void {
    if (!this.active) return;

    const endMs = endMsOverride !== undefined ? Math.max(this.active.startMs, endMsOverride) : this.active.endMs;
    if (endMs > this.active.startMs) {
      this.events.push({
        startMs: this.active.startMs,
        endMs,
        midi: Math.round(this.active.midiFloat),
        confidenceAvg: this.active.confidenceAvg,
      });
    }

    this.active = null;
  }
}

type Observation = {
  midi: number;
  midiFloat: number;
  confidence: number;
};

function toObservation(frame: PitchFrame): Observation | null {
  if (
    frame.midi === null ||
    frame.midiFloat === null ||
    frame.confidence < CONFIDENCE_THRESHOLD
  ) {
    return null;
  }

  return {
    midi: frame.midi,
    midiFloat: frame.midiFloat,
    confidence: frame.confidence,
  };
}

function isWithinDeadband(active: ActiveNote, observation: Observation, deadbandCents: number): boolean {
  const midiDistance = Math.abs(observation.midiFloat - active.midi);
  return midiDistance <= deadbandCents / 100;
}

function cleanupMicroNotes(events: NoteEvent[], minNoteMs: number): NoteEvent[] {
  const cleaned: NoteEvent[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const durationMs = event.endMs - event.startMs;
    if (durationMs >= minNoteMs) {
      cleaned.push(event);
      continue;
    }

    const prev = cleaned[cleaned.length - 1] ?? null;
    const next = events[i + 1] ?? null;

    if (prev && next && prev.midi === next.midi) {
      prev.endMs = next.endMs;
      prev.confidenceAvg = (prev.confidenceAvg + next.confidenceAvg) / 2;
      i += 1;
      continue;
    }

    if (prev && Math.abs(prev.midi - event.midi) <= 1) {
      prev.endMs = Math.max(prev.endMs, event.endMs);
      prev.confidenceAvg = (prev.confidenceAvg + event.confidenceAvg) / 2;
      continue;
    }

    if (next && Math.abs(next.midi - event.midi) <= 1) {
      continue;
    }

    // Otherwise drop the micro event.
  }

  return cleaned;
}

function smooth(previous: number, next: number): number {
  return previous * 0.65 + next * 0.35;
}
