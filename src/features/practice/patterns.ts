import { midiToSolfege } from "../../notation/solfege";

export type PracticePatternLoopMode = "restart" | "back-and-forth";

export type PracticePatternNote = {
  midi: number;
  label: string;
  durationBeats?: number;
};

export type PracticePattern = {
  id: string;
  name: string;
  defaultLoop: boolean;
  defaultLoopMode: PracticePatternLoopMode;
  defaultCountInBeats: number;
  tempoRamp?: {
    initialBpm: number;
    stepBpm: number;
    maxBpm: number;
  };
  notes: PracticePatternNote[];
};

export const PATTERN_ENTRY_ID = "pattern-entry";
export const STAFF_BOTTOM_LINE_STEP = 30;

export const PRACTICE_PATTERNS: PracticePattern[] = [
  {
    id: "warmup1",
    name: "Warmup 1",
    defaultLoop: true,
    defaultLoopMode: "back-and-forth",
    defaultCountInBeats: 4,
    tempoRamp: {
      initialBpm: 40,
      stepBpm: 10,
      maxBpm: 140,
    },
    notes: [
      ...makeWarmupGroup(74, "Re"),
      ...makeWarmupGroup(69, "La"),
      ...makeWarmupGroup(62, "Re"),
      ...makeWarmupGroup(57, "La"),
    ],
  },
  {
    id: "warmup2",
    name: "Warmup 2",
    defaultLoop: true,
    defaultLoopMode: "back-and-forth",
    defaultCountInBeats: 4,
    tempoRamp: {
      initialBpm: 40,
      stepBpm: 10,
      maxBpm: 140,
    },
    notes: [
      ...makeWarmupGroup(74, "Re", 2),
      ...makeWarmupGroup(69, "La", 2),
      ...makeWarmupGroup(62, "Re", 2),
      ...makeWarmupGroup(57, "La", 2),
    ],
  },
  {
    id: "line-walk",
    name: "Line Walk",
    defaultLoop: true,
    defaultLoopMode: "back-and-forth",
    defaultCountInBeats: 4,
    tempoRamp: {
      initialBpm: 40,
      stepBpm: 10,
      maxBpm: 140,
    },
    notes: makeStaffStepRun(STAFF_BOTTOM_LINE_STEP - 4, STAFF_BOTTOM_LINE_STEP + 10),
  },
  {
    id: PATTERN_ENTRY_ID,
    name: "Pattern Entry",
    defaultLoop: true,
    defaultLoopMode: "restart",
    defaultCountInBeats: 4,
    tempoRamp: {
      initialBpm: 40,
      stepBpm: 0,
      maxBpm: 140,
    },
    notes: [],
  },
];

function makeWarmupGroup(
  midi: number,
  label: PracticePatternNote["label"],
  repeatCount = 4,
): PracticePatternNote[] {
  return Array.from({ length: repeatCount }, () => ({ midi, label }));
}

function makeStaffStepRun(startStep: number, endStep: number): PracticePatternNote[] {
  const direction = startStep <= endStep ? 1 : -1;
  const length = Math.abs(endStep - startStep) + 1;

  return Array.from({ length }, (_, index) => {
    const midi = diatonicStepToNaturalMidi(startStep + index * direction);
    return {
      midi,
      label: midiToSolfege(midi),
    };
  });
}

function diatonicStepToNaturalMidi(step: number): number {
  const octave = Math.floor(step / 7);
  const letterStep = ((step % 7) + 7) % 7;
  const pitchClass = [0, 2, 4, 5, 7, 9, 11][letterStep] ?? 0;
  return (octave + 1) * 12 + pitchClass;
}
