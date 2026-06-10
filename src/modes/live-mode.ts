import type { LiveSettings, PitchFrame } from "../audio/types";

export type LiveViewModel = {
  detectedMidi: number | null;
  displayedMidi: number | null;
  displayedMidiFloat: number | null;
  confidence: number;
  freqHz: number | null;
  cents: number | null;
  holdingLastNote: boolean;
};

type CandidateNote = {
  midi: number;
  midiFloat: number;
  freqHz: number;
  cents: number;
  confidence: number;
  startMs: number;
  lastMs: number;
};

type StableNote = {
  midi: number;
  midiFloat: number;
  freqHz: number;
  cents: number;
  confidence: number;
  lastMs: number;
};

const MIN_ONSET_STABLE_MS = 150;
const MIN_CHANGE_STABLE_MS = 150;
const PITCH_DEADBAND_CENTS = 35;

export function initialLiveSettings(): LiveSettings {
  return {
    a4Hz: 440,
    minMidi: 55,
    maxMidi: 100,
    confidenceThreshold: 0.42,
  };
}

export class LiveNoteTracker {
  private stable: StableNote | null = null;
  private candidate: CandidateNote | null = null;

  constructor(
    private readonly settings: LiveSettings,
    private readonly holdMs: number,
  ) {}

  update(frame: PitchFrame): LiveViewModel {
    const observation = this.toObservation(frame);

    if (this.stable === null) {
      if (observation === null) {
        this.clearIfExpired(frame.tMs);
      } else {
        this.updateCandidate(observation, frame.tMs);
        if (this.candidateDurationMs() >= MIN_ONSET_STABLE_MS) {
          this.promoteCandidate();
        }
      }
    } else if (observation === null) {
      this.clearIfExpired(frame.tMs);
      this.candidate = null;
    } else if (isWithinDeadband(this.stable, observation, PITCH_DEADBAND_CENTS)) {
      this.stable = {
        ...observation,
        lastMs: frame.tMs,
      };
      this.candidate = null;
    } else {
      this.updateCandidate(observation, frame.tMs);
      if (this.candidateDurationMs() >= MIN_CHANGE_STABLE_MS) {
        this.promoteCandidate();
      }
    }

    const detectedMidi = observation ? observation.midi : null;
    const holdingLastNote =
      detectedMidi === null &&
      this.stable !== null &&
      frame.tMs - this.stable.lastMs <= this.holdMs;

    return {
      detectedMidi,
      displayedMidi: this.stable ? this.stable.midi : null,
      displayedMidiFloat: this.stable ? this.stable.midiFloat : null,
      confidence: this.stable ? this.stable.confidence : 0,
      freqHz: this.stable ? this.stable.freqHz : null,
      cents: this.stable ? this.stable.cents : null,
      holdingLastNote,
    };
  }

  reset(): void {
    this.stable = null;
    this.candidate = null;
  }

  private toObservation(frame: PitchFrame): Omit<StableNote, "lastMs"> | null {
    const { midi, midiFloat, freqHz, cents, confidence } = frame;
    if (
      midi === null ||
      midiFloat === null ||
      freqHz === null ||
      cents === null ||
      midi < this.settings.minMidi ||
      midi > this.settings.maxMidi ||
      confidence < this.settings.confidenceThreshold
    ) {
      return null;
    }

    return {
      midi,
      midiFloat,
      freqHz,
      cents,
      confidence,
    };
  }

  private updateCandidate(observation: Omit<StableNote, "lastMs">, tMs: number): void {
    if (!this.candidate || this.candidate.midi !== observation.midi) {
      this.candidate = {
        ...observation,
        startMs: tMs,
        lastMs: tMs,
      };
      return;
    }

    // Exponential smoothing makes candidate pitch less jumpy during onset.
    this.candidate = {
      midi: this.candidate.midi,
      midiFloat: smooth(this.candidate.midiFloat, observation.midiFloat),
      freqHz: smooth(this.candidate.freqHz, observation.freqHz),
      cents: smooth(this.candidate.cents, observation.cents),
      confidence: smooth(this.candidate.confidence, observation.confidence),
      startMs: this.candidate.startMs,
      lastMs: tMs,
    };
  }

  private candidateDurationMs(): number {
    if (!this.candidate) return 0;
    return this.candidate.lastMs - this.candidate.startMs;
  }

  private promoteCandidate(): void {
    if (!this.candidate) return;
    this.stable = {
      midi: this.candidate.midi,
      midiFloat: this.candidate.midiFloat,
      freqHz: this.candidate.freqHz,
      cents: this.candidate.cents,
      confidence: this.candidate.confidence,
      lastMs: this.candidate.lastMs,
    };
    this.candidate = null;
  }

  private clearIfExpired(nowMs: number): void {
    if (!this.stable) return;
    if (nowMs - this.stable.lastMs > this.holdMs) {
      this.stable = null;
      this.candidate = null;
    }
  }
}

function isWithinDeadband(
  stable: StableNote,
  observation: Omit<StableNote, "lastMs">,
  deadbandCents: number,
): boolean {
  const midiDistance = Math.abs(observation.midiFloat - stable.midi);
  return midiDistance <= deadbandCents / 100;
}

function smooth(previous: number, next: number): number {
  return previous * 0.65 + next * 0.35;
}
