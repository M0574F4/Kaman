import type { LiveViewModel } from "./live-mode";

export type PracticeTargetNote = {
  midi: number;
  beats: number;
};

export type PracticePattern = {
  id: string;
  title: string;
  description: string;
  bpmDefault: number;
  notes: PracticeTargetNote[];
};

export type PracticeTolerance = {
  pitchCents: number;
  onsetMs: number;
  durationMs: number;
};

export type PracticeNoteStatus = "pending" | "active" | "correct" | "wrong" | "missed";

export type PracticeNoteResult = {
  status: PracticeNoteStatus;
  pitchErrorCents: number | null;
  timingErrorMs: number | null;
};

export type PracticeSnapshot = {
  running: boolean;
  complete: boolean;
  currentIndex: number | null;
  elapsedMs: number;
  results: PracticeNoteResult[];
  summary: string;
  feedback: string;
};

const DEFAULT_NOTE_BEATS = 1;

export const PRACTICE_PATTERNS: PracticePattern[] = [
  {
    id: "re-la-re-la-ascending",
    title: "Re La Re La ascending",
    description: "One step upward from each open note: Re-Mi-Fa-Sol-La, La-Si-Do-Re-Mi, Re-Mi-Fa-Sol-La, La-Si-Do-Re-Mi.",
    bpmDefault: 72,
    notes: [
      ...midiRun([74, 76, 77, 79, 81]), // D5 E5 F5 G5 A5
      ...midiRun([69, 71, 72, 74, 76]), // A4 B4 C5 D5 E5
      ...midiRun([62, 64, 65, 67, 69]), // D4 E4 F4 G4 A4
      ...midiRun([57, 59, 60, 62, 64]), // A3 B3 C4 D4 E4
    ],
  },
];

export function initialPracticeTolerance(): PracticeTolerance {
  return {
    pitchCents: 35,
    onsetMs: 140,
    durationMs: 180,
  };
}

export class PracticeSession {
  private readonly beatMs: number;
  private readonly windows: Array<{ startMs: number; endMs: number }>;
  private readonly results: PracticeNoteResult[];
  private currentIndex = 0;
  private running = true;
  private lastFeedback = "Listen to the count and start on the highlighted note.";

  constructor(
    readonly pattern: PracticePattern,
    readonly bpm: number,
    readonly tolerance: PracticeTolerance,
    readonly startedAtMs: number,
  ) {
    this.beatMs = 60_000 / bpm;
    this.windows = buildWindows(pattern, this.beatMs, startedAtMs);
    this.results = pattern.notes.map(() => ({
      status: "pending",
      pitchErrorCents: null,
      timingErrorMs: null,
    }));
    if (this.results[0]) {
      this.results[0].status = "active";
    }
  }

  update(nowMs: number, live: LiveViewModel): PracticeSnapshot {
    if (!this.running) {
      return this.snapshot(nowMs);
    }

    this.markExpiredNotes(nowMs);
    const target = this.pattern.notes[this.currentIndex];
    const window = this.windows[this.currentIndex];
    const result = this.results[this.currentIndex];

    if (!target || !window || !result) {
      this.running = false;
      this.lastFeedback = "Pattern complete.";
      return this.snapshot(nowMs);
    }

    result.status = result.status === "pending" ? "active" : result.status;
    const elapsedMs = nowMs - this.startedAtMs;
    const noteStartMs = window.startMs - this.startedAtMs;
    const noteEndMs = window.endMs - this.startedAtMs;

    if (elapsedMs < noteStartMs - this.tolerance.onsetMs) {
      this.lastFeedback = "Wait for the highlighted note.";
      return this.snapshot(nowMs);
    }

    const playedMidiFloat = live.displayedMidiFloat;
    if (playedMidiFloat === null || live.displayedMidi === null) {
      this.lastFeedback = `Current note window: ${Math.round(noteStartMs)}-${Math.round(noteEndMs)} ms.`;
      return this.snapshot(nowMs);
    }

    const pitchErrorCents = (playedMidiFloat - target.midi) * 100;
    const timingErrorMs = elapsedMs - noteStartMs;
    const pitchOk = Math.abs(pitchErrorCents) <= this.tolerance.pitchCents;
    const onsetOk = Math.abs(timingErrorMs) <= this.tolerance.onsetMs;
    const insidePlayableWindow =
      elapsedMs >= noteStartMs - this.tolerance.onsetMs &&
      elapsedMs <= noteEndMs + this.tolerance.durationMs;

    if (!insidePlayableWindow) {
      return this.snapshot(nowMs);
    }

    result.pitchErrorCents = pitchErrorCents;
    result.timingErrorMs = timingErrorMs;

    if (pitchOk && onsetOk) {
      result.status = "correct";
      this.lastFeedback = `Correct: ${formatSigned(Math.round(pitchErrorCents))} cents, ${formatSigned(Math.round(timingErrorMs))} ms.`;
      this.advance();
      return this.snapshot(nowMs);
    }

    if (pitchOk) {
      result.status = "wrong";
      this.lastFeedback = `Right note, timing off by ${formatSigned(Math.round(timingErrorMs))} ms.`;
      this.advance();
      return this.snapshot(nowMs);
    }

    result.status = "wrong";
    this.lastFeedback = `Wrong note: ${formatSigned(Math.round(pitchErrorCents))} cents from target.`;
    this.advance();
    return this.snapshot(nowMs);
  }

  stop(): PracticeSnapshot {
    this.running = false;
    return this.snapshot(performance.now());
  }

  snapshot(nowMs: number): PracticeSnapshot {
    const correct = this.results.filter((result) => result.status === "correct").length;
    const wrong = this.results.filter((result) => result.status === "wrong").length;
    const missed = this.results.filter((result) => result.status === "missed").length;
    const complete = this.currentIndex >= this.results.length;
    return {
      running: this.running,
      complete,
      currentIndex: complete ? null : this.currentIndex,
      elapsedMs: Math.max(0, nowMs - this.startedAtMs),
      results: this.results.map((result) => ({ ...result })),
      summary: `${correct}/${this.results.length} correct | ${wrong} wrong | ${missed} missed`,
      feedback: this.lastFeedback,
    };
  }

  private markExpiredNotes(nowMs: number): void {
    while (this.currentIndex < this.windows.length) {
      const window = this.windows[this.currentIndex];
      const result = this.results[this.currentIndex];
      if (!window || !result) return;
      if (nowMs <= window.endMs + this.tolerance.durationMs) {
        return;
      }
      if (result.status === "pending" || result.status === "active") {
        result.status = "missed";
        result.timingErrorMs = nowMs - window.startMs;
        this.lastFeedback = "Missed note.";
      }
      this.advance();
    }
  }

  private advance(): void {
    this.currentIndex += 1;
    if (this.currentIndex >= this.results.length) {
      this.running = false;
      this.lastFeedback = "Pattern complete.";
      return;
    }
    const next = this.results[this.currentIndex];
    if (next && next.status === "pending") {
      next.status = "active";
    }
  }
}

function midiRun(midis: number[]): PracticeTargetNote[] {
  return midis.map((midi) => ({ midi, beats: DEFAULT_NOTE_BEATS }));
}

function buildWindows(
  pattern: PracticePattern,
  beatMs: number,
  startedAtMs: number,
): Array<{ startMs: number; endMs: number }> {
  let cursorMs = startedAtMs;
  return pattern.notes.map((note) => {
    const startMs = cursorMs;
    const durationMs = Math.max(0.125, note.beats) * beatMs;
    cursorMs += durationMs;
    return {
      startMs,
      endMs: cursorMs,
    };
  });
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}
