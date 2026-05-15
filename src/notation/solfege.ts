export type NoteSpelling = "sharp" | "flat";

export type KeySignaturePreset = {
  id: string;
  label: string;
  kind: "none" | "sharp" | "flat";
  count: number;
  alteredNotes: string[];
};

const SOLFEGE_SHARP = [
  "Do",
  "Do♯",
  "Re",
  "Re♯",
  "Mi",
  "Fa",
  "Fa♯",
  "Sol",
  "Sol♯",
  "La",
  "La♯",
  "Si",
] as const;

const SOLFEGE_FLAT = [
  "Do",
  "Re♭",
  "Re",
  "Mi♭",
  "Mi",
  "Fa",
  "Sol♭",
  "Sol",
  "La♭",
  "La",
  "Si♭",
  "Si",
] as const;

const CHROMATIC_SHARP = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
] as const;

const CHROMATIC_FLAT = [
  "C",
  "D♭",
  "D",
  "E♭",
  "E",
  "F",
  "G♭",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
] as const;

const NATURAL_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

export const KEY_SIGNATURE_PRESETS: KeySignaturePreset[] = [
  {
    id: "do",
    label: "Do major / La minor (no alterations)",
    kind: "none",
    count: 0,
    alteredNotes: [],
  },
  {
    id: "sol",
    label: "Sol major / Mi minor (Fa♯)",
    kind: "sharp",
    count: 1,
    alteredNotes: ["Fa♯"],
  },
  {
    id: "re",
    label: "Re major / Si minor (Fa♯ Do♯)",
    kind: "sharp",
    count: 2,
    alteredNotes: ["Fa♯", "Do♯"],
  },
  {
    id: "la",
    label: "La major / Fa♯ minor (Fa♯ Do♯ Sol♯)",
    kind: "sharp",
    count: 3,
    alteredNotes: ["Fa♯", "Do♯", "Sol♯"],
  },
  {
    id: "mi",
    label: "Mi major / Do♯ minor (Fa♯ Do♯ Sol♯ Re♯)",
    kind: "sharp",
    count: 4,
    alteredNotes: ["Fa♯", "Do♯", "Sol♯", "Re♯"],
  },
  {
    id: "si",
    label: "Si major / Sol♯ minor (Fa♯ Do♯ Sol♯ Re♯ La♯)",
    kind: "sharp",
    count: 5,
    alteredNotes: ["Fa♯", "Do♯", "Sol♯", "Re♯", "La♯"],
  },
  {
    id: "fa-sharp",
    label: "Fa♯ major / Re♯ minor (6 sharps)",
    kind: "sharp",
    count: 6,
    alteredNotes: ["Fa♯", "Do♯", "Sol♯", "Re♯", "La♯", "Mi♯"],
  },
  {
    id: "do-sharp",
    label: "Do♯ major / La♯ minor (7 sharps)",
    kind: "sharp",
    count: 7,
    alteredNotes: ["Fa♯", "Do♯", "Sol♯", "Re♯", "La♯", "Mi♯", "Si♯"],
  },
  {
    id: "fa",
    label: "Fa major / Re minor (Si♭)",
    kind: "flat",
    count: 1,
    alteredNotes: ["Si♭"],
  },
  {
    id: "si-flat",
    label: "Si♭ major / Sol minor (Si♭ Mi♭)",
    kind: "flat",
    count: 2,
    alteredNotes: ["Si♭", "Mi♭"],
  },
  {
    id: "mi-flat",
    label: "Mi♭ major / Do minor (Si♭ Mi♭ La♭)",
    kind: "flat",
    count: 3,
    alteredNotes: ["Si♭", "Mi♭", "La♭"],
  },
  {
    id: "la-flat",
    label: "La♭ major / Fa minor (Si♭ Mi♭ La♭ Re♭)",
    kind: "flat",
    count: 4,
    alteredNotes: ["Si♭", "Mi♭", "La♭", "Re♭"],
  },
  {
    id: "re-flat",
    label: "Re♭ major / Si♭ minor (5 flats)",
    kind: "flat",
    count: 5,
    alteredNotes: ["Si♭", "Mi♭", "La♭", "Re♭", "Sol♭"],
  },
  {
    id: "sol-flat",
    label: "Sol♭ major / Mi♭ minor (6 flats)",
    kind: "flat",
    count: 6,
    alteredNotes: ["Si♭", "Mi♭", "La♭", "Re♭", "Sol♭", "Do♭"],
  },
  {
    id: "do-flat",
    label: "Do♭ major / La♭ minor (7 flats)",
    kind: "flat",
    count: 7,
    alteredNotes: ["Si♭", "Mi♭", "La♭", "Re♭", "Sol♭", "Do♭", "Fa♭"],
  },
];

export function getKeySignaturePreset(id: string): KeySignaturePreset {
  return KEY_SIGNATURE_PRESETS.find((preset) => preset.id === id) ?? KEY_SIGNATURE_PRESETS[0];
}

export function noteSpellingForKeySignature(preset: KeySignaturePreset): NoteSpelling {
  return preset.kind === "flat" ? "flat" : "sharp";
}

export function midiToSolfege(
  midi: number,
  options?: {
    spelling?: NoteSpelling;
    showNatural?: boolean;
  },
): string {
  const index = ((midi % 12) + 12) % 12;
  const spelling = options?.spelling ?? "sharp";
  const base = spelling === "flat" ? SOLFEGE_FLAT[index] : SOLFEGE_SHARP[index];

  if (!options?.showNatural || !NATURAL_PITCH_CLASSES.has(index)) {
    return base;
  }

  return `${base}♮`;
}

export function midiToScientific(
  midi: number,
  spelling: NoteSpelling = "sharp",
): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = spelling === "flat" ? CHROMATIC_FLAT[pc] : CHROMATIC_SHARP[pc];
  return `${name}${octave}`;
}
