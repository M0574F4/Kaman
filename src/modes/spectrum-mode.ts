import type { InstrumentStringName, PitchFrame, SpectrumFrame } from "../audio/types";
import { midiToScientific, midiToSolfege } from "../notation/solfege";
import {
  DEFAULT_INSTRUMENT_STRINGS,
  instrumentStringLabel,
} from "../shared/instrument-profile";
import { midiToFrequency } from "../shared/music";

export const SPECTRUM_MIN_FREQ_HZ = 180;
export const SPECTRUM_MAX_FREQ_HZ = 2800;

const TIME_WINDOW_MS = 6500;
const MIN_COLUMN_MS = 18;
const DB_FLOOR = -92;
const DB_CEILING = -22;
const OPEN_STRING_FREQUENCIES = new Map<InstrumentStringName, number>(
  DEFAULT_INSTRUMENT_STRINGS.map((string) => [string.id, string.openHz]),
);
const AXIS_MIDI_LABELS = [55, 62, 69, 76, 81, 88, 93, 100];

export class LiveSpectrogramRenderer {
  private readonly context: CanvasRenderingContext2D;
  private lastDrawMs: number | null = null;
  private devicePixelRatio = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Spectrogram canvas is unavailable");
    }
    this.context = context;
    this.reset();
  }

  push(frame: SpectrumFrame): void {
    const size = this.ensureCanvasSize();
    if (size.width <= 0 || size.height <= 0) {
      return;
    }

    if (this.lastDrawMs !== null && frame.tMs - this.lastDrawMs < MIN_COLUMN_MS) {
      return;
    }

    const elapsedMs = this.lastDrawMs === null ? MIN_COLUMN_MS : frame.tMs - this.lastDrawMs;
    this.lastDrawMs = frame.tMs;
    const columnWidth = Math.max(1, Math.round((elapsedMs / TIME_WINDOW_MS) * size.width));
    const scrollWidth = Math.max(0, size.width - columnWidth);

    if (scrollWidth > 0) {
      this.context.drawImage(
        this.canvas,
        columnWidth,
        0,
        scrollWidth,
        size.height,
        0,
        0,
        scrollWidth,
        size.height,
      );
    }

    this.context.fillStyle = "#07110f";
    this.context.fillRect(scrollWidth, 0, columnWidth, size.height);
    this.drawSpectrumColumn(frame, scrollWidth, columnWidth, size.height);
  }

  reset(): void {
    this.lastDrawMs = null;
    const size = this.ensureCanvasSize();
    this.context.fillStyle = "#07110f";
    this.context.fillRect(0, 0, size.width, size.height);
  }

  private ensureCanvasSize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    const nextRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor((rect.width || 640) * nextRatio));
    const height = Math.max(1, Math.floor((rect.height || 300) * nextRatio));

    if (
      this.canvas.width !== width ||
      this.canvas.height !== height ||
      this.devicePixelRatio !== nextRatio
    ) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.devicePixelRatio = nextRatio;
      this.context.fillStyle = "#07110f";
      this.context.fillRect(0, 0, width, height);
    }

    return { width, height };
  }

  private drawSpectrumColumn(
    frame: SpectrumFrame,
    leftPixel: number,
    columnWidth: number,
    height: number,
  ): void {
    const binHz = frame.sampleRate / frame.fftSize;
    for (let row = 0; row < height; row += 1) {
      const frequencyHz = topRatioToFrequency(row / Math.max(1, height - 1));
      const binIndex = Math.max(
        0,
        Math.min(frame.magnitudesDb.length - 1, Math.round(frequencyHz / binHz)),
      );
      const dbValue = frame.magnitudesDb[binIndex] ?? DB_FLOOR;
      const normalized = normalizeDb(dbValue);
      this.context.fillStyle = colorForEnergy(normalized);
      this.context.fillRect(leftPixel, row, columnWidth, 1);
    }
  }
}

export function renderSpectrumOverlay(
  frame: PitchFrame | null,
  minBleedScore: number,
): string {
  const labels = AXIS_MIDI_LABELS.map((midi) => {
    const frequencyHz = midiToFrequency(midi);
    const topPct = frequencyToTopPct(frequencyHz);
    return `
      <div class="spectrum-axis-label" style="top:${topPct.toFixed(2)}%;">
        <span>${midiToSolfege(midi)} ${midiToScientific(midi)}</span>
        <small>${Math.round(frequencyHz)} Hz</small>
      </div>
    `;
  }).join("");

  const pitchLine = frame?.freqHz
    ? renderSpectrumLine(frame.freqHz, "spectrum-current-pitch", "Detected")
    : "";
  const primaryGuides = frame?.freqHz
    ? renderHarmonicGuides(frame.freqHz, "spectrum-primary-band", "target harmonic", 4)
    : "";
  const bleedGuides =
    frame?.bleedString && (frame.adjacentBleedRatio ?? 0) >= minBleedScore
      ? renderBleedGuides(frame.bleedString, frame.adjacentBleedRatio ?? 0, minBleedScore)
      : "";

  return `${labels}${primaryGuides}${bleedGuides}${pitchLine}`;
}

