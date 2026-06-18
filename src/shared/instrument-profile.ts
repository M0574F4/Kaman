import { midiToFrequency } from "./music";

export type InstrumentStringId = string;

export type InstrumentProfileString = {
  id: InstrumentStringId;
  label: string;
  openMidi: number;
  openHz: number;
  solfege: string;
};

export type InstrumentProfile = {
  id: string;
  name: string;
  strings: InstrumentProfileString[];
  minMidi: number;
  maxMidi: number;
};

export const DEFAULT_INSTRUMENT_PROFILE: InstrumentProfile = {
  id: "kamancheh-standard",
  name: "Kamancheh standard",
  strings: [
    { id: "s1", label: "S1", openMidi: 74, openHz: midiToFrequency(74), solfege: "Re" },
    { id: "s2", label: "S2", openMidi: 69, openHz: midiToFrequency(69), solfege: "La" },
    { id: "s3", label: "S3", openMidi: 62, openHz: midiToFrequency(62), solfege: "Re" },
    { id: "s4", label: "S4", openMidi: 57, openHz: midiToFrequency(57), solfege: "La" },
  ],
  minMidi: 55,
  maxMidi: 100,
};

export const DEFAULT_INSTRUMENT_STRINGS = DEFAULT_INSTRUMENT_PROFILE.strings;
export const INSTRUMENT_FINGER_SEMITONES = [0, 2, 4, 5, 7] as const;

export function instrumentStringById(id: InstrumentStringId): InstrumentProfileString | null {
  return DEFAULT_INSTRUMENT_STRINGS.find((string) => string.id === id) ?? null;
}

export function instrumentStringLabel(id: InstrumentStringId): string {
  return instrumentStringById(id)?.label ?? id;
}

export function instrumentStringOpenMidi(id: InstrumentStringId): number | null {
  return instrumentStringById(id)?.openMidi ?? null;
}

export function instrumentStringSolfege(id: InstrumentStringId): string {
  return instrumentStringById(id)?.solfege ?? instrumentStringLabel(id);
}
