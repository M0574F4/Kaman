import type { NoteEvent } from "../audio/types";
import type { LiveViewModel } from "../modes/live-mode";

export type AppMode = "live" | "sequence" | "practice" | "spectrum";

export type AppState = {
  mode: AppMode;
  listening: boolean;
  recording: boolean;
  live: LiveViewModel;
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
    sequence: [],
  };
}