export function renderSpectrumSummary(frame: PitchFrame | null, minBleedScore: number): string {
  if (!frame) {
    return "Start listening to draw a rolling spectrogram. Time moves left; frequency is vertical on a log scale.";
  }

  const bleedRatio = frame.adjacentBleedRatio ?? 0;
  const bleedText =
    frame.bleedString && bleedRatio >= minBleedScore
      ? `Bleed overlay: ${instrumentStringLabel(frame.bleedString)} string at ${Math.round(bleedRatio * 100)}%.`
      : "Bleed overlay: clean or below threshold.";
  const pitchText = frame.freqHz
    ? `Detected ${frame.freqHz.toFixed(1)} Hz (${frame.midi !== null ? midiToSolfege(frame.midi) : "-"}).`
    : "Detected pitch: waiting for a stable tone.";

  return `${pitchText}\n${bleedText}\nAxis labels show fixed-do solfege plus Hz; frequency is continuous, solfege markers are discrete.`;
}

function renderSpectrumLine(frequencyHz: number, className: string, label: string): string {
  if (!isFrequencyInRange(frequencyHz)) {
    return "";
  }
  const topPct = frequencyToTopPct(frequencyHz);
  return `<div class="${className}" style="top:${topPct.toFixed(2)}%;"><span>${label}</span></div>`;
}

function renderHarmonicGuides(
  baseFrequencyHz: number,
  className: string,
  label: string,
  maxHarmonic: number,
): string {
  let html = "";
  for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
    const frequencyHz = baseFrequencyHz * harmonic;
    if (!isFrequencyInRange(frequencyHz)) {
      continue;
    }
    const topPct = frequencyToTopPct(frequencyHz);
    const opacity = harmonic === 1 ? 0.78 : Math.max(0.18, 0.5 / harmonic);
    html += `<div class="${className}" style="top:${topPct.toFixed(2)}%; opacity:${opacity.toFixed(2)};" title="${label} ${harmonic}"></div>`;
  }
  return html;
}

function renderBleedGuides(
  stringName: InstrumentStringName,
  bleedRatio: number,
  minBleedScore: number,
): string {
  const baseFrequencyHz = OPEN_STRING_FREQUENCIES.get(stringName);
  if (baseFrequencyHz === undefined) {
    return "";
  }
  const intensity = clamp(
    (bleedRatio - minBleedScore) / (0.49 - minBleedScore),
    0,
    1,
  );
  let html = "";
  for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
    const frequencyHz = baseFrequencyHz * harmonic;
    if (!isFrequencyInRange(frequencyHz)) {
      continue;
    }
    const topPct = frequencyToTopPct(frequencyHz);
    const alpha = 0.2 + intensity * (harmonic === 1 ? 0.62 : 0.34);
    const label = harmonic === 1 ? `${instrumentStringLabel(stringName)} bleed` : "";
    html += `
      <div class="spectrum-bleed-band" style="top:${topPct.toFixed(2)}%; --bleed-alpha:${alpha.toFixed(3)};">
        <span>${label}</span>
      </div>
    `;
  }
  return html;
}

function normalizeDb(dbValue: number): number {
  if (!Number.isFinite(dbValue)) {
    return 0;
  }
  return clamp((dbValue - DB_FLOOR) / (DB_CEILING - DB_FLOOR), 0, 1);
}

function colorForEnergy(energy: number): string {
  if (energy <= 0.01) {
    return "#07110f";
  }
  if (energy < 0.22) {
    const alpha = 0.28 + energy;
    return `rgba(45, 44, 92, ${alpha.toFixed(3)})`;
  }
  if (energy < 0.55) {
    const green = Math.round(90 + energy * 150);
    return `rgb(23, ${green}, 133)`;
  }
  const red = Math.round(120 + energy * 135);
  const green = Math.round(125 + energy * 90);
  return `rgb(${red}, ${green}, 76)`;
}

function frequencyToTopPct(frequencyHz: number): number {
  return frequencyToTopRatio(frequencyHz) * 100;
}

function frequencyToTopRatio(frequencyHz: number): number {
  const logMin = Math.log2(SPECTRUM_MIN_FREQ_HZ);
  const logMax = Math.log2(SPECTRUM_MAX_FREQ_HZ);
  const ratio = (Math.log2(frequencyHz) - logMin) / (logMax - logMin);
  return clamp(1 - ratio, 0, 1);
}

function topRatioToFrequency(topRatio: number): number {
  const logMin = Math.log2(SPECTRUM_MIN_FREQ_HZ);
  const logMax = Math.log2(SPECTRUM_MAX_FREQ_HZ);
  const pitchRatio = 1 - clamp(topRatio, 0, 1);
  return 2 ** (logMin + pitchRatio * (logMax - logMin));
}

function isFrequencyInRange(frequencyHz: number): boolean {
  return frequencyHz >= SPECTRUM_MIN_FREQ_HZ && frequencyHz <= SPECTRUM_MAX_FREQ_HZ;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
