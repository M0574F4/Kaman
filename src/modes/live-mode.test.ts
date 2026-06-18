import { describe, expect, it } from "vitest";
import type { PitchFrame } from "../audio/types";
import { initialLiveSettings, LiveNoteTracker } from "./live-mode";

describe("LiveNoteTracker", () => {
  it("waits for a stable onset before displaying a note", () => {
    const tracker = new LiveNoteTracker(initialLiveSettings(), 300);

    expect(tracker.update(pitchFrame(0, 69)).displayedMidi).toBeNull();
    expect(tracker.update(pitchFrame(100, 69)).displayedMidi).toBeNull();

    const stable = tracker.update(pitchFrame(160, 69));

    expect(stable.detectedMidi).toBe(69);
    expect(stable.displayedMidi).toBe(69);
    expect(stable.holdingLastNote).toBe(false);
  });

  it("holds the last stable note briefly through silence", () => {
    const tracker = new LiveNoteTracker(initialLiveSettings(), 300);

    tracker.update(pitchFrame(0, 69));
    tracker.update(pitchFrame(160, 69));

    const held = tracker.update(silentFrame(260));
    const expired = tracker.update(silentFrame(500));

    expect(held.displayedMidi).toBe(69);
    expect(held.holdingLastNote).toBe(true);
    expect(expired.displayedMidi).toBeNull();
  });
});

function pitchFrame(tMs: number, midi: number): PitchFrame {
  return {
    tMs,
    freqHz: 440,
    midiFloat: midi,
    midi,
    cents: 0,
    confidence: 0.9,
    stringPurity: null,
    adjacentBleedRatio: null,
    primaryString: null,
    bleedString: null,
  };
}

function silentFrame(tMs: number): PitchFrame {
  return {
    tMs,
    freqHz: null,
    midiFloat: null,
    midi: null,
    cents: null,
    confidence: 0,
    stringPurity: null,
    adjacentBleedRatio: null,
    primaryString: null,
    bleedString: null,
  };
}
