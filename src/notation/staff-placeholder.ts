import type { NoteEvent } from "../audio/types";

const STAFF = {
  topLineY: 26,
  lineGap: 26,
  lineCount: 5,
};

// Treble clef bottom line is E4. We map diatonic steps for staff placement.
const E4_STEP = toDiatonicStep(64);
const B4_STEP = toDiatonicStep(71); // middle line
const TOP_LINE_STEP = toDiatonicStep(77); // F5
const BOTTOM_LINE_STEP = toDiatonicStep(64); // E4

export type StemDirection = "up" | "down";

export function midiToStaffY(midi: number): number {
  const step = toDiatonicStep(midi);
  const stepDiff = step - E4_STEP;
  const bottomLineY = STAFF.topLineY + STAFF.lineGap * (STAFF.lineCount - 1);
  return bottomLineY - stepDiff * (STAFF.lineGap / 2);
}

export function midiWithCentsToStaffY(midi: number, cents: number | null): number {
  const baseY = midiToStaffY(midi);
  if (cents === null) {
    return baseY;
  }

  // Educational visualization: nudge around the quantized staff position by cents.
  const clampedCents = Math.max(-50, Math.min(50, cents));
  return baseY - (clampedCents / 100) * (STAFF.lineGap / 2);
}

export function stemDirectionForMidi(midi: number): StemDirection {
  const step = toDiatonicStep(midi);
  return step >= B4_STEP ? "down" : "up";
}

export function ledgerLineYs(midi: number): number[] {
  const step = toDiatonicStep(midi);
  const yValues: number[] = [];

  if (step > TOP_LINE_STEP) {
    for (let s = TOP_LINE_STEP + 2; s <= step; s += 2) {
      yValues.push(midiToStaffYFromStep(s));
    }
  } else if (step < BOTTOM_LINE_STEP) {
    for (let s = BOTTOM_LINE_STEP - 2; s >= step; s -= 2) {
      yValues.push(midiToStaffYFromStep(s));
    }
  }

  return yValues;
}

export function renderSequenceSummary(notes: NoteEvent[]): string {
  if (notes.length === 0) {
    return "No notes captured yet.";
  }

  return notes
    .map((n, i) => {
      const duration = Math.round(n.endMs - n.startMs);
      return `${i + 1}. MIDI ${n.midi}, ${duration} ms, conf ${n.confidenceAvg.toFixed(2)}`;
    })
    .join("\n");
}

function toDiatonicStep(midi: number): number {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;

  const letterStep = pitchClassToLetterStep(pitchClass);
  return octave * 7 + letterStep;
}

function midiToStaffYFromStep(step: number): number {
  const stepDiff = step - E4_STEP;
  const bottomLineY = STAFF.topLineY + STAFF.lineGap * (STAFF.lineCount - 1);
  return bottomLineY - stepDiff * (STAFF.lineGap / 2);
}

function pitchClassToLetterStep(pitchClass: number): number {
  switch (pitchClass) {
    case 0:
    case 1:
      return 0; // C/C#
    case 2:
    case 3:
      return 1; // D/D#
    case 4:
      return 2; // E
    case 5:
    case 6:
      return 3; // F/F#
    case 7:
    case 8:
      return 4; // G/G#
    case 9:
    case 10:
      return 5; // A/A#
    case 11:
      return 6; // B
    default:
      return 0;
  }
}
