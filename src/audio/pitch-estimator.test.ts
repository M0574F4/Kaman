import { describe, expect, it } from "vitest";
import { selectBasicPitchFrame } from "./basic-pitch-estimator";
import { AutoCorrelationPitchEstimator } from "./pitch-estimator";
import { silence, sineWave } from "../test/audio-fixtures";

describe("AutoCorrelationPitchEstimator", () => {
  it("detects a clean A4 sine wave", () => {
    const sampleRate = 44_100;
    const estimator = new AutoCorrelationPitchEstimator(sampleRate);

    const frame = estimator.process(sineWave(440, sampleRate, 4096), 120);

    expect(frame.midi).toBe(69);
    expect(frame.freqHz).toBeCloseTo(440, 0);
    expect(frame.confidence).toBeGreaterThan(0.9);
  });

  it("returns silence for a quiet microphone floor", () => {
    const estimator = new AutoCorrelationPitchEstimator(44_100);

    const frame = estimator.process(silence(4096), 200);

    expect(frame.freqHz).toBeNull();
    expect(frame.midi).toBeNull();
    expect(frame.confidence).toBe(0);
  });
});

describe("selectBasicPitchFrame", () => {
  it("uses the most recent Basic Pitch note as a PitchFrame", () => {
    const frame = selectBasicPitchFrame(
      [
        {
          startTimeSeconds: 0.2,
          durationSeconds: 0.3,
          pitchMidi: 67,
          amplitude: 0.8,
        },
        {
          startTimeSeconds: 1.8,
          durationSeconds: 0.4,
          pitchMidi: 69,
          amplitude: 0.72,
        },
      ],
      2.4,
      1200,
    );

    expect(frame.midi).toBe(69);
    expect(frame.freqHz).toBeCloseTo(440, 0);
    expect(frame.confidence).toBeCloseTo(0.72);
  });
});
