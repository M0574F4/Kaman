import { describe, expect, it } from "vitest";
import type { PitchFrame } from "../audio/types";
import { initialSequenceSettings, SequenceCollector } from "./sequence-mode";

describe("SequenceCollector", () => {
  it("captures a stable note and flushes it after silence", () => {
    const collector = new SequenceCollector(initialSequenceSettings());

    collector.addFrame(pitchFrame(0, 69));
    collector.addFrame(pitchFrame(100, 69));
    collector.addFrame(pitchFrame(180, 69));
    collector.addFrame(silentFrame(360));

    const events = collector.stop(420);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ midi: 69, startMs: 0, endMs: 180 });
  });

  it("splits two sustained notes after a stable pitch change", () => {
    const collector = new SequenceCollector(initialSequenceSettings());

    collector.addFrame(pitchFrame(0, 69));
    collector.addFrame(pitchFrame(100, 69));
    collector.addFrame(pitchFrame(200, 69));
    collector.addFrame(pitchFrame(300, 71));
    collector.addFrame(pitchFrame(420, 71));
    collector.addFrame(pitchFrame(520, 71));

    const events = collector.stop(650);

    expect(events.map((event) => event.midi)).toEqual([69, 71]);
    expect(events[0].endMs).toBe(300);
    expect(events[1].startMs).toBe(300);
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
