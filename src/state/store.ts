import type { NoteEvent, TempoDebugFrame } from "../audio/types";
import type { LiveViewModel } from "../modes/live-mode";

export type AppMode = "live" | "practice" | "sequence" | "sheet-entry" | "spectrum";
export type PracticeTempoStatus =
  | "idle"
  | "insufficient"
  | "play-faster"
  | "play-slower"
  | "on-tempo";

export type PracticeViewModel = {
  targetBpm: number;
  estimatedBpm: number | null;
  differenceBpm: number | null;
  confidence: number;
  status: PracticeTempoStatus;
  novelty: number;
  debug: TempoDebugFrame | null;
};

export type AppState = {
  mode: AppMode;
  listening: boolean;
  recording: boolean;
  live: LiveViewModel;
  practice: PracticeViewModel;
  sequence: NoteEvent[];
};

export function createInitialState(): AppState {
  return {
    mode: "live",
    listening: false,
    recording: false,
    live: {
      detectedMidi: null,
      displayedMidi: null,
      displayedMidiFloat: null,
      confidence: 0,
      freqHz: null,
      cents: null,
      holdingLastNote: false,
    },
    practice: {
      targetBpm: 80,
      estimatedBpm: null,
      differenceBpm: null,
      confidence: 0,
      status: "idle",
      novelty: 0,
      debug: null,
    },
    sequence: [],
  };
}
