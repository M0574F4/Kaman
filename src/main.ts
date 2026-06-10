import { startMic, stopMic, type MicHandle } from "./audio/mic";
import { startPitchPipeline, type PipelineHandle } from "./audio/pipeline";
import {
  type PitchFrame,
  type SpectrumFrame,
  type TempoFrame,
  type TempoResponsivenessLabel,
} from "./audio/types";
import { LiveNoteTracker, initialLiveSettings } from "./modes/live-mode";
import {
  SequenceCollector,
  initialSequenceSettings,
} from "./modes/sequence-mode";
import {
  LiveSpectrogramRenderer,
  renderSpectrumOverlay,
  renderSpectrumSummary,
} from "./modes/spectrum-mode";
import {
  midiToScientific,
  midiToSolfege,
} from "./notation/solfege";
import {
  ledgerLineYs,
  midiToStaffY,
  midiWithCentsToStaffY,
  renderSequenceSummary,
  stemDirectionForMidi,
  type StemDirection,
} from "./notation/staff-placeholder";
import { createInitialState } from "./state/store";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root");
const appRoot = app;

type SequenceSubMode = "single-beat" | "phrase";
type BeatUnit = "half" | "quarter" | "eighth";
type BeatStatus = "On Time" | "Short" | "Long";
type BeatValue = "whole" | "half" | "quarter" | "eighth";
type PracticePatternLoopMode = "restart" | "back-and-forth";
type SheetEntryAccidental = "natural" | "sharp" | "flat";
type SheetEntryTool = SheetEntryAccidental | "rest";
type SheetEntrySlotValue = "quarter" | "eighth" | "sixteenth";

type BeatSymbol = {
  kind: "note" | "rest";
  midi: number | null;
  value: BeatValue;
  durationMs: number;
  spanBeats: number;
};

type IntervalBucket = {
  noteCounts: Map<number, number>;
  silenceCount: number;
  frameCount: number;
  edgeStartNoteCounts: Map<number, number>;
  edgeStartSilenceCount: number;
  edgeStartFrameCount: number;
  edgeEndNoteCounts: Map<number, number>;
  edgeEndSilenceCount: number;
  edgeEndFrameCount: number;
};

type BoundaryEvidence = {
  transitions: number;
  sameMidiTransitions: number;
  pitchChangeTransitions: number;
  silenceTransitions: number;
  silenceToNoteTransitions: number;
};

type BeatDrillAttempt = {
  id: number;
  symbols: BeatSymbol[];
  performedMs: number;
  targetMs: number;
  errorMs: number;
  status: BeatStatus;
};

type BeatBatch = {
  id: number;
  beats: BeatSymbol[][];
  performedMs: number;
  targetMs: number;
  errorMs: number;
  status: BeatStatus;
};

type PracticePatternNote = {
  midi: number;
  label: "Re" | "La";
};

type PracticePattern = {
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

type PracticePatternResult = {
  status: "pending" | "correct" | "wrong";
  playedMidi: number | null;
  bleedMidi: number | null;
};

type PracticePatternPassDirection = "forward" | "backward";

type PracticePatternPassSummary = {
  direction: PracticePatternPassDirection;
  correct: number;
  wrong: number;
  total: number;
  tempoStatus: TempoFrame["status"];
  tempoLabel: string;
  bleedDetected: boolean;
  bleedFrameRatio: number;
  bleedString: string | null;
};

type PracticePatternPassAccumulator = {
  tempoCounts: Record<"play-faster" | "play-slower" | "on-tempo", number>;
  tempoSamples: number;
  frameCount: number;
  bleedFrameCount: number;
  bleedStringCounts: Map<string, number>;
};

type PracticePatternPosition = {
  noteIndex: number;
  stepIndex: number;
  passStartStepIndex: number;
  cycleIndex: number;
  cycleKey: number;
  stepElapsedMs: number;
  order: number[];
};

type SheetEntrySlot = {
  naturalMidi: number;
  accidental: SheetEntryAccidental;
  midi: number;
};

const PRACTICE_PATTERNS: PracticePattern[] = [
  {
    id: "warmup1",
    name: "Warmup 1",
    defaultLoop: true,
    defaultLoopMode: "back-and-forth",
    defaultCountInBeats: 4,
    tempoRamp: {
      initialBpm: 80,
      stepBpm: 5,
      maxBpm: 120,
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
      initialBpm: 80,
      stepBpm: 5,
      maxBpm: 120,
    },
    notes: [
      ...makeWarmupGroup(74, "Re", 2),
      ...makeWarmupGroup(69, "La", 2),
      ...makeWarmupGroup(62, "Re", 2),
      ...makeWarmupGroup(57, "La", 2),
    ],
  },
];

const state = createInitialState();
const sequenceSettings = initialSequenceSettings();
const liveSettings = initialLiveSettings();
const liveTracker = new LiveNoteTracker(liveSettings, 30_000);
const collector = new SequenceCollector(sequenceSettings);
state.practice.targetBpm = sequenceSettings.bpm;

const TRAIL_DURATION_MS = 1400;
const TRAIL_START_LEFT_PCT = 58;
const TRAIL_END_LEFT_PCT = 2;
const BATCH_FADE_MS = 1700;
const PRACTICE_PATTERN_NOTES_PER_ROW = 16;

let micHandle: MicHandle | null = null;
let pipeline: PipelineHandle | null = null;
let lastFrame: PitchFrame | null = null;
let lastTempoFrame: TempoFrame | null = null;
let spectrogram: LiveSpectrogramRenderer | null = null;
let renderPending = false;
let showExactIntonation = false;
let enableFadeTrail = true;
let enableVisualMetronome = true;
let enableMetronomeSound = false;
let enableStringPurityCheck = false;
let minBleedScore = 0.14;
const PRACTICE_BLEED_MIN = 0.01;
const PRACTICE_BLEED_MAX = 0.95;
const PRACTICE_BLEED_DEFAULT = 0.3;
let practiceBleedSensitivity = PRACTICE_BLEED_DEFAULT;
let practicePeakThreshold = 50;
let practicePeakMergeMs = defaultPracticePeakMergeMs(sequenceSettings.bpm);
let practicePeakMergeTouched = false;
let practiceTolerancePct = 8;
let showPracticeDebug = false;
let practiceCorrectionSource: TempoResponsivenessLabel = "Balanced";
let selectedPracticePatternId = PRACTICE_PATTERNS[0].id;
let practicePatternLoopEnabled = PRACTICE_PATTERNS[0].defaultLoop;
let practicePatternLoopMode = PRACTICE_PATTERNS[0].defaultLoopMode;
let practicePatternCountInBeats = PRACTICE_PATTERNS[0].defaultCountInBeats;
let practicePatternPlaying = false;
let practicePatternStartedAtMs = 0;
let practicePatternActiveIndex: number | null = null;
let practicePatternCycleIndex = 0;
let practicePatternLastScrolledRow = -1;
let practicePatternStopTimer: number | null = null;
let practicePatternResults: PracticePatternResult[] = createPracticePatternResults();
let practicePatternPassSummary: PracticePatternPassSummary | null = null;
let practicePatternPassAccumulator = createPracticePatternPassAccumulator();
let sequenceSubMode: SequenceSubMode = "single-beat";
let beatUnit: BeatUnit = defaultBeatUnitForTimeSignature(sequenceSettings.timeSignature);
let sheetEntryTool: SheetEntryTool = "natural";
let sheetEntryTimeSignature: typeof sequenceSettings.timeSignature = "4/4";
let sheetEntrySlotValue: SheetEntrySlotValue = "eighth";
let sheetEntryBars = 1;
let sheetEntrySlotCount = defaultSheetSlotCount(sheetEntryTimeSignature, sheetEntrySlotValue, sheetEntryBars);
let sheetEntrySlots: Array<SheetEntrySlot | null> = createEmptySheetSlots(sheetEntrySlotCount);
let beatToleranceMs = 80;
let beatAttemptId = 1;
const beatAttempts: BeatDrillAttempt[] = [];
let singleBeatWindow: { startMs: number; endMs: number } | null = null;
let singleBeatStopTimer: number | null = null;
let singleBeatRoundIndex = 0;
let singleBeatIntervalCount = 0;
let singleBeatIntervalMs = 0;
let singleBeatBuckets: IntervalBucket[] = [];
let singleBeatBoundaryEvidence: BoundaryEvidence[] = [];
let singleBeatPrevFrame: { intervalIndex: number; midi: number | null } | null = null;
let currentBeatBatch: BeatBatch | null = null;
const fadingBeatBatches: Array<{ batch: BeatBatch; startedAtMs: number }> = [];
let singleBeatDebug = "single-beat debug idle";
let metronomeStartMs = performance.now();
let metronomeRafId: number | null = null;
let metronomeLastTickIndex: number | null = null;
let metronomeAudioContext: AudioContext | null = null;
const isLikelyIOS = detectLikelyIOS();

type NoteSnapshot = {
  midi: number;
  y: number;
  stemDirection: StemDirection;
  ledgerYs: number[];
};

type TrailNote = NoteSnapshot & {
  startedAtMs: number;
};

let previousDisplayedSnapshot: NoteSnapshot | null = null;
const trailNotes: TrailNote[] = [];

type UiRefs = {
  listenBtn: HTMLButtonElement;
  modeSelect: HTMLSelectElement;
  recordBtn: HTMLButtonElement;
  outputTitle: HTMLHeadingElement;
  liveMetronomeControls: HTMLDivElement;
  practicePanel: HTMLDivElement;
  practiceStatus: HTMLDivElement;
  practiceOverallFeedback: HTMLDivElement;
  practiceEstimate: HTMLParagraphElement;
  practiceDetail: HTMLParagraphElement;
  practicePatternSelect: HTMLSelectElement;
  practicePatternLoopToggle: HTMLInputElement;
  practicePatternLoopModeSelect: HTMLSelectElement;
  practicePatternName: HTMLElement;
  practicePatternPlayBtn: HTMLButtonElement;
  practicePatternReadout: HTMLSpanElement;
  practiceToleranceInput: HTMLInputElement;
  practiceSensitivityInput: HTMLInputElement;
  practiceBleedSensitivityInput: HTMLInputElement;
  practiceCorrectionSourceSelect: HTMLSelectElement;
  practiceDebugToggle: HTMLInputElement;
  practiceDebugSection: HTMLDivElement;
  practicePeakThresholdInput: HTMLInputElement;
  practicePeakThresholdValue: HTMLSpanElement;
  practicePeakMergeInput: HTMLInputElement;
  practiceDebug: HTMLDivElement;
  sequenceControls: HTMLDivElement;
  sequenceSubmodeSelect: HTMLSelectElement;
  noteEntryControls: HTMLDivElement;
  noteEntryTimeSignatureSelect: HTMLSelectElement;
  noteEntrySlotValueSelect: HTMLSelectElement;
  noteEntryBarsInput: HTMLInputElement;
  noteEntryToolSelect: HTMLSelectElement;
  noteEntryClearBtn: HTMLButtonElement;
  liveBpmInput: HTMLInputElement;
  liveBpmUpBtn: HTMLButtonElement;
  liveBpmDownBtn: HTMLButtonElement;
  bpmInput: HTMLInputElement;
  timeSignatureSelect: HTMLSelectElement;
  beatUnitSelect: HTMLSelectElement;
  toleranceInput: HTMLInputElement;
  visualMetronomeToggle: HTMLInputElement;
  soundMetronomeToggle: HTMLButtonElement;
  bleedThresholdInput: HTMLInputElement;
  stringPurityToggle: HTMLInputElement;
  exactToggle: HTMLInputElement;
  trailToggle: HTMLInputElement;
  captureHint: HTMLElement;
  noteMetric: HTMLParagraphElement;
  bleedNoteLine: HTMLParagraphElement;
  liveMetaLine: HTMLParagraphElement;
  purityMetaLine: HTMLParagraphElement;
  sequenceSummary: HTMLPreElement;
  sequenceMeta: HTMLParagraphElement;
  beatBatchBox: HTMLDivElement;
  metronomeBox: HTMLDivElement;
  staff: HTMLDivElement;
  spectrumPanel: HTMLDivElement;
  spectrogramCanvas: HTMLCanvasElement;
  spectrogramOverlay: HTMLDivElement;
  staffBatchLayer: HTMLDivElement;
  noteGroup: HTMLDivElement;
  ledgerLayer: HTMLDivElement;
  trailLayer: HTMLDivElement;
};

let ui: UiRefs | null = null;

function mountUi(): void {
  appRoot.innerHTML = `
    <main class="panel">
      <h1>Practice</h1>
      <div class="controls">
        <button id="listen-btn" class="primary">Start Listening</button>
        <select id="mode-select" aria-label="Mode">
          <option value="live">Live</option>
          <option value="practice">Practice</option>
          <option value="sequence">Sequence</option>
          <option value="sheet-entry">Sheet Entry</option>
          <option value="spectrum">Spectrum</option>
        </select>
        <span id="capture-hint" class="muted mode-hint"></span>
        <button id="record-btn" disabled>Start Capture</button>
      </div>

      <div class="grid">
        <section class="card visual-card">
          <div class="note-readout">
            <p id="note-metric" class="metric">- <span class="muted">(-)</span></p>
            <p id="bleed-note-line" class="bleed-note-line">&nbsp;</p>
          </div>
          <div id="staff" class="staff" aria-label="5-line staff">
            <div class="staff-line l1"></div>
            <div class="staff-line l2"></div>
            <div class="staff-line l3"></div>
            <div class="staff-line l4"></div>
            <div class="staff-line l5"></div>
            <div id="staff-batch-layer" class="staff-batch-layer"></div>
            <div id="trail-layer" class="trail-layer"></div>
            <div id="ledger-layer" class="ledger-layer"></div>
            <div id="staff-note-group" class="staff-note-group" title="Detected note">
              <div class="staff-note-head"></div>
              <div class="staff-note-stem"></div>
            </div>
          </div>
          <div id="spectrum-panel" class="spectrum-panel" aria-label="Live spectrogram">
            <canvas id="spectrogram-canvas" class="spectrogram-canvas"></canvas>
            <div id="spectrogram-overlay" class="spectrogram-overlay"></div>
          </div>
          <div class="practice-sheet-statusbar">
            <div class="practice-feedback-grid">
              <div class="practice-feedback-card instant">
                <span>Now</span>
                <div id="practice-status" class="practice-status status-idle">-</div>
              </div>
              <div class="practice-feedback-card overall">
                <span>Pass</span>
                <div id="practice-overall-feedback" class="practice-overall-feedback">After first pass</div>
              </div>
            </div>
            <button id="sound-metronome-toggle" type="button" class="metronome-sound-toggle" aria-label="Metronome sound off" aria-pressed="false">
              <span class="speaker-glyph" aria-hidden="true">🔈</span>
            </button>
            <div id="metronome-box" class="metronome-box"></div>
          </div>
        </section>

        <section class="card output-card">
          <h2 id="output-title">Sequence Output</h2>
          <div id="live-metronome-controls" class="sequence-controls live-metro-controls">
            <label>Target BPM
              <span class="live-bpm-stepper">
                <input id="live-bpm-input" class="live-bpm-input" type="number" min="30" max="240" step="1" value="80" />
                <span class="live-bpm-arrows">
                  <button id="live-bpm-up" type="button" class="live-bpm-arrow" aria-label="Increase live BPM">▲</button>
                  <button id="live-bpm-down" type="button" class="live-bpm-arrow" aria-label="Decrease live BPM">▼</button>
                </span>
              </span>
            </label>
            <p id="practice-estimate" class="practice-estimate">80 target · -</p>
            <div class="practice-minimal-controls">
              <label>Tol
                <input id="practice-tolerance" type="number" min="1" max="30" step="1" value="8" />
              </label>
              <label>Sens
                <input id="practice-sensitivity" type="number" min="0.1" max="0.95" step="0.01" value="0.55" />
              </label>
              <label>Bleed
                <input id="practice-bleed-sensitivity" type="number" min="0.01" max="0.95" step="0.01" value="0.30" />
              </label>
              <label>Correction
                <select id="practice-correction-source">
                  <option value="Fast">Fast</option>
                  <option value="Balanced" selected>Balanced</option>
                  <option value="Stable">Stable</option>
                </select>
              </label>
              <label class="practice-debug-toggle" for="practice-debug-toggle">
                <input id="practice-debug-toggle" type="checkbox" />
                Diagnostics
              </label>
            </div>
          </div>
          <div id="practice-panel" class="practice-panel">
            <div class="practice-pattern-controls">
              <select id="practice-pattern-select" class="practice-pattern-select" aria-label="Practice pattern">
                ${PRACTICE_PATTERNS.map(
                  (pattern) => `<option value="${pattern.id}">${pattern.name}</option>`,
                ).join("")}
              </select>
              <label class="practice-pattern-loop" for="practice-pattern-loop">
                <input id="practice-pattern-loop" type="checkbox" checked />
                Loop
              </label>
              <label class="practice-pattern-loop-mode">Path
                <select id="practice-pattern-loop-mode" aria-label="Practice loop path">
                  <option value="restart" selected>Restart</option>
                  <option value="back-and-forth">Back + forth</option>
                </select>
              </label>
              <button id="practice-pattern-play" type="button" class="practice-pattern-play" aria-label="Start Warmup 1">▶</button>
              <div class="practice-pattern-copy">
                <strong id="practice-pattern-name">Warmup 1</strong>
                <span id="practice-pattern-readout">Ready</span>
              </div>
            </div>
            <p id="practice-detail" class="practice-detail">Confidence 0% | rhythmic signal 0%</p>
            <div id="practice-debug-section" class="practice-debug-section">
              <div class="practice-tuning">
                <label>Peak threshold <span id="practice-peak-threshold-value">50</span>
                  <input id="practice-peak-threshold" type="range" min="1" max="100" step="1" value="50" />
                </label>
                <label>Merge ms
                  <input id="practice-peak-merge" type="number" min="80" max="800" step="10" value="320" />
                </label>
              </div>
              <div id="practice-debug" class="practice-debug"></div>
            </div>
          </div>
          <div id="sequence-controls" class="sequence-controls">
            <label>Submode
              <select id="sequence-submode-select">
                <option value="single-beat">Single Beat Drill</option>
                <option value="phrase">Phrase Capture</option>
              </select>
            </label>
            <label>BPM
              <input id="bpm-input" type="number" min="30" max="240" step="1" value="80" />
            </label>
            <label>Time
              <select id="time-signature-select">
                <option value="2/2">2/2</option>
                <option value="2/4">2/4</option>
                <option value="3/4">3/4</option>
                <option value="4/4" selected>4/4</option>
                <option value="6/8">6/8</option>
              </select>
            </label>
            <label>Beat
              <select id="beat-unit-select">
                <option value="half">Half</option>
                <option value="quarter" selected>Quarter</option>
                <option value="eighth">Eighth</option>
              </select>
            </label>
            <label>Tolerance ms
              <input id="tolerance-input" type="number" min="20" max="300" step="5" value="80" />
            </label>
          </div>
          <div id="note-entry-controls" class="note-entry-controls">
            <label>Time
              <select id="note-entry-time-signature">
                <option value="2/2">2/2</option>
                <option value="2/4">2/4</option>
                <option value="3/4">3/4</option>
                <option value="4/4" selected>4/4</option>
                <option value="6/8">6/8</option>
              </select>
            </label>
            <label>Slot
              <select id="note-entry-slot-value">
                <option value="quarter">Quarter</option>
                <option value="eighth" selected>Eighth</option>
                <option value="sixteenth">Sixteenth</option>
              </select>
            </label>
            <label>Bars
              <input id="note-entry-bars" type="number" min="1" max="4" step="1" value="1" />
            </label>
            <label>Click tool
              <select id="note-entry-tool">
                <option value="natural" selected>Natural</option>
                <option value="sharp">Sharp</option>
                <option value="flat">Flat</option>
                <option value="rest">Rest</option>
              </select>
            </label>
            <button id="note-entry-clear" type="button">Clear</button>
          </div>
          <label class="toggle-row practice-hidden-control" for="exact-pitch-toggle">
            <input id="exact-pitch-toggle" type="checkbox" />
            Exact intonation
          </label>
          <label class="toggle-row practice-hidden-control" for="trail-toggle">
            <input id="trail-toggle" type="checkbox" checked />
            Fade trail
          </label>
          <label class="toggle-row practice-hidden-control" for="string-purity-toggle">
            <input id="string-purity-toggle" type="checkbox" />
            String bleed
            <span class="bleed-threshold-group">
              score
              <input id="bleed-threshold-input" type="number" min="0.05" max="0.49" step="0.01" value="0.14" />
            </span>
          </label>
          <label class="toggle-row compact practice-hidden-control" for="visual-metronome-toggle">
            <input id="visual-metronome-toggle" type="checkbox" />
            Visual metronome
          </label>
          <div id="beat-batch-box" class="beat-batch-box"></div>
          <p id="live-meta-line" class="meta-line">- | 0% | cents: - | Not listening</p>
          <p id="purity-meta-line" class="meta-line muted purity-line"></p>
          <p id="sequence-meta" class="muted"></p>
          <pre id="sequence-summary">No notes captured yet.</pre>
        </section>
      </div>
    </main>
  `;

  const listenBtn = appRoot.querySelector<HTMLButtonElement>("#listen-btn");
  const modeSelect = appRoot.querySelector<HTMLSelectElement>("#mode-select");
  const recordBtn = appRoot.querySelector<HTMLButtonElement>("#record-btn");
  const outputTitle = appRoot.querySelector<HTMLHeadingElement>("#output-title");
  const liveMetronomeControls = appRoot.querySelector<HTMLDivElement>("#live-metronome-controls");
  const practicePanel = appRoot.querySelector<HTMLDivElement>("#practice-panel");
  const practiceStatus = appRoot.querySelector<HTMLDivElement>("#practice-status");
  const practiceOverallFeedback = appRoot.querySelector<HTMLDivElement>("#practice-overall-feedback");
  const practiceEstimate = appRoot.querySelector<HTMLParagraphElement>("#practice-estimate");
  const practiceDetail = appRoot.querySelector<HTMLParagraphElement>("#practice-detail");
  const practicePatternSelect = appRoot.querySelector<HTMLSelectElement>("#practice-pattern-select");
  const practicePatternLoopToggle = appRoot.querySelector<HTMLInputElement>("#practice-pattern-loop");
  const practicePatternLoopModeSelect = appRoot.querySelector<HTMLSelectElement>("#practice-pattern-loop-mode");
  const practicePatternName = appRoot.querySelector<HTMLElement>("#practice-pattern-name");
  const practicePatternPlayBtn = appRoot.querySelector<HTMLButtonElement>("#practice-pattern-play");
  const practicePatternReadout = appRoot.querySelector<HTMLSpanElement>("#practice-pattern-readout");
  const practiceToleranceInput = appRoot.querySelector<HTMLInputElement>("#practice-tolerance");
  const practiceSensitivityInput = appRoot.querySelector<HTMLInputElement>("#practice-sensitivity");
  const practiceBleedSensitivityInput = appRoot.querySelector<HTMLInputElement>("#practice-bleed-sensitivity");
  const practiceCorrectionSourceSelect = appRoot.querySelector<HTMLSelectElement>("#practice-correction-source");
  const practiceDebugToggle = appRoot.querySelector<HTMLInputElement>("#practice-debug-toggle");
  const practiceDebugSection = appRoot.querySelector<HTMLDivElement>("#practice-debug-section");
  const practicePeakThresholdInput = appRoot.querySelector<HTMLInputElement>("#practice-peak-threshold");
  const practicePeakThresholdValue = appRoot.querySelector<HTMLSpanElement>("#practice-peak-threshold-value");
  const practicePeakMergeInput = appRoot.querySelector<HTMLInputElement>("#practice-peak-merge");
  const practiceDebug = appRoot.querySelector<HTMLDivElement>("#practice-debug");
  const sequenceControls = appRoot.querySelector<HTMLDivElement>("#sequence-controls");
  const sequenceSubmodeSelect = appRoot.querySelector<HTMLSelectElement>("#sequence-submode-select");
  const noteEntryControls = appRoot.querySelector<HTMLDivElement>("#note-entry-controls");
  const noteEntryTimeSignatureSelect = appRoot.querySelector<HTMLSelectElement>("#note-entry-time-signature");
  const noteEntrySlotValueSelect = appRoot.querySelector<HTMLSelectElement>("#note-entry-slot-value");
  const noteEntryBarsInput = appRoot.querySelector<HTMLInputElement>("#note-entry-bars");
  const noteEntryToolSelect = appRoot.querySelector<HTMLSelectElement>("#note-entry-tool");
  const noteEntryClearBtn = appRoot.querySelector<HTMLButtonElement>("#note-entry-clear");
  const liveBpmInput = appRoot.querySelector<HTMLInputElement>("#live-bpm-input");
  const liveBpmUpBtn = appRoot.querySelector<HTMLButtonElement>("#live-bpm-up");
  const liveBpmDownBtn = appRoot.querySelector<HTMLButtonElement>("#live-bpm-down");
  const bpmInput = appRoot.querySelector<HTMLInputElement>("#bpm-input");
  const timeSignatureSelect = appRoot.querySelector<HTMLSelectElement>("#time-signature-select");
  const beatUnitSelect = appRoot.querySelector<HTMLSelectElement>("#beat-unit-select");
  const toleranceInput = appRoot.querySelector<HTMLInputElement>("#tolerance-input");
  const visualMetronomeToggle = appRoot.querySelector<HTMLInputElement>("#visual-metronome-toggle");
  const soundMetronomeToggle = appRoot.querySelector<HTMLButtonElement>("#sound-metronome-toggle");
  const bleedThresholdInput = appRoot.querySelector<HTMLInputElement>("#bleed-threshold-input");
  const stringPurityToggle = appRoot.querySelector<HTMLInputElement>("#string-purity-toggle");
  const exactToggle = appRoot.querySelector<HTMLInputElement>("#exact-pitch-toggle");
  const trailToggle = appRoot.querySelector<HTMLInputElement>("#trail-toggle");
  const captureHint = appRoot.querySelector<HTMLElement>("#capture-hint");
  const noteMetric = appRoot.querySelector<HTMLParagraphElement>("#note-metric");
  const bleedNoteLine = appRoot.querySelector<HTMLParagraphElement>("#bleed-note-line");
  const liveMetaLine = appRoot.querySelector<HTMLParagraphElement>("#live-meta-line");
  const purityMetaLine = appRoot.querySelector<HTMLParagraphElement>("#purity-meta-line");
  const sequenceSummary = appRoot.querySelector<HTMLPreElement>("#sequence-summary");
  const sequenceMeta = appRoot.querySelector<HTMLParagraphElement>("#sequence-meta");
  const beatBatchBox = appRoot.querySelector<HTMLDivElement>("#beat-batch-box");
  const metronomeBox = appRoot.querySelector<HTMLDivElement>("#metronome-box");
  const staff = appRoot.querySelector<HTMLDivElement>("#staff");
  const spectrumPanel = appRoot.querySelector<HTMLDivElement>("#spectrum-panel");
  const spectrogramCanvas = appRoot.querySelector<HTMLCanvasElement>("#spectrogram-canvas");
  const spectrogramOverlay = appRoot.querySelector<HTMLDivElement>("#spectrogram-overlay");
  const staffBatchLayer = appRoot.querySelector<HTMLDivElement>("#staff-batch-layer");
  const noteGroup = appRoot.querySelector<HTMLDivElement>("#staff-note-group");
  const ledgerLayer = appRoot.querySelector<HTMLDivElement>("#ledger-layer");
  const trailLayer = appRoot.querySelector<HTMLDivElement>("#trail-layer");

  if (
    !listenBtn ||
    !modeSelect ||
    !recordBtn ||
    !outputTitle ||
    !liveMetronomeControls ||
    !practicePanel ||
    !practiceStatus ||
    !practiceOverallFeedback ||
    !practiceEstimate ||
    !practiceDetail ||
    !practicePatternSelect ||
    !practicePatternLoopToggle ||
    !practicePatternLoopModeSelect ||
    !practicePatternName ||
    !practicePatternPlayBtn ||
    !practicePatternReadout ||
    !practiceToleranceInput ||
    !practiceSensitivityInput ||
    !practiceBleedSensitivityInput ||
    !practiceCorrectionSourceSelect ||
    !practiceDebugToggle ||
    !practiceDebugSection ||
    !practicePeakThresholdInput ||
    !practicePeakThresholdValue ||
    !practicePeakMergeInput ||
    !practiceDebug ||
    !sequenceControls ||
    !sequenceSubmodeSelect ||
    !noteEntryControls ||
    !noteEntryTimeSignatureSelect ||
    !noteEntrySlotValueSelect ||
    !noteEntryBarsInput ||
    !noteEntryToolSelect ||
    !noteEntryClearBtn ||
    !liveBpmInput ||
    !liveBpmUpBtn ||
    !liveBpmDownBtn ||
    !bpmInput ||
    !timeSignatureSelect ||
    !beatUnitSelect ||
    !toleranceInput ||
    !visualMetronomeToggle ||
    !soundMetronomeToggle ||
    !bleedThresholdInput ||
    !stringPurityToggle ||
    !exactToggle ||
    !trailToggle ||
    !captureHint ||
    !noteMetric ||
    !bleedNoteLine ||
    !liveMetaLine ||
    !purityMetaLine ||
    !sequenceSummary ||
    !sequenceMeta ||
    !beatBatchBox ||
    !metronomeBox ||
    !staff ||
    !spectrumPanel ||
    !spectrogramCanvas ||
    !spectrogramOverlay ||
    !staffBatchLayer ||
    !noteGroup ||
    !ledgerLayer ||
    !trailLayer
  ) {
    throw new Error("Failed to mount UI elements");
  }

  ui = {
    listenBtn,
    modeSelect,
    recordBtn,
    outputTitle,
    liveMetronomeControls,
    practicePanel,
    practiceStatus,
    practiceOverallFeedback,
    practiceEstimate,
    practiceDetail,
    practicePatternSelect,
    practicePatternLoopToggle,
    practicePatternLoopModeSelect,
    practicePatternName,
    practicePatternPlayBtn,
    practicePatternReadout,
    practiceToleranceInput,
    practiceSensitivityInput,
    practiceBleedSensitivityInput,
    practiceCorrectionSourceSelect,
    practiceDebugToggle,
    practiceDebugSection,
    practicePeakThresholdInput,
    practicePeakThresholdValue,
    practicePeakMergeInput,
    practiceDebug,
    sequenceControls,
    sequenceSubmodeSelect,
    noteEntryControls,
    noteEntryTimeSignatureSelect,
    noteEntrySlotValueSelect,
    noteEntryBarsInput,
    noteEntryToolSelect,
    noteEntryClearBtn,
    liveBpmInput,
    liveBpmUpBtn,
    liveBpmDownBtn,
    bpmInput,
    timeSignatureSelect,
    beatUnitSelect,
    toleranceInput,
    visualMetronomeToggle,
    soundMetronomeToggle,
    bleedThresholdInput,
    stringPurityToggle,
    exactToggle,
    trailToggle,
    captureHint,
    noteMetric,
    bleedNoteLine,
    liveMetaLine,
    purityMetaLine,
    sequenceSummary,
    sequenceMeta,
    beatBatchBox,
    metronomeBox,
    staff,
    spectrumPanel,
    spectrogramCanvas,
    spectrogramOverlay,
    staffBatchLayer,
    noteGroup,
    ledgerLayer,
    trailLayer,
  };
  spectrogram = new LiveSpectrogramRenderer(spectrogramCanvas);

  listenBtn.addEventListener("click", () => {
    void onToggleListening();
  });

  modeSelect.addEventListener("change", onModeChange);

  recordBtn.addEventListener("click", () => {
    void onToggleRecording();
  });

  practicePatternPlayBtn.addEventListener("click", () => {
    void onTogglePracticePatternPlayback();
  });

  practicePatternSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const pattern = practicePatternById(target.value);
    selectedPracticePatternId = pattern.id;
    practicePatternLoopEnabled = pattern.defaultLoop;
    practicePatternLoopMode = pattern.defaultLoopMode;
    practicePatternCountInBeats = pattern.defaultCountInBeats;
    practicePatternPassSummary = null;
    practicePatternPassAccumulator = createPracticePatternPassAccumulator();
    practicePatternLastScrolledRow = -1;
    stopPracticePatternPlayback(true);
    scheduleRender();
  });

  practicePatternLoopToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    practicePatternLoopEnabled = target.checked;
    syncPracticePatternStopTimer();
    scheduleRender();
  });

  practicePatternLoopModeSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    practicePatternLoopMode = asPracticePatternLoopMode(target.value);
    practicePatternResults = createPracticePatternResults();
    practicePatternCycleIndex = practicePatternCycleIndexForNow();
    scheduleRender();
  });

  sequenceSubmodeSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    sequenceSubMode = target.value === "phrase" ? "phrase" : "single-beat";
    state.recording = false;
    singleBeatWindow = null;
    if (singleBeatStopTimer !== null) {
      window.clearTimeout(singleBeatStopTimer);
      singleBeatStopTimer = null;
    }
    collector.reset();
    singleBeatRoundIndex = 0;
    singleBeatIntervalCount = 0;
    singleBeatIntervalMs = 0;
    singleBeatBuckets = [];
    singleBeatBoundaryEvidence = [];
    singleBeatPrevFrame = null;
    currentBeatBatch = null;
    fadingBeatBatches.length = 0;
    scheduleRender();
  });

  noteEntryTimeSignatureSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    sheetEntryTimeSignature = asTimeSignature(target.value);
    syncSheetEntryTiming();
    scheduleRender();
  });

  noteEntrySlotValueSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    sheetEntrySlotValue = asSheetEntrySlotValue(target.value);
    syncSheetEntryTiming();
    scheduleRender();
  });

  noteEntryBarsInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    sheetEntryBars = clamp(parseInt(target.value || "1", 10), 1, 4);
    target.value = String(sheetEntryBars);
    syncSheetEntryTiming();
    scheduleRender();
  });

  noteEntryToolSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    sheetEntryTool = asSheetEntryTool(target.value);
    scheduleRender();
  });

  noteEntryClearBtn.addEventListener("click", () => {
    sheetEntrySlots = createEmptySheetSlots(sheetEntrySlotCount);
    scheduleRender();
  });

  staff.addEventListener("click", (event) => {
    handleStaffSheetEntryClick(event);
  });

  const applyBpmInput = (target: HTMLInputElement): void => {
    const raw = parseInt(target.value || "80", 10);
    if (!Number.isFinite(raw)) {
      return;
    }
    const nextBpm = clamp(raw, 30, 240);
    if (nextBpm === sequenceSettings.bpm) {
      return;
    }
    stopPracticePatternPlayback(false);
    sequenceSettings.bpm = nextBpm;
    resetPracticeEstimate(nextBpm);
    if (!practicePeakMergeTouched) {
      practicePeakMergeMs = defaultPracticePeakMergeMs(nextBpm);
    }
    pipeline?.setPracticeTargetBpm(nextBpm);
    syncPracticePeakPickingPipeline();
    pipeline?.resetTempo();
    collector.setSettings(sequenceSettings);
    resetMetronomeClock();
    scheduleRender();
  };

  bpmInput.addEventListener("input", (event) => {
    applyBpmInput(event.target as HTMLInputElement);
  });
  bpmInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    applyBpmInput(target);
    target.value = String(sequenceSettings.bpm);
  });

  liveBpmInput.addEventListener("input", (event) => {
    applyBpmInput(event.target as HTMLInputElement);
  });
  liveBpmInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    applyBpmInput(target);
    target.value = String(sequenceSettings.bpm);
  });

  const stepLiveBpm = (delta: number): void => {
    const nextBpm = clamp(sequenceSettings.bpm + delta, 30, 240);
    if (nextBpm === sequenceSettings.bpm) {
      return;
    }
    stopPracticePatternPlayback(false);
    sequenceSettings.bpm = nextBpm;
    resetPracticeEstimate(nextBpm);
    if (!practicePeakMergeTouched) {
      practicePeakMergeMs = defaultPracticePeakMergeMs(nextBpm);
    }
    pipeline?.setPracticeTargetBpm(nextBpm);
    syncPracticePeakPickingPipeline();
    pipeline?.resetTempo();
    collector.setSettings(sequenceSettings);
    resetMetronomeClock();
    scheduleRender();
  };

  liveBpmUpBtn.addEventListener("click", () => {
    stepLiveBpm(1);
  });

  liveBpmDownBtn.addEventListener("click", () => {
    stepLiveBpm(-1);
  });

  practiceToleranceInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    practiceTolerancePct = clamp(parseInt(target.value || "8", 10), 1, 30);
    syncPracticeTolerancePipeline();
    scheduleRender();
  });

  practiceToleranceInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    practiceTolerancePct = clamp(parseInt(target.value || "8", 10), 1, 30);
    target.value = String(practiceTolerancePct);
    syncPracticeTolerancePipeline();
    scheduleRender();
  });

  practiceSensitivityInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    liveSettings.confidenceThreshold = clamp(parsed, 0.1, 0.95);
    syncPracticeSensitivityPipeline();
    scheduleRender();
  });

  practiceSensitivityInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    liveSettings.confidenceThreshold = Number.isFinite(parsed)
      ? clamp(parsed, 0.1, 0.95)
      : initialLiveSettings().confidenceThreshold;
    target.value = liveSettings.confidenceThreshold.toFixed(2);
    syncPracticeSensitivityPipeline();
    liveTracker.reset();
    scheduleRender();
  });

  practiceBleedSensitivityInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    practiceBleedSensitivity = clamp(parsed, PRACTICE_BLEED_MIN, PRACTICE_BLEED_MAX);
  });

  practiceBleedSensitivityInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    practiceBleedSensitivity = Number.isFinite(parsed)
      ? clamp(parsed, PRACTICE_BLEED_MIN, PRACTICE_BLEED_MAX)
      : PRACTICE_BLEED_DEFAULT;
    target.value = practiceBleedSensitivity.toFixed(2);
    scheduleRender();
  });

  practiceCorrectionSourceSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    practiceCorrectionSource = asPracticeCorrectionSource(target.value);
    syncPracticeCorrectionSourcePipeline();
    scheduleRender();
  });

  practiceDebugToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    showPracticeDebug = target.checked;
    scheduleRender();
  });

  practicePeakThresholdInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    practicePeakThreshold = clamp(parseInt(target.value || "50", 10), 1, 100);
    syncPracticePeakPickingPipeline();
    pipeline?.resetTempo();
    scheduleRender();
  });

  practicePeakMergeInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    practicePeakMergeMs = clamp(parseInt(target.value || "320", 10), 80, 800);
    practicePeakMergeTouched = true;
    syncPracticePeakPickingPipeline();
    pipeline?.resetTempo();
    scheduleRender();
  });

  practicePeakMergeInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    practicePeakMergeMs = clamp(parseInt(target.value || "320", 10), 80, 800);
    practicePeakMergeTouched = true;
    target.value = String(practicePeakMergeMs);
    syncPracticePeakPickingPipeline();
    pipeline?.resetTempo();
    scheduleRender();
  });

  timeSignatureSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    sequenceSettings.timeSignature = asTimeSignature(target.value);
    beatUnit = defaultBeatUnitForTimeSignature(sequenceSettings.timeSignature);
    collector.setSettings(sequenceSettings);
    resetMetronomeClock();
    scheduleRender();
  });

  beatUnitSelect.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    beatUnit = asBeatUnit(target.value);
    resetMetronomeClock();
    scheduleRender();
  });

  toleranceInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    beatToleranceMs = clamp(parseInt(target.value || "80", 10), 20, 300);
    target.value = String(beatToleranceMs);
    scheduleRender();
  });

  visualMetronomeToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    enableVisualMetronome = target.checked;
    resetMetronomeClock();
    syncMetronomeAnimationLoop();
    scheduleRender();
  });

  soundMetronomeToggle.addEventListener("click", () => {
    enableMetronomeSound = !enableMetronomeSound;
    if (enableMetronomeSound) {
      void ensureSharedAudioContext();
    }
    resetMetronomeClock();
    syncMetronomeAnimationLoop();
    scheduleRender();
  });

  bleedThresholdInput.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    minBleedScore = clamp(parsed, 0.05, 0.49);
    scheduleRender();
  });

  bleedThresholdInput.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const parsed = Number.parseFloat(target.value);
    minBleedScore = Number.isFinite(parsed) ? clamp(parsed, 0.05, 0.49) : 0.14;
    target.value = minBleedScore.toFixed(2);
    scheduleRender();
  });

  stringPurityToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    enableStringPurityCheck = target.checked;
    syncStringPurityPipeline();
    scheduleRender();
  });

  exactToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    showExactIntonation = target.checked;
    scheduleRender();
  });

  trailToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    enableFadeTrail = target.checked;
    if (!enableFadeTrail) {
      trailNotes.length = 0;
    }
    scheduleRender();
  });
}

function scheduleRender(): void {
  if (renderPending) return;
  renderPending = true;
  window.requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

function render(): void {
  if (!ui) return;

  const nowMs = performance.now();
  const displayedMidi = state.live.displayedMidi;
  const solfege = displayedMidi !== null ? midiToSolfege(displayedMidi) : "-";
  const scientific = displayedMidi !== null ? midiToScientific(displayedMidi) : "-";
  const stringPurityActive = isStringPurityActive();
  appRoot.dataset.mode = state.mode;

  ui.listenBtn.textContent = state.listening ? "Stop Listening" : "Start Listening";
  ui.listenBtn.style.display =
    state.mode === "sequence" || state.mode === "sheet-entry" ? "none" : "";
  ui.modeSelect.value = state.mode;
  ui.recordBtn.disabled = state.mode !== "sequence";
  ui.recordBtn.style.display = state.mode === "sequence" ? "" : "none";
  ui.liveMetronomeControls.style.display =
    state.mode === "live" || state.mode === "practice" ? "grid" : "none";
  ui.practicePanel.style.display = state.mode === "practice" ? "block" : "none";
  ui.sequenceControls.style.display = state.mode === "sequence" ? "grid" : "none";
  ui.noteEntryControls.style.display = state.mode === "sheet-entry" ? "grid" : "none";
  ui.outputTitle.style.display = state.mode === "practice" ? "none" : "";
  ui.outputTitle.textContent =
    state.mode === "spectrum"
      ? "Spectrum Output"
      : state.mode === "practice"
        ? ""
        : state.mode === "sheet-entry"
          ? "Sheet Note Entry"
          : state.mode === "live"
            ? "Live Output"
            : "Sequence Output";
  ui.recordBtn.textContent = captureButtonLabel();
  ui.sequenceSubmodeSelect.value = sequenceSubMode;
  const activeElement = document.activeElement;
  ui.noteEntryTimeSignatureSelect.value = sheetEntryTimeSignature;
  ui.noteEntrySlotValueSelect.value = sheetEntrySlotValue;
  if (activeElement !== ui.noteEntryBarsInput) {
    ui.noteEntryBarsInput.value = String(sheetEntryBars);
  }
  ui.noteEntryToolSelect.value = sheetEntryTool;
  if (activeElement !== ui.liveBpmInput) {
    ui.liveBpmInput.value = String(sequenceSettings.bpm);
  }
  if (activeElement !== ui.bpmInput) {
    ui.bpmInput.value = String(sequenceSettings.bpm);
  }
  if (activeElement !== ui.practiceToleranceInput) {
    ui.practiceToleranceInput.value = String(practiceTolerancePct);
  }
  if (activeElement !== ui.practiceSensitivityInput) {
    ui.practiceSensitivityInput.value = liveSettings.confidenceThreshold.toFixed(2);
  }
  if (activeElement !== ui.practiceBleedSensitivityInput) {
    ui.practiceBleedSensitivityInput.value = practiceBleedSensitivity.toFixed(2);
  }
  ui.practiceCorrectionSourceSelect.value = practiceCorrectionSource;
  ui.practiceDebugToggle.checked = showPracticeDebug;
  ui.practiceDebugSection.style.display = showPracticeDebug ? "block" : "none";
  if (activeElement !== ui.practicePeakThresholdInput) {
    ui.practicePeakThresholdInput.value = String(practicePeakThreshold);
  }
  ui.practicePeakThresholdValue.textContent = String(practicePeakThreshold);
  if (activeElement !== ui.practicePeakMergeInput) {
    ui.practicePeakMergeInput.value = String(practicePeakMergeMs);
  }
  ui.timeSignatureSelect.value = sequenceSettings.timeSignature;
  ui.beatUnitSelect.value = beatUnit;
  ui.beatUnitSelect.disabled = sequenceSubMode === "single-beat";
  ui.toleranceInput.value = String(beatToleranceMs);
  ui.visualMetronomeToggle.checked = enableVisualMetronome;
  ui.soundMetronomeToggle.classList.toggle("is-on", enableMetronomeSound);
  ui.soundMetronomeToggle.setAttribute(
    "aria-label",
    enableMetronomeSound ? "Metronome sound on" : "Metronome sound off",
  );
  ui.soundMetronomeToggle.setAttribute("aria-pressed", String(enableMetronomeSound));
  if (document.activeElement !== ui.bleedThresholdInput) {
    ui.bleedThresholdInput.value = minBleedScore.toFixed(2);
  }
  ui.stringPurityToggle.checked = stringPurityActive;
  ui.stringPurityToggle.disabled = state.mode === "spectrum";
  ui.exactToggle.checked = showExactIntonation;
  ui.trailToggle.checked = enableFadeTrail;
  ui.staff.classList.toggle("sheet-entry-active", state.mode === "sheet-entry");
  ui.staff.classList.toggle("practice-sheet-active", state.mode === "practice");
  syncMetronomeAnimationLoop();

  const centsText = state.live.cents === null ? "" : ` (${formatSigned(state.live.cents)} cents)`;
  ui.noteMetric.innerHTML = `${solfege} <span class="muted">(${scientific})${centsText}</span>`;
  ui.bleedNoteLine.innerHTML = stringPurityActive ? buildBleedNoteLine(lastFrame) : "&nbsp;";

  const statusText = !state.listening
    ? "Not listening"
    : state.live.holdingLastNote
      ? "Holding last note"
      : "Listening";

  const freqText = state.live.freqHz ? `${state.live.freqHz.toFixed(1)} Hz` : "-";
  const confText = `${(state.live.confidence * 100).toFixed(0)}%`;
  const centsLine = state.live.cents === null ? "cents: -" : `cents: ${formatSigned(state.live.cents)}`;
  ui.liveMetaLine.textContent = `${freqText} | ${confText} | ${centsLine} | ${statusText}`;
  ui.liveMetaLine.style.display = state.mode === "practice" ? "none" : "";
  renderPracticePanel();
  ui.purityMetaLine.style.display = stringPurityActive && state.mode !== "practice" ? "" : "none";
  if (stringPurityActive) {
    ui.purityMetaLine.textContent = formatStringPurityLine(lastFrame);
  }

  if (state.mode === "live") {
    ui.captureHint.textContent = "Live intonation";
  } else if (state.mode === "practice") {
    ui.captureHint.textContent = "Pattern + pulse";
  } else if (state.mode === "spectrum") {
    ui.captureHint.textContent = "Spectrum";
  } else if (state.mode === "sheet-entry") {
    ui.captureHint.textContent = "Click notes";
  } else if (sequenceSubMode === "single-beat") {
    ui.captureHint.textContent = "Single beat drill";
  } else if (state.recording) {
    ui.captureHint.textContent = "Recording phrase";
  } else if (state.listening) {
    ui.captureHint.textContent = "Phrase ready";
  } else {
    ui.captureHint.textContent = "Sequence capture";
  }

  const singleBeatModeActive = state.mode === "sequence" && sequenceSubMode === "single-beat";
  const sheetEntryModeActive = state.mode === "sheet-entry";
  const spectrumModeActive = state.mode === "spectrum";
  const practicePatternStaffActive = state.mode === "practice";
  const currentSnapshot = buildCurrentNoteSnapshot(displayedMidi);
  ui.staff.style.display = spectrumModeActive ? "none" : "block";
  ui.spectrumPanel.style.display = spectrumModeActive ? "block" : "none";
  ui.spectrogramOverlay.innerHTML = spectrumModeActive
    ? renderSpectrumOverlay(lastFrame, minBleedScore)
    : "";

  if (spectrumModeActive) {
    ui.staffBatchLayer.style.display = "none";
    ui.staffBatchLayer.innerHTML = "";
    ui.noteGroup.style.visibility = "hidden";
    ui.ledgerLayer.innerHTML = "";
    ui.trailLayer.innerHTML = "";
    trailNotes.length = 0;
    previousDisplayedSnapshot = null;
  } else if (practicePatternStaffActive) {
    ui.staffBatchLayer.style.display = "block";
    ui.staffBatchLayer.innerHTML = renderStaffPracticePattern(nowMs);
    scrollPracticeSheetToActiveRow();
    ui.noteGroup.style.visibility = "hidden";
    ui.ledgerLayer.innerHTML = "";
    ui.trailLayer.innerHTML = "";
    trailNotes.length = 0;
    previousDisplayedSnapshot = null;
  } else if (sheetEntryModeActive) {
    ui.staffBatchLayer.style.display = "block";
    ui.staffBatchLayer.innerHTML = renderStaffSheetEntry();
    ui.noteGroup.style.visibility = "hidden";
    ui.ledgerLayer.innerHTML = "";
    ui.trailLayer.innerHTML = "";
    trailNotes.length = 0;
    previousDisplayedSnapshot = null;
  } else if (!singleBeatModeActive) {
    ui.staffBatchLayer.style.display = "none";
    ui.staffBatchLayer.innerHTML = "";
    maybeSpawnTrail(currentSnapshot, nowMs);
    renderTrails(nowMs);

    if (currentSnapshot === null) {
      ui.noteGroup.style.visibility = "hidden";
      ui.ledgerLayer.innerHTML = "";
    } else {
      ui.noteGroup.style.visibility = "visible";
      ui.noteGroup.style.top = `${currentSnapshot.y.toFixed(1)}px`;
      ui.noteGroup.classList.toggle("stem-up", currentSnapshot.stemDirection === "up");
      ui.noteGroup.classList.toggle("stem-down", currentSnapshot.stemDirection === "down");

      ui.ledgerLayer.innerHTML = currentSnapshot.ledgerYs
        .map((lineY) => `<div class="ledger-line" style="top:${lineY.toFixed(1)}px"></div>`)
        .join("");
    }
  } else {
    ui.staffBatchLayer.style.display = "block";
    ui.staffBatchLayer.innerHTML = renderStaffBeatBatch(nowMs);
    ui.noteGroup.style.visibility = "hidden";
    ui.ledgerLayer.innerHTML = "";
    ui.trailLayer.innerHTML = "";
    trailNotes.length = 0;
    previousDisplayedSnapshot = null;
  }

  const showMetronome = enableVisualMetronome && state.mode !== "spectrum";
  ui.metronomeBox.style.display = showMetronome ? "block" : "none";
  if (showMetronome) {
    ui.metronomeBox.innerHTML = renderVisualMetronome(performance.now());
  } else {
    ui.metronomeBox.innerHTML = "";
  }

  if (state.mode === "spectrum") {
    ui.beatBatchBox.style.display = "none";
    ui.beatBatchBox.innerHTML = "";
    ui.sequenceMeta.textContent = "Live spectrum | log frequency scale | fixed-do reference labels";
    ui.sequenceSummary.textContent = renderSpectrumSummary(lastFrame, minBleedScore);
  } else if (state.mode === "sheet-entry") {
    ui.beatBatchBox.style.display = "none";
    ui.beatBatchBox.innerHTML = "";
    ui.sequenceMeta.textContent =
      `Sheet entry | ${sheetEntryBars} bar${sheetEntryBars === 1 ? "" : "s"} | ${sheetEntryTimeSignature} | ${sheetEntrySlotCount} ${sheetEntrySlotValue}-note slots | ASCII pitch names`;
    ui.sequenceSummary.textContent = renderSheetEntrySummary();
  } else if (state.mode === "sequence" && sequenceSubMode === "single-beat") {
    const targetMs = barDurationMs(sequenceSettings.bpm, sequenceSettings.timeSignature);
    const beatsInBar = beatsPerBar(sequenceSettings.timeSignature);
    ui.sequenceMeta.textContent =
      `Single Beat Drill | ${sequenceSettings.timeSignature} | ${beatsInBar} beats per bar | bar target ${Math.round(targetMs)} ms | tolerance ±${beatToleranceMs} ms`;
    ui.beatBatchBox.style.display = "block";
    ui.beatBatchBox.innerHTML = renderBeatBatchVisualization();
    ui.sequenceSummary.textContent = `${singleBeatDebug}\n\n${renderBeatDrillSummary()}`;
  } else if (state.mode === "sequence") {
    ui.beatBatchBox.style.display = "none";
    ui.beatBatchBox.innerHTML = "";
    ui.sequenceMeta.textContent = `${sequenceSettings.timeSignature} at ${sequenceSettings.bpm} BPM, grid ${sequenceSettings.quantization}`;
    ui.sequenceSummary.textContent = renderSequenceSummary(state.sequence);
  } else {
    ui.beatBatchBox.style.display = "none";
    ui.beatBatchBox.innerHTML = "";
    if (state.mode === "practice") {
      ui.sequenceMeta.textContent = "";
      ui.sequenceSummary.textContent = "";
    } else {
      ui.sequenceMeta.textContent = "Live intonation | staff placement | optional fade trail";
      ui.sequenceSummary.textContent = "Use Live Mode for note, cents, confidence, and optional adjacent-string bleed checks.";
    }
  }

  if (fadingBeatBatches.length > 0 || practicePatternPlaying) {
    scheduleRender();
  }
}

function captureButtonLabel(): string {
  if (state.mode !== "sequence") {
    return "Start Capture";
  }

  if (sequenceSubMode === "single-beat") {
    return state.recording ? "Stop Single Beat Drill" : "Start Single Beat Drill";
  }

  return state.recording ? "Stop Phrase Capture" : "Start Phrase Capture";
}

async function onTogglePracticePatternPlayback(): Promise<void> {
  if (practicePatternPlaying) {
    stopPracticePatternPlayback(false);
    return;
  }

  if (state.mode !== "practice") {
    state.mode = "practice";
  }

  if (!state.listening) {
    await onToggleListening();
    if (!state.listening) {
      return;
    }
  }

  const pattern = selectedPracticePattern();
  applyPracticePatternInitialTempo(pattern);
  const startMs = performance.now();

  practicePatternResults = createPracticePatternResults();
  practicePatternPassSummary = null;
  practicePatternPassAccumulator = createPracticePatternPassAccumulator();
  practicePatternPlaying = true;
  practicePatternActiveIndex = null;
  practicePatternCycleIndex = 0;
  practicePatternLastScrolledRow = -1;
  metronomeStartMs = startMs;
  practicePatternStartedAtMs = startMs + practicePatternCountInBeats * practicePatternNoteDurationMs();
  metronomeLastTickIndex = null;
  enableVisualMetronome = true;
  pipeline?.resetTempo();
  resetPracticeEstimate(sequenceSettings.bpm);
  syncMetronomeAnimationLoop();
  syncPracticePatternStopTimer(pattern);

  scheduleRender();
}

function stopPracticePatternPlayback(resetResults: boolean): void {
  practicePatternPlaying = false;
  practicePatternActiveIndex = null;
  practicePatternStartedAtMs = 0;
  practicePatternCycleIndex = 0;
  practicePatternLastScrolledRow = -1;
  if (practicePatternStopTimer !== null) {
    window.clearTimeout(practicePatternStopTimer);
    practicePatternStopTimer = null;
  }
  if (resetResults) {
    practicePatternResults = createPracticePatternResults();
    practicePatternPassSummary = null;
    practicePatternPassAccumulator = createPracticePatternPassAccumulator();
  }
  scheduleRender();
}

function syncPracticePatternStopTimer(pattern = selectedPracticePattern()): void {
  if (practicePatternStopTimer !== null) {
    window.clearTimeout(practicePatternStopTimer);
    practicePatternStopTimer = null;
  }

  if (!practicePatternPlaying || practicePatternLoopEnabled || pattern.notes.length === 0) {
    return;
  }

  const cycleDurationMs = pattern.notes.length * practicePatternNoteDurationMs();
  const elapsedMs = performance.now() - practicePatternStartedAtMs;
  const currentCycle = Math.max(0, Math.floor(Math.max(0, elapsedMs) / cycleDurationMs));
  const remainingMs =
    practicePatternStartedAtMs + (currentCycle + 1) * cycleDurationMs - performance.now() + 140;

  if (remainingMs <= 0) {
    markElapsedPracticePatternOrder(practicePatternTraversalOrder(pattern), pattern.notes.length, 0);
    finalizePracticePatternPass(practicePatternCycleIndex, practicePatternTraversalOrder(pattern));
    stopPracticePatternPlayback(false);
    return;
  }

  practicePatternStopTimer = window.setTimeout(() => {
    markElapsedPracticePatternOrder(practicePatternTraversalOrder(pattern), pattern.notes.length, 0);
    finalizePracticePatternPass(practicePatternCycleIndex, practicePatternTraversalOrder(pattern));
    stopPracticePatternPlayback(false);
  }, remainingMs);
}

function practicePatternNoteDurationMs(): number {
  return metronomeBeatDurationMs();
}

function practicePatternCurrentIndex(nowMs: number): number | null {
  return practicePatternCurrentPosition(nowMs)?.noteIndex ?? null;
}

function practicePatternCurrentPosition(nowMs: number): PracticePatternPosition | null {
  if (!practicePatternPlaying || practicePatternStartedAtMs <= 0) {
    return null;
  }
  const pattern = selectedPracticePattern();
  if (pattern.notes.length === 0) {
    return null;
  }
  const elapsedMs = nowMs - practicePatternStartedAtMs;
  if (elapsedMs < 0) {
    return null;
  }
  const noteDurationMs = practicePatternNoteDurationMs();
  const order = practicePatternTraversalOrder(pattern);
  const cycleDurationMs = order.length * noteDurationMs;
  const cycleIndex = Math.floor(elapsedMs / cycleDurationMs);
  if (!practicePatternLoopEnabled && cycleIndex > practicePatternCycleIndex) {
    return null;
  }
  const cycleElapsedMs = practicePatternLoopEnabled ? elapsedMs % cycleDurationMs : elapsedMs;
  const stepIndex = Math.floor(cycleElapsedMs / noteDurationMs);
  const cycleKey = practicePatternResultCycleKey(cycleIndex, stepIndex, pattern.notes.length);
  if (practicePatternLoopEnabled && cycleKey !== practicePatternCycleIndex) {
    finalizePracticePatternPass(practicePatternCycleIndex, order);
    practicePatternCycleIndex = cycleKey;
    practicePatternResults = createPracticePatternResults();
    practicePatternPassAccumulator = createPracticePatternPassAccumulator();
  }
  const noteIndex = order[stepIndex];
  return noteIndex !== undefined
    ? {
        noteIndex,
        stepIndex,
        passStartStepIndex: practicePatternPassStartStepIndex(stepIndex, pattern.notes.length),
        cycleIndex,
        cycleKey,
        stepElapsedMs: cycleElapsedMs - stepIndex * noteDurationMs,
        order,
      }
    : null;
}

function capturePracticePatternFrame(frame: PitchFrame): void {
  if (!practicePatternPlaying || state.mode !== "practice") {
    return;
  }

  const position = practicePatternCurrentPosition(frame.tMs);
  practicePatternActiveIndex = position?.noteIndex ?? null;
  if (!position) {
    return;
  }
  markElapsedPracticePatternSteps(position);
  capturePracticePatternBleedFrame(frame);

  const result = practicePatternResults[position.noteIndex];
  const target = selectedPracticePattern().notes[position.noteIndex];
  if (!result || !target) {
    return;
  }

  const bleedMidi = practiceBleedMidi(frame);
  if (bleedMidi !== null) {
    result.bleedMidi = bleedMidi;
  }

  const noteDurationMs = practicePatternNoteDurationMs();
  if (position.stepElapsedMs < noteDurationMs * 0.18) {
    return;
  }

  const playedMidi =
    state.live.detectedMidi ?? (frame.confidence >= liveSettings.confidenceThreshold ? frame.midi : null);
  if (playedMidi === null) {
    return;
  }

  const isCorrect = playedMidi === target.midi;
  if (result.status === "pending") {
    result.status = isCorrect ? "correct" : "wrong";
    result.playedMidi = playedMidi;
  }
}

function markElapsedPracticePatternSteps(position: PracticePatternPosition): void {
  markElapsedPracticePatternOrder(
    position.order,
    position.stepIndex,
    position.passStartStepIndex,
  );
}

function markElapsedPracticePatternOrder(
  order: number[],
  activeStepIndex: number,
  startStepIndex: number,
): void {
  const upperBound = Math.min(activeStepIndex, order.length);
  for (let i = Math.max(0, startStepIndex); i < upperBound; i += 1) {
    const resultIndex = order[i];
    if (resultIndex === undefined) {
      continue;
    }
    const result = practicePatternResults[resultIndex];
    if (result && result.status === "pending") {
      result.status = "wrong";
      result.playedMidi = null;
    }
  }
}

function finalizePracticePatternPass(cycleKey: number, order: number[]): void {
  const pattern = selectedPracticePattern();
  if (pattern.notes.length === 0) {
    return;
  }

  const direction = practicePatternPassDirection(cycleKey);
  const startStepIndex =
    direction === "backward" && practicePatternLoopMode === "back-and-forth"
      ? pattern.notes.length
      : 0;
  const endStepIndex =
    direction === "backward" && practicePatternLoopMode === "back-and-forth"
      ? order.length
      : pattern.notes.length;
  markElapsedPracticePatternOrder(order, endStepIndex, startStepIndex);

  const passIndexes = order.slice(startStepIndex, endStepIndex);
  const total = passIndexes.length;
  if (total === 0) {
    return;
  }
  const correct = passIndexes.filter(
    (noteIndex) => practicePatternResults[noteIndex]?.status === "correct",
  ).length;
  const wrong = total - correct;
  const tempoStatus = summarizePracticePassTempo(practicePatternPassAccumulator);
  const bleedString = mostCommonBleedString(practicePatternPassAccumulator.bleedStringCounts);
  practicePatternPassSummary = {
    direction,
    correct,
    wrong,
    total,
    tempoStatus,
    tempoLabel: practicePassTempoLabel(tempoStatus),
    bleedDetected: practicePatternPassAccumulator.bleedFrameCount > 0,
    bleedFrameRatio:
      practicePatternPassAccumulator.bleedFrameCount /
      Math.max(1, practicePatternPassAccumulator.frameCount),
    bleedString,
  };
  advancePracticePatternTempo(pattern);
}

function applyPracticePatternInitialTempo(pattern: PracticePattern): void {
  if (!pattern.tempoRamp) {
    return;
  }
  setPracticeBpm(pattern.tempoRamp.initialBpm, true);
}

function advancePracticePatternTempo(pattern: PracticePattern): void {
  const ramp = pattern.tempoRamp;
  if (!ramp || ramp.stepBpm <= 0) {
    return;
  }
  const nextBpm = Math.min(ramp.maxBpm, sequenceSettings.bpm + ramp.stepBpm);
  if (nextBpm === sequenceSettings.bpm) {
    return;
  }
  setPracticeBpm(nextBpm, false);
}

function setPracticeBpm(nextBpm: number, resetTempo: boolean): void {
  const bpm = clamp(Math.round(nextBpm), 30, 240);
  if (bpm === sequenceSettings.bpm) {
    return;
  }
  sequenceSettings.bpm = bpm;
  state.practice.targetBpm = bpm;
  if (!practicePeakMergeTouched) {
    practicePeakMergeMs = defaultPracticePeakMergeMs(bpm);
  }
  pipeline?.setPracticeTargetBpm(bpm);
  syncPracticePeakPickingPipeline();
  collector.setSettings(sequenceSettings);
  if (resetTempo) {
    pipeline?.resetTempo();
    resetPracticeEstimate(bpm);
    resetMetronomeClock();
  }
}

function practicePatternPassDirection(cycleKey: number): PracticePatternPassDirection {
  return practicePatternLoopMode === "back-and-forth" && cycleKey % 2 === 1
    ? "backward"
    : "forward";
}

function createPracticePatternPassAccumulator(): PracticePatternPassAccumulator {
  return {
    tempoCounts: {
      "play-faster": 0,
      "play-slower": 0,
      "on-tempo": 0,
    },
    tempoSamples: 0,
    frameCount: 0,
    bleedFrameCount: 0,
    bleedStringCounts: new Map<string, number>(),
  };
}

function capturePracticePatternBleedFrame(frame: PitchFrame): void {
  if (!isAudiblePracticeFrame(frame)) {
    return;
  }
  practicePatternPassAccumulator.frameCount += 1;
  const bleedRatio = frame.adjacentBleedRatio ?? 0;
  if (bleedRatio < practiceBleedSensitivity) {
    return;
  }
  practicePatternPassAccumulator.bleedFrameCount += 1;
  if (frame.bleedString) {
    practicePatternPassAccumulator.bleedStringCounts.set(
      frame.bleedString,
      (practicePatternPassAccumulator.bleedStringCounts.get(frame.bleedString) ?? 0) + 1,
    );
  }
}

function practiceBleedMidi(frame: PitchFrame): number | null {
  if (!isAudiblePracticeFrame(frame)) {
    return null;
  }
  const bleedRatio = frame.adjacentBleedRatio ?? 0;
  if (bleedRatio < practiceBleedSensitivity || !frame.bleedString) {
    return null;
  }
  return openStringMidi(frame.bleedString);
}

function isAudiblePracticeFrame(frame: PitchFrame): boolean {
  return (
    frame.midi !== null &&
    frame.confidence >= liveSettings.confidenceThreshold
  );
}

function openStringMidi(stringName: "G" | "D" | "A" | "E"): number {
  if (stringName === "G") return 55;
  if (stringName === "D") return 62;
  if (stringName === "A") return 69;
  return 76;
}

function capturePracticePatternTempoFrame(frame: TempoFrame): void {
  if (!practicePatternPlaying || state.mode !== "practice" || frame.tMs < practicePatternStartedAtMs) {
    return;
  }
  if (
    frame.status !== "play-faster" &&
    frame.status !== "play-slower" &&
    frame.status !== "on-tempo"
  ) {
    return;
  }
  practicePatternPassAccumulator.tempoCounts[frame.status] += 1;
  practicePatternPassAccumulator.tempoSamples += 1;
}

function summarizePracticePassTempo(
  accumulator: PracticePatternPassAccumulator,
): TempoFrame["status"] {
  const faster = accumulator.tempoCounts["play-faster"];
  const slower = accumulator.tempoCounts["play-slower"];
  const onTempo = accumulator.tempoCounts["on-tempo"];
  const total = faster + slower + onTempo;
  if (total < 4) {
    return "insufficient";
  }
  if (faster >= total * 0.6 && faster > slower) {
    return "play-faster";
  }
  if (slower >= total * 0.6 && slower > faster) {
    return "play-slower";
  }
  return "on-tempo";
}

function practicePassTempoLabel(status: TempoFrame["status"]): string {
  switch (status) {
    case "play-faster":
      return "Overall: play faster";
    case "play-slower":
      return "Overall: play slower";
    case "on-tempo":
      return "Overall: aim for the metronome";
    case "insufficient":
      return "Overall: not enough timing data";
    case "idle":
    default:
      return "Overall: start playing";
  }
}

function mostCommonBleedString(counts: Map<string, number>): string | null {
  let bestString: string | null = null;
  let bestCount = 0;
  for (const [stringName, count] of counts.entries()) {
    if (count > bestCount) {
      bestString = stringName;
      bestCount = count;
    }
  }
  return bestString;
}

function practicePatternTraversalOrder(pattern = selectedPracticePattern()): number[] {
  const forward = pattern.notes.map((_, index) => index);
  if (
    !practicePatternLoopEnabled ||
    practicePatternLoopMode === "restart" ||
    pattern.notes.length <= 2
  ) {
    return forward;
  }
  return [...forward, ...[...forward].reverse()];
}

function practicePatternResultCycleKey(
  cycleIndex: number,
  stepIndex: number,
  noteCount: number,
): number {
  if (
    !practicePatternLoopEnabled ||
    practicePatternLoopMode === "restart" ||
    noteCount <= 2 ||
    stepIndex < noteCount
  ) {
    return cycleIndex * 2;
  }
  return cycleIndex * 2 + 1;
}

function practicePatternPassStartStepIndex(stepIndex: number, noteCount: number): number {
  if (
    practicePatternLoopEnabled &&
    practicePatternLoopMode === "back-and-forth" &&
    noteCount > 2 &&
    stepIndex >= noteCount
  ) {
    return noteCount;
  }
  return 0;
}

function practicePatternCycleIndexForNow(): number {
  return practicePatternCurrentPosition(performance.now())?.cycleKey ?? 0;
}

function practicePatternReadoutText(): string {
  const pattern = selectedPracticePattern();
  const countInRemaining = practicePatternCountInRemainingBeats(performance.now());
  if (countInRemaining !== null) {
    return `Count-in ${countInRemaining}`;
  }
  if (practicePatternActiveIndex !== null) {
    return `${practicePatternActiveIndex + 1}/${pattern.notes.length}`;
  }
  if (!practicePatternPlaying && practicePatternPassSummary) {
    return "Done";
  }
  return "Ready";
}

function practicePatternCountInRemainingBeats(nowMs: number): number | null {
  if (!practicePatternPlaying || practicePatternStartedAtMs <= 0 || nowMs >= practicePatternStartedAtMs) {
    return null;
  }
  const remainingMs = practicePatternStartedAtMs - nowMs;
  return Math.max(1, Math.ceil(remainingMs / practicePatternNoteDurationMs()));
}

function resetPracticeEstimate(targetBpm = sequenceSettings.bpm): void {
  lastTempoFrame = null;
  state.practice = {
    targetBpm,
    estimatedBpm: null,
    differenceBpm: null,
    confidence: 0,
    status: state.listening ? "insufficient" : "idle",
    novelty: 0,
    debug: null,
  };
}

function renderPracticePanel(): void {
  if (!ui) return;

  const practice = state.practice;
  const pattern = selectedPracticePattern();
  const statusLabel = practiceStatusLabel(practice.status, state.listening);
  const statusClass = practice.status;
  ui.practiceStatus.className = `practice-status status-${statusClass}`;
  ui.practiceStatus.textContent = statusLabel;
  ui.practicePatternSelect.value = pattern.id;
  ui.practicePatternLoopToggle.checked = practicePatternLoopEnabled;
  ui.practicePatternLoopModeSelect.value = practicePatternLoopMode;
  ui.practicePatternLoopModeSelect.disabled = !practicePatternLoopEnabled;
  ui.practicePatternName.textContent = pattern.name;
  ui.practicePatternPlayBtn.textContent = practicePatternPlaying ? "■" : "▶";
  ui.practicePatternPlayBtn.setAttribute(
    "aria-label",
    practicePatternPlaying ? `Stop ${pattern.name}` : `Start ${pattern.name}`,
  );
  ui.practicePatternPlayBtn.classList.toggle("playing", practicePatternPlaying);
  ui.practicePatternReadout.textContent = practicePatternReadoutText();
  ui.practiceOverallFeedback.className = `practice-overall-feedback ${practicePatternPassSummary ? `status-${practicePatternPassSummary.tempoStatus}` : "status-idle"}`;
  ui.practiceOverallFeedback.textContent = practicePatternOverallFeedbackText();

  const estimatedText =
    practice.estimatedBpm === null ? "-" : `${Math.round(practice.estimatedBpm)}`;
  const diffText =
    practice.differenceBpm === null
      ? ""
      : ` ${formatSigned(practice.differenceBpm)}`;
  ui.practiceEstimate.textContent =
    `${practice.targetBpm} bpm target · ${estimatedText}${diffText} · conf ${(practice.confidence * 100).toFixed(0)}% · signal ${(practice.novelty * 100).toFixed(0)}%`;
  ui.practiceDetail.textContent =
    `±${practiceTolerancePct}% · ${practiceCorrectionSource}`;
  ui.practiceDebug.innerHTML = renderPracticeDebug();
}

function practicePatternOverallFeedbackText(): string {
  const summary = practicePatternPassSummary;
  if (!summary) {
    return practicePatternPlaying
      ? "Finish pass"
      : "After first pass";
  }

  if (summary.bleedDetected && summary.bleedFrameRatio >= 0.12) {
    return "One string only";
  }
  if (summary.wrong > 0) {
    return "Check notes";
  }
  if (summary.tempoStatus === "play-faster") {
    return "Play faster";
  }
  if (summary.tempoStatus === "play-slower") {
    return "Play slower";
  }
  if (summary.tempoStatus === "on-tempo") {
    return "On tempo";
  }
  return "Good round";
}

function renderPracticeDebug(): string {
  const debug = state.practice.debug;
  if (!debug) {
    return `
      <div class="practice-debug-empty">Waiting for audio frames.</div>
    `;
  }

  const signalPct = rmsToDisplayPct(debug.rms);
  const gatePct = rmsToDisplayPct(debug.gateRms);
  const sustainPct = rmsToDisplayPct(debug.sustainGateRms);
  const noisePct = rmsToDisplayPct(debug.noiseFloorRms);
  const autoBpm = debug.autocorrelationBpm === null ? "-" : Math.round(debug.autocorrelationBpm).toString();
  const peakBpm = debug.peakBpm === null ? "-" : Math.round(debug.peakBpm).toString();
  const recentPeakBpm = debug.recentPeakBpm === null ? "-" : Math.round(debug.recentPeakBpm).toString();
  const intervalText =
    debug.recentIntervalsMs.length === 0
      ? "-"
      : debug.recentIntervalsMs.map((intervalMs) => `${Math.round(intervalMs)}ms`).join(", ");
  const responseCards = debug.responsivenessEstimates
    .map((estimate) => {
      const bpmText = estimate.bpm === null ? "-" : `${Math.round(estimate.bpm)}`;
      const intervalsText =
        estimate.intervalsMs.length === 0
          ? "-"
          : estimate.intervalsMs.map((intervalMs) => `${Math.round(intervalMs)}`).join(", ");
      return `
        <div class="practice-response-card">
          <span>${estimate.label}</span>
          <strong>${bpmText} BPM</strong>
          <small>${estimate.intervalCount} intervals | ${(estimate.confidence * 100).toFixed(0)}% | ${intervalsText} ms</small>
        </div>
      `;
    })
    .join("");

  return `
    <div class="practice-debug-grid">
      <div class="practice-debug-cell">
        <span>Gate</span>
        <strong>${debug.active ? "open" : "closed"}</strong>
        <small>signal ${formatRms(debug.rms)} | open ${formatRms(debug.gateRms)} | sustain ${formatRms(debug.sustainGateRms)} | floor ${formatRms(debug.noiseFloorRms)}</small>
        <div class="practice-level">
          <div class="practice-level-fill" style="width:${signalPct.toFixed(1)}%"></div>
          <div class="practice-level-marker gate" style="left:${gatePct.toFixed(1)}%"></div>
          <div class="practice-level-marker sustain" style="left:${sustainPct.toFixed(1)}%"></div>
          <div class="practice-level-marker noise" style="left:${noisePct.toFixed(1)}%"></div>
        </div>
      </div>
      <div class="practice-debug-cell">
        <span>Active frames</span>
        <strong>${(debug.recentActiveRatio * 100).toFixed(0)}%</strong>
        <small>window ${(debug.activeRatio * 100).toFixed(0)}% | recent ${(debug.recentActiveRatio * 100).toFixed(0)}%</small>
      </div>
      <div class="practice-debug-cell">
        <span>Peaks</span>
        <strong>${debug.peakCount}</strong>
        <small>recent ${recentPeakBpm} BPM (${(debug.recentPeakConfidence * 100).toFixed(0)}%) | window ${peakBpm} BPM | threshold ${debug.peakThreshold} | merge ${Math.round(debug.peakMergeMs)} ms</small>
      </div>
      <div class="practice-debug-cell">
        <span>Periodicity</span>
        <strong>${autoBpm} BPM</strong>
        <small>confidence ${(debug.autocorrelationConfidence * 100).toFixed(0)}%</small>
      </div>
      <div class="practice-debug-cell wide">
        <span>Committed intervals</span>
        <strong>${practiceCorrectionSource}: ${intervalText}</strong>
        <small>correction label uses ${practiceCorrectionSource}; compare all three below</small>
        <div class="practice-response-grid">${responseCards}</div>
      </div>
    </div>
    ${renderNoveltyTrace(debug.points)}
  `;
}

function renderNoveltyTrace(points: TempoFrame["debug"]["points"]): string {
  if (points.length === 0) {
    return `<div class="practice-trace empty"></div>`;
  }

  const bars = points
    .map((point) => {
      const height = Math.max(3, point.value * 100);
      const classes = [
        "practice-trace-bar",
        point.active ? "active" : "inactive",
        point.peak ? "peak" : "",
      ].filter(Boolean).join(" ");
      return `<div class="${classes}" style="height:${height.toFixed(1)}%"></div>`;
    })
    .join("");

  return `
    <div class="practice-trace-wrap">
      <div class="practice-trace-label">
        <span>Novelty timeline</span>
        <small>bright bars are detected event peaks</small>
      </div>
      <div class="practice-trace">${bars}</div>
    </div>
  `;
}

function rmsToDisplayPct(rms: number): number {
  return clamp((Math.log10(rms + 0.0015) + 2.8) / 1.65, 0, 1) * 100;
}

function formatRms(rms: number): string {
  return rms.toFixed(4);
}

function practiceStatusLabel(status: TempoFrame["status"], listening: boolean): string {
  if (!listening) return "Start listening";
  switch (status) {
    case "on-tempo":
      return "On tempo";
    case "play-faster":
      return "Play faster";
    case "play-slower":
      return "Play slower";
    case "insufficient":
      return "Finding pulse";
    case "idle":
    default:
      return "Start playing";
  }
}

function isStringPurityActive(): boolean {
  return enableStringPurityCheck || state.mode === "practice" || state.mode === "spectrum";
}

function syncStringPurityPipeline(): void {
  pipeline?.setStringPurityEnabled(isStringPurityActive());
}

function syncPracticePeakPickingPipeline(): void {
  pipeline?.setPracticePeakPicking(practicePeakThreshold, practicePeakMergeMs);
}

function syncPracticeTolerancePipeline(): void {
  pipeline?.setPracticeTolerancePct(practiceTolerancePct / 100);
}

function syncPracticeCorrectionSourcePipeline(): void {
  pipeline?.setPracticeCorrectionSource(practiceCorrectionSource);
}

function syncPracticeSensitivityPipeline(): void {
  pipeline?.setPitchRmsThreshold(sensitivityToRmsThreshold(liveSettings.confidenceThreshold));
}

function activeBleedThreshold(): number {
  return state.mode === "practice" ? practiceBleedSensitivity : minBleedScore;
}

function sensitivityToRmsThreshold(sensitivity: number): number {
  const normalized = (clamp(sensitivity, 0.1, 0.95) - 0.1) / 0.85;
  const minRms = 0.004;
  const maxRms = 0.06;
  return minRms * (maxRms / minRms) ** normalized;
}

function asPracticePatternLoopMode(value: string): PracticePatternLoopMode {
  return value === "back-and-forth" ? "back-and-forth" : "restart";
}

function defaultPracticePeakMergeMs(bpm: number): number {
  return Math.round(clamp((60_000 / bpm) * 0.55, 180, 460) / 10) * 10;
}

function asPracticeCorrectionSource(value: string): TempoResponsivenessLabel {
  return value === "Fast" || value === "Stable" ? value : "Balanced";
}

function buildCurrentNoteSnapshot(displayedMidi: number | null): NoteSnapshot | null {
  if (displayedMidi === null) {
    return null;
  }

  const y = showExactIntonation
    ? midiWithCentsToStaffY(displayedMidi, state.live.cents)
    : midiToStaffY(displayedMidi);

  return {
    midi: displayedMidi,
    y,
    stemDirection: stemDirectionForMidi(displayedMidi),
    ledgerYs: ledgerLineYs(displayedMidi),
  };
}

function maybeSpawnTrail(currentSnapshot: NoteSnapshot | null, nowMs: number): void {
  const previousMidi = previousDisplayedSnapshot ? previousDisplayedSnapshot.midi : null;
  const currentMidi = currentSnapshot ? currentSnapshot.midi : null;
  const noteChanged = previousMidi !== currentMidi;

  if (noteChanged && previousDisplayedSnapshot !== null && enableFadeTrail && state.listening) {
    trailNotes.push({
      startedAtMs: nowMs,
      midi: previousDisplayedSnapshot.midi,
      y: previousDisplayedSnapshot.y,
      stemDirection: previousDisplayedSnapshot.stemDirection,
      ledgerYs: [...previousDisplayedSnapshot.ledgerYs],
    });
  }

  previousDisplayedSnapshot = currentSnapshot
    ? {
        midi: currentSnapshot.midi,
        y: currentSnapshot.y,
        stemDirection: currentSnapshot.stemDirection,
        ledgerYs: [...currentSnapshot.ledgerYs],
      }
    : null;
}

function renderTrails(nowMs: number): void {
  if (!ui) return;

  if (!enableFadeTrail) {
    ui.trailLayer.innerHTML = "";
    trailNotes.length = 0;
    return;
  }

  const alive: TrailNote[] = [];
  let html = "";

  for (const trail of trailNotes) {
    const ageMs = nowMs - trail.startedAtMs;
    if (ageMs >= TRAIL_DURATION_MS) {
      continue;
    }

    const progress = ageMs / TRAIL_DURATION_MS;
    const opacity = 1 - progress;
    const leftPct = TRAIL_START_LEFT_PCT - (TRAIL_START_LEFT_PCT - TRAIL_END_LEFT_PCT) * progress;

    alive.push(trail);

    html += `
      <div class="trail-note ${trail.stemDirection === "up" ? "stem-up" : "stem-down"}" style="top:${trail.y.toFixed(1)}px; left:${leftPct.toFixed(2)}%; opacity:${opacity.toFixed(3)};">
        ${trail.ledgerYs
          .map(
            (lineY) =>
              `<div class="trail-ledger-line" style="top:${(lineY - trail.y).toFixed(1)}px"></div>`,
          )
          .join("")}
        <div class="trail-note-head"></div>
        <div class="trail-note-stem"></div>
      </div>
    `;
  }

  trailNotes.length = 0;
  trailNotes.push(...alive);
  ui.trailLayer.innerHTML = html;
}

function renderVisualMetronome(nowMs: number): string {
  const beats = metronomePatternForMode();
  const beatDurationMs = metronomeBeatDurationMs();
  const elapsedMs = nowMs - metronomeStartMs;
  const countInRemaining = practicePatternCountInRemainingBeats(nowMs);
  const cycleMs = beatDurationMs * beats.length;
  const cyclePos = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  const beatIndex = Math.floor(cyclePos / beatDurationMs);
  const beatElapsedMs = cyclePos % beatDurationMs;

  // Two-phase visual envelope:
  // 1) Fast attack at beat strike for crisp timing.
  // 2) Slower release tail so the pulse remains readable between beats.
  const attackMs = 85;
  const releaseMs = Math.min(380, Math.max(140, beatDurationMs - attackMs));
  const inAttack = beatElapsedMs <= attackMs;
  const attackProgress = inAttack ? beatElapsedMs / attackMs : 1;
  const releaseProgress = inAttack
    ? 0
    : Math.min(1, (beatElapsedMs - attackMs) / Math.max(1, releaseMs));
  const attackImpact = inAttack ? 1 - attackProgress : 0;
  const releaseTail = inAttack ? 1 : 1 - releaseProgress;

  const pulseHtml = beats
    .map((accent, i) => {
      const isActive = i === beatIndex;
      if (!isActive) {
        return `<div class="metro-beat accent-${accent}" style="--pulse-scale:1.000; --pulse-opacity:0.42; --pulse-glow:0;"></div>`;
      }

      const pulseScale = (1.12 + releaseTail * 0.14 + attackImpact * 0.28).toFixed(3);
      const pulseOpacity = (0.5 + releaseTail * 0.38 + attackImpact * 0.18).toFixed(3);
      const pulseGlow = (0.18 + releaseTail * 0.42 + attackImpact * 0.4).toFixed(3);
      return `<div class="metro-beat accent-${accent} active" style="--pulse-scale:${pulseScale}; --pulse-opacity:${pulseOpacity}; --pulse-glow:${pulseGlow};"></div>`;
    })
    .join("");

  const beatInBar = beatIndex + 1;
  const label =
    countInRemaining !== null
      ? `Count-in ${countInRemaining} | ${sequenceSettings.bpm} BPM`
      : state.mode === "live" || state.mode === "practice"
        ? `${state.mode === "practice" ? "Practice" : "Live"} | beat ${beatInBar}/${beats.length} | ${sequenceSettings.bpm} BPM`
        : `${sequenceSettings.timeSignature} | beat ${beatInBar}/${beats.length} | ${sequenceSettings.bpm} BPM`;
  const countInHtml =
    countInRemaining !== null
      ? `<div class="metro-countdown" aria-label="Count-in ${countInRemaining}">${countInRemaining}</div>`
      : "";
  const labelHtml = state.mode === "practice" && countInRemaining === null
    ? ""
    : `<div class="metro-label">${label}</div>`;

  return `${countInHtml}<div class="metro-row">${pulseHtml}</div>${labelHtml}`;
}

function syncMetronomeAnimationLoop(): void {
  const shouldAnimate = enableVisualMetronome || enableMetronomeSound;
  if (shouldAnimate && metronomeRafId === null) {
    const tick = () => {
      metronomeRafId = null;
      const nowMs = performance.now();
      if (enableMetronomeSound) {
        maybePlayMetronomeTick(nowMs);
      }
      if (enableVisualMetronome) {
        scheduleRender();
      }
      if (enableVisualMetronome || enableMetronomeSound) {
        metronomeRafId = window.requestAnimationFrame(tick);
      }
    };
    metronomeRafId = window.requestAnimationFrame(tick);
    return;
  }

  if (!shouldAnimate && metronomeRafId !== null) {
    window.cancelAnimationFrame(metronomeRafId);
    metronomeRafId = null;
  }
}

function metronomePatternForMode(): Array<"strong" | "medium" | "weak"> {
  if (state.mode === "live" || state.mode === "practice") {
    return ["strong"];
  }
  return metronomeBeatPattern(sequenceSettings.timeSignature);
}

function metronomeBeatDurationMs(): number {
  if (state.mode === "live" || state.mode === "practice") {
    return 60_000 / sequenceSettings.bpm;
  }
  return beatDurationForTimeSignature(sequenceSettings.bpm, sequenceSettings.timeSignature);
}

function maybePlayMetronomeTick(nowMs: number): void {
  const beatDurationMs = metronomeBeatDurationMs();
  if (beatDurationMs <= 0) return;

  const tickIndex = Math.floor((nowMs - metronomeStartMs) / beatDurationMs);
  if (tickIndex < 0 || tickIndex === metronomeLastTickIndex) {
    return;
  }

  const pattern = metronomePatternForMode();
  const accent = pattern[tickIndex % pattern.length] ?? "weak";
  void playMetronomeClick(accent);
  metronomeLastTickIndex = tickIndex;
}

async function ensureSharedAudioContext(): Promise<AudioContext> {
  if (!metronomeAudioContext) {
    metronomeAudioContext = new AudioContext({ latencyHint: "interactive" });
  }
  if (metronomeAudioContext.state !== "running") {
    try {
      await metronomeAudioContext.resume();
    } catch {
      // Safari can leave a context in an unrecoverable/interrupted state
      // after microphone route transitions. Recreate it in that case.
      try {
        await metronomeAudioContext.close();
      } catch {
        // no-op
      }
      metronomeAudioContext = new AudioContext({ latencyHint: "interactive" });
      if (metronomeAudioContext.state !== "running") {
        await metronomeAudioContext.resume();
      }
    }
  }
  return metronomeAudioContext;
}

async function playMetronomeClick(accent: "strong" | "medium" | "weak"): Promise<void> {
  const ctx = await ensureSharedAudioContext();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = accent === "strong" ? 1480 : accent === "medium" ? 1180 : 980;

  osc.connect(gain);
  gain.connect(ctx.destination);

  const startAt = ctx.currentTime + 0.004;
  const peak = accent === "strong" ? 0.16 : accent === "medium" ? 0.12 : 0.09;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.05);

  osc.start(startAt);
  osc.stop(startAt + 0.055);
}

function resetMetronomeClock(): void {
  metronomeStartMs = performance.now();
  metronomeLastTickIndex = null;
}

async function onToggleListening(): Promise<void> {
  if (state.listening) {
    stopPracticePatternPlayback(false);
    pipeline?.stop();
    pipeline = null;

    if (micHandle) {
      stopMic(micHandle);
      micHandle = null;
    }

    state.listening = false;
    state.recording = false;
    lastFrame = null;
    lastTempoFrame = null;
    liveTracker.reset();
    const freshState = createInitialState();
    state.live = freshState.live;
    state.practice = {
      ...freshState.practice,
      targetBpm: sequenceSettings.bpm,
    };
    previousDisplayedSnapshot = null;
    trailNotes.length = 0;
    spectrogram?.reset();
    currentBeatBatch = null;
    fadingBeatBatches.length = 0;
    singleBeatWindow = null;
    singleBeatRoundIndex = 0;
    singleBeatIntervalCount = 0;
    singleBeatIntervalMs = 0;
    singleBeatBuckets = [];
    singleBeatBoundaryEvidence = [];
    singleBeatPrevFrame = null;
    if (singleBeatStopTimer !== null) {
      window.clearTimeout(singleBeatStopTimer);
      singleBeatStopTimer = null;
    }
    setAudioSessionType("playback");
    scheduleRender();
    return;
  }

  try {
    if (isLikelyIOS) {
      setAudioSessionType("play-and-record");
    } else {
      setAudioSessionType("auto");
    }

    const shouldUseSharedGraph = isLikelyIOS;
    const micProfile: "raw" | "voice-processed" = isLikelyIOS ? "voice-processed" : "raw";
    if (shouldUseSharedGraph) {
      const sharedAudioContext = await ensureSharedAudioContext();
      micHandle = await startMic(sharedAudioContext, micProfile);
    } else {
      micHandle = await startMic(undefined, micProfile);
    }

    pipeline = startPitchPipeline(
      micHandle,
      onPitchFrame,
      onSpectrumFrame,
      onTempoFrame,
      sequenceSettings.bpm,
    );
    syncStringPurityPipeline();
    syncPracticeSensitivityPipeline();
    syncPracticePeakPickingPipeline();
    syncPracticeTolerancePipeline();
    syncPracticeCorrectionSourcePipeline();
    if (enableMetronomeSound) {
      await ensureSharedAudioContext();
      resetMetronomeClock();
      syncMetronomeAnimationLoop();
    }
    state.listening = true;
  } catch (error) {
    console.error("Microphone start failed", error);
    alert("Microphone access failed. Please allow mic permissions and retry.");
  }

  scheduleRender();
}

function onModeChange(event: Event): void {
  const target = event.target as HTMLSelectElement;
  state.mode =
    target.value === "sequence"
      ? "sequence"
      : target.value === "sheet-entry"
        ? "sheet-entry"
        : target.value === "spectrum"
          ? "spectrum"
          : target.value === "practice"
            ? "practice"
            : "live";
  resetMetronomeClock();
  pipeline?.resetTempo();
  syncStringPurityPipeline();

  if (state.mode === "spectrum") {
    spectrogram?.reset();
  }

  if (state.mode !== "practice") {
    stopPracticePatternPlayback(false);
  }

  if (state.mode !== "sequence") {
    state.recording = false;
    currentBeatBatch = null;
    fadingBeatBatches.length = 0;
    singleBeatWindow = null;
    singleBeatRoundIndex = 0;
    singleBeatIntervalCount = 0;
    singleBeatIntervalMs = 0;
    singleBeatBuckets = [];
    singleBeatBoundaryEvidence = [];
    singleBeatPrevFrame = null;
    if (singleBeatStopTimer !== null) {
      window.clearTimeout(singleBeatStopTimer);
      singleBeatStopTimer = null;
    }
  }

  scheduleRender();
}

async function onToggleRecording(): Promise<void> {
  if (state.mode !== "sequence") return;

  if (!state.listening) {
    await onToggleListening();
    if (!state.listening) {
      return;
    }
  }

  if (sequenceSubMode === "single-beat") {
    if (state.recording) {
      stopSingleBeatDrillSession();
      if (state.listening) {
        await onToggleListening();
      }
    } else {
      startSingleBeatDrillSession();
    }
    scheduleRender();
    return;
  }

  state.recording = !state.recording;
  if (state.recording) {
    collector.reset();
    state.sequence = [];
  } else {
    const stopTime = lastFrame ? lastFrame.tMs : performance.now();
    const events = collector.stop(stopTime);
    state.sequence = events;
    if (state.listening) {
      await onToggleListening();
    }
  }

  scheduleRender();
}

function startSingleBeatDrillSession(): void {
  const startMs = performance.now();
  metronomeStartMs = startMs;
  metronomeLastTickIndex = null;
  state.recording = true;
  singleBeatRoundIndex = 0;
  singleBeatDebug = `session start @${Math.round(startMs)}ms`;
  console.log("[single-beat] session start", { startMs });
  startSingleBeatRound(singleBeatRoundIndex);
}

function startSingleBeatRound(roundIndex: number): void {
  if (!state.recording || sequenceSubMode !== "single-beat") return;
  const barMs = barDurationMs(sequenceSettings.bpm, sequenceSettings.timeSignature);
  const startMs = metronomeStartMs + roundIndex * barMs;
  const endMs = startMs + barMs;
  const beats = beatsPerBar(sequenceSettings.timeSignature);

  collector.reset();
  state.sequence = [];
  singleBeatWindow = { startMs, endMs };
  singleBeatIntervalCount = beats;
  singleBeatIntervalMs = barMs / beats;
  singleBeatBuckets = Array.from({ length: beats }, () => createIntervalBucket());
  singleBeatBoundaryEvidence = Array.from(
    { length: Math.max(0, beats - 1) },
    () => createBoundaryEvidence(),
  );
  singleBeatPrevFrame = null;
  singleBeatDebug = `round ${roundIndex + 1} start | beats=${beats} | interval=${Math.round(singleBeatIntervalMs)}ms`;
  console.log("[single-beat] round start", {
    roundIndex,
    startMs,
    endMs,
    beats,
    intervalMs: singleBeatIntervalMs,
  });

  const delayMs = Math.max(1, Math.round(endMs - performance.now()));
  if (singleBeatStopTimer !== null) {
    window.clearTimeout(singleBeatStopTimer);
  }
  singleBeatStopTimer = window.setTimeout(() => {
    void finalizeSingleBeatRound(roundIndex, endMs);
  }, delayMs);
}

function stopSingleBeatDrillSession(): void {
  console.log("[single-beat] session stop");
  singleBeatDebug = "session stopped";
  state.recording = false;
  collector.reset();
  singleBeatWindow = null;
  singleBeatRoundIndex = 0;
  singleBeatIntervalCount = 0;
  singleBeatIntervalMs = 0;
  singleBeatBuckets = [];
  singleBeatBoundaryEvidence = [];
  singleBeatPrevFrame = null;
  if (singleBeatStopTimer !== null) {
    window.clearTimeout(singleBeatStopTimer);
    singleBeatStopTimer = null;
  }
}

async function finalizeSingleBeatRound(roundIndex: number, stopMs: number): Promise<void> {
  if (!state.recording || sequenceSubMode !== "single-beat" || roundIndex !== singleBeatRoundIndex) {
    return;
  }

  if (singleBeatStopTimer !== null) {
    window.clearTimeout(singleBeatStopTimer);
    singleBeatStopTimer = null;
  }

  if (singleBeatWindow) {
    const bucketSummary = singleBeatBuckets.map((bucket) => ({
      frameCount: bucket.frameCount,
      silenceCount: bucket.silenceCount,
      noteCounts: Object.fromEntries(bucket.noteCounts.entries()),
      edgeStartFrameCount: bucket.edgeStartFrameCount,
      edgeEndFrameCount: bucket.edgeEndFrameCount,
    }));
    console.log("[single-beat] round finalize", {
      roundIndex,
      startMs: singleBeatWindow.startMs,
      endMs: singleBeatWindow.endMs,
      bucketSummary,
      boundaryEvidence: singleBeatBoundaryEvidence,
    });
    addSingleBeatAttempt(singleBeatWindow.startMs, singleBeatWindow.endMs);
  }
  singleBeatWindow = null;
  singleBeatIntervalCount = 0;
  singleBeatIntervalMs = 0;
  singleBeatBuckets = [];
  singleBeatBoundaryEvidence = [];
  singleBeatPrevFrame = null;
  singleBeatRoundIndex += 1;

  if (state.recording && sequenceSubMode === "single-beat") {
    startSingleBeatRound(singleBeatRoundIndex);
  }
  scheduleRender();
}

function onPitchFrame(frame: PitchFrame): void {
  lastFrame = frame;
  state.live = liveTracker.update(frame);

  if (state.recording && state.mode === "sequence") {
    if (sequenceSubMode === "single-beat") {
      captureSingleBeatFrame(frame);
    } else {
      collector.addFrame(frame);
      state.sequence = collector.snapshot(frame.tMs);
    }
  }

  capturePracticePatternFrame(frame);

  scheduleRender();
}

function onSpectrumFrame(frame: SpectrumFrame): void {
  if (state.mode !== "spectrum") {
    return;
  }
  spectrogram?.push(frame);
}

function onTempoFrame(frame: TempoFrame): void {
  lastTempoFrame = frame;
  state.practice = {
    targetBpm: frame.targetBpm,
    estimatedBpm: frame.estimatedBpm,
    differenceBpm: frame.differenceBpm,
    confidence: frame.confidence,
    status: frame.status,
    novelty: frame.novelty,
    debug: frame.debug,
  };

  if (state.mode === "practice") {
    capturePracticePatternTempoFrame(frame);
    scheduleRender();
  }
}

function captureSingleBeatFrame(frame: PitchFrame): void {
  if (!singleBeatWindow || singleBeatIntervalCount <= 0 || singleBeatIntervalMs <= 0) {
    return;
  }
  if (frame.tMs < singleBeatWindow.startMs || frame.tMs > singleBeatWindow.endMs) {
    return;
  }

  const offsetMs = frame.tMs - singleBeatWindow.startMs;
  const rawIndex = Math.floor(offsetMs / singleBeatIntervalMs);
  const index = Math.max(0, Math.min(singleBeatIntervalCount - 1, rawIndex));

  const intervalMidi = state.live.detectedMidi ?? (frame.confidence >= 0.25 ? frame.midi : null);
  const bucket = singleBeatBuckets[index];
  if (!bucket) {
    singleBeatPrevFrame = null;
    return;
  }

  bucket.frameCount += 1;
  if (intervalMidi === null) {
    bucket.silenceCount += 1;
  } else {
    bucket.noteCounts.set(intervalMidi, (bucket.noteCounts.get(intervalMidi) ?? 0) + 1);
  }

  const intervalStartOffset = index * singleBeatIntervalMs;
  const offsetInInterval = offsetMs - intervalStartOffset;
  const edgeWindowMs = Math.max(55, Math.min(140, singleBeatIntervalMs * 0.24));

  if (offsetInInterval <= edgeWindowMs) {
    bucket.edgeStartFrameCount += 1;
    if (intervalMidi === null) {
      bucket.edgeStartSilenceCount += 1;
    } else {
      bucket.edgeStartNoteCounts.set(
        intervalMidi,
        (bucket.edgeStartNoteCounts.get(intervalMidi) ?? 0) + 1,
      );
    }
  }

  if (singleBeatIntervalMs - offsetInInterval <= edgeWindowMs) {
    bucket.edgeEndFrameCount += 1;
    if (intervalMidi === null) {
      bucket.edgeEndSilenceCount += 1;
    } else {
      bucket.edgeEndNoteCounts.set(
        intervalMidi,
        (bucket.edgeEndNoteCounts.get(intervalMidi) ?? 0) + 1,
      );
    }
  }

  if (singleBeatPrevFrame && singleBeatPrevFrame.intervalIndex !== index) {
    const leftIndex = Math.min(singleBeatPrevFrame.intervalIndex, index);
    const rightIndex = Math.max(singleBeatPrevFrame.intervalIndex, index);

    for (let boundary = leftIndex; boundary < rightIndex; boundary += 1) {
      const evidence = singleBeatBoundaryEvidence[boundary];
      if (!evidence) continue;
      evidence.transitions += 1;

      const prevMidi = singleBeatPrevFrame.midi;
      const currMidi = intervalMidi;
      if (prevMidi === null || currMidi === null) {
        evidence.silenceTransitions += 1;
        if (prevMidi === null && currMidi !== null) {
          evidence.silenceToNoteTransitions += 1;
        }
      } else if (prevMidi === currMidi) {
        evidence.sameMidiTransitions += 1;
      } else {
        evidence.pitchChangeTransitions += 1;
      }
    }
  }

  singleBeatPrevFrame = { intervalIndex: index, midi: intervalMidi };
}

function addSingleBeatAttempt(
  beatStartMs: number,
  beatEndMs: number,
): void {
  const targetMs = beatEndMs - beatStartMs;
  const intervalValue = beatValueFromTimeSignature(sequenceSettings.timeSignature);
  const fallbackIntervals = beatsPerBar(sequenceSettings.timeSignature);
  const intervals =
    singleBeatIntervalCount > 0 ? singleBeatIntervalCount : fallbackIntervals;
  const beatSymbols: BeatSymbol[][] = Array.from({ length: intervals }, () => []);
  const intervalDecisions = Array.from({ length: intervals }, (_, beat) =>
    classifyIntervalBucket(singleBeatBuckets[beat], intervalValue, singleBeatIntervalMs),
  );
  const symbols = mergeIntervalsToSymbols(
    intervalDecisions,
    singleBeatBoundaryEvidence,
    intervalValue,
    singleBeatIntervalMs,
    beatSymbols,
  );
  const sequenceEvents: Array<{ startMs: number; endMs: number; midi: number; confidenceAvg: number }> = [];
  let elapsedMs = 0;
  for (const symbol of symbols) {
    if (symbol.kind === "note" && symbol.midi !== null) {
      sequenceEvents.push({
        startMs: beatStartMs + elapsedMs,
        endMs: beatStartMs + elapsedMs + symbol.durationMs,
        midi: symbol.midi,
        confidenceAvg: 1,
      });
    }
    elapsedMs += symbol.durationMs;
  }
  state.sequence = sequenceEvents;

  const playedMs = symbols
    .filter((s) => s.kind === "note")
    .reduce((sum, s) => sum + s.durationMs, 0);
  const hasPlayedNote = symbols.some((s) => s.kind === "note");
  const errorMs = playedMs - targetMs;
  const status = classifyBeat(errorMs, beatToleranceMs);

  const batch: BeatBatch = {
    id: beatAttemptId,
    beats: beatSymbols,
    performedMs: playedMs,
    targetMs,
    errorMs,
    status,
  };

  if (hasPlayedNote) {
    if (currentBeatBatch && enableFadeTrail) {
      fadingBeatBatches.push({
        batch: currentBeatBatch,
        startedAtMs: performance.now(),
      });
    }
    currentBeatBatch = batch;
  } else if (!currentBeatBatch) {
    // No musical batch yet; show rests baseline.
    currentBeatBatch = batch;
  }
  singleBeatDebug =
    `round ${singleBeatRoundIndex + 1} done | intervals=${intervals} | mergedSymbols=${symbols.length} | played=${Math.round(playedMs)}ms/${Math.round(targetMs)}ms | hasNote=${hasPlayedNote}`;
  console.log("[single-beat] batch built", {
    round: singleBeatRoundIndex + 1,
    intervals,
    symbols,
    playedMs,
    targetMs,
    hasPlayedNote,
    batch,
  });

  beatAttempts.unshift({
    id: beatAttemptId,
    symbols,
    performedMs: playedMs,
    targetMs,
    errorMs,
    status,
  });
  beatAttemptId += 1;
  trimBeatHistory();
}

function createIntervalBucket(): IntervalBucket {
  return {
    noteCounts: new Map<number, number>(),
    silenceCount: 0,
    frameCount: 0,
    edgeStartNoteCounts: new Map<number, number>(),
    edgeStartSilenceCount: 0,
    edgeStartFrameCount: 0,
    edgeEndNoteCounts: new Map<number, number>(),
    edgeEndSilenceCount: 0,
    edgeEndFrameCount: 0,
  };
}

function createBoundaryEvidence(): BoundaryEvidence {
  return {
    transitions: 0,
    sameMidiTransitions: 0,
    pitchChangeTransitions: 0,
    silenceTransitions: 0,
    silenceToNoteTransitions: 0,
  };
}

function classifyIntervalBucket(
  bucket: IntervalBucket | undefined,
  intervalValue: BeatValue,
  intervalDurationMs: number,
): {
  symbol: BeatSymbol;
  dominantRatio: number;
  edgeStartMidiRatio: number;
  edgeEndMidiRatio: number;
  edgeStartSilenceRatio: number;
  edgeEndSilenceRatio: number;
} {
  if (!bucket || bucket.frameCount === 0) {
    return {
      symbol: {
        kind: "rest",
        midi: null,
        value: intervalValue,
        durationMs: intervalDurationMs,
        spanBeats: 1,
      },
      dominantRatio: 0,
      edgeStartMidiRatio: 0,
      edgeEndMidiRatio: 0,
      edgeStartSilenceRatio: 1,
      edgeEndSilenceRatio: 1,
    };
  }

  const { midi, count } = dominantMidiCount(bucket.noteCounts);
  const dominantRatio = count / Math.max(1, bucket.frameCount);
  const minFramesForNote = Math.max(1, Math.floor(bucket.frameCount * 0.12));
  const isRest = midi === null || count < minFramesForNote;
  const startMidiCount = midi === null ? 0 : bucket.edgeStartNoteCounts.get(midi) ?? 0;
  const endMidiCount = midi === null ? 0 : bucket.edgeEndNoteCounts.get(midi) ?? 0;

  return {
    symbol: {
      kind: isRest ? "rest" : "note",
      midi: isRest ? null : midi,
      value: intervalValue,
      durationMs: intervalDurationMs,
      spanBeats: 1,
    },
    dominantRatio,
    edgeStartMidiRatio: startMidiCount / Math.max(1, bucket.edgeStartFrameCount),
    edgeEndMidiRatio: endMidiCount / Math.max(1, bucket.edgeEndFrameCount),
    edgeStartSilenceRatio: bucket.edgeStartSilenceCount / Math.max(1, bucket.edgeStartFrameCount),
    edgeEndSilenceRatio: bucket.edgeEndSilenceCount / Math.max(1, bucket.edgeEndFrameCount),
  };
}

function mergeIntervalsToSymbols(
  intervals: Array<ReturnType<typeof classifyIntervalBucket>>,
  boundaries: BoundaryEvidence[],
  baseValue: BeatValue,
  intervalDurationMs: number,
  beatSlots: BeatSymbol[][],
): BeatSymbol[] {
  const merged: BeatSymbol[] = [];
  if (intervals.length === 0) return merged;

  let start = 0;
  while (start < intervals.length) {
    const startSymbol = intervals[start].symbol;
    let end = start + 1;

    while (end < intervals.length) {
      const left = intervals[end - 1];
      const right = intervals[end];
      const boundary = boundaries[end - 1];
      if (!shouldMergeAcrossBoundary(left, right, boundary)) {
        break;
      }
      end += 1;
    }

    appendRunSymbols(
      start,
      end - start,
      startSymbol.kind,
      startSymbol.midi,
      baseValue,
      intervalDurationMs,
      beatSlots,
      merged,
    );

    start = end;
  }

  return merged;
}

function shouldMergeAcrossBoundary(
  left: ReturnType<typeof classifyIntervalBucket>,
  right: ReturnType<typeof classifyIntervalBucket>,
  boundary: BoundaryEvidence | undefined,
): boolean {
  if (left.symbol.kind !== right.symbol.kind) return false;

  if (left.symbol.kind === "rest" && right.symbol.kind === "rest") {
    return true;
  }

  if (left.symbol.midi === null || right.symbol.midi === null) return false;
  if (left.symbol.midi !== right.symbol.midi) return false;

  let score = 0;
  if (boundary && boundary.transitions > 0) {
    const transitions = boundary.transitions;
    const sameRatio = boundary.sameMidiTransitions / transitions;
    const pitchRatio = boundary.pitchChangeTransitions / transitions;
    const silenceRatio = boundary.silenceTransitions / transitions;
    const onsetRatio = boundary.silenceToNoteTransitions / transitions;

    score += sameRatio * 2.2;
    score -= pitchRatio * 2.8;
    score -= silenceRatio * 2.2;
    score -= onsetRatio * 1.8;
  }

  const edgeContinuity = Math.min(left.edgeEndMidiRatio, right.edgeStartMidiRatio);
  const edgeSilence = Math.max(left.edgeEndSilenceRatio, right.edgeStartSilenceRatio);
  const stability = Math.min(left.dominantRatio, right.dominantRatio);

  score += edgeContinuity * 2.0;
  score -= edgeSilence * 2.5;
  score += (stability - 0.5) * 1.6;

  return score >= 0.75;
}

function appendRunSymbols(
  runStart: number,
  runLengthBeats: number,
  kind: "note" | "rest",
  midi: number | null,
  baseValue: BeatValue,
  intervalDurationMs: number,
  beatSlots: BeatSymbol[][],
  output: BeatSymbol[],
): void {
  const baseWeight = beatValueWeight(baseValue);
  let cursorBeat = runStart;
  let remainingWeight = runLengthBeats * baseWeight;

  for (const partWeight of decomposeWeight(remainingWeight)) {
    const spanBeats = Math.max(1, Math.round(partWeight / baseWeight));
    const symbol: BeatSymbol = {
      kind,
      midi: kind === "rest" ? null : midi,
      value: weightToBeatValue(partWeight),
      durationMs: spanBeats * intervalDurationMs,
      spanBeats,
    };
    if (cursorBeat < beatSlots.length) {
      beatSlots[cursorBeat].push(symbol);
    }
    output.push(symbol);
    cursorBeat += spanBeats;
    remainingWeight -= partWeight;
    if (remainingWeight <= 0) {
      break;
    }
  }
}

function beatValueWeight(value: BeatValue): number {
  if (value === "whole") return 8;
  if (value === "half") return 4;
  if (value === "quarter") return 2;
  return 1;
}

function weightToBeatValue(weight: number): BeatValue {
  if (weight >= 8) return "whole";
  if (weight >= 4) return "half";
  if (weight >= 2) return "quarter";
  return "eighth";
}

function decomposeWeight(totalWeight: number): number[] {
  let remaining = totalWeight;
  const parts: number[] = [];
  while (remaining >= 8) {
    parts.push(8);
    remaining -= 8;
  }
  while (remaining >= 4) {
    parts.push(4);
    remaining -= 4;
  }
  while (remaining >= 2) {
    parts.push(2);
    remaining -= 2;
  }
  while (remaining >= 1) {
    parts.push(1);
    remaining -= 1;
  }
  return parts;
}

function renderBeatDrillSummary(): string {
  if (beatAttempts.length === 0) {
    return "No attempts yet. Start Single Beat Drill; one full bar is captured and split into notes/rests by beat.";
  }

  return beatAttempts
    .map((attempt, index) => {
      const target = Math.round(attempt.targetMs);
      const played = Math.round(attempt.performedMs);
      const symbolsText = attempt.symbols.map(formatBeatSymbol).join(" + ");
      return `${index + 1}. ${symbolsText} | played ${played} ms vs bar ${target} ms | ${attempt.status} (${formatSigned(attempt.errorMs)} ms)`;
    })
    .join("\n");
}

function renderBeatBatchVisualization(): string {
  const currentHtml = currentBeatBatch
    ? renderBeatBatchCard(currentBeatBatch, "beat-batch current", "")
    : `<div class="beat-batch empty">No bar captured yet.</div>`;

  return `<div class="beat-batch-track">${currentHtml}</div>`;
}

function renderBeatBatchCard(batch: BeatBatch, className: string, style: string): string {
  const sourceBeats =
    batch.beats.length > 0
      ? batch.beats
      : Array.from({ length: beatsPerBar(sequenceSettings.timeSignature) }, () => [
          {
            kind: "rest",
            midi: null,
            value: beatValueFromTimeSignature(sequenceSettings.timeSignature),
            durationMs: 0,
            spanBeats: 1,
          } as BeatSymbol,
        ]);

  const beatCells = sourceBeats
    .map((symbols, index) => {
      const text = symbols.length > 0 ? symbols.map(formatBeatSymbolShort).join(" + ") : "·";
      return `<div class="beat-cell"><span class="beat-index">${index + 1}</span><span class="beat-text">${text}</span></div>`;
    })
    .join("");
  return `<div class="${className}" style="--beat-cols:${Math.max(1, sourceBeats.length)}; ${style}">${beatCells}</div>`;
}

function renderStaffPracticePattern(nowMs: number): string {
  const activeIndex = practicePatternCurrentIndex(nowMs);
  const pattern = selectedPracticePattern();
  practicePatternActiveIndex = activeIndex;

  const rowCount = Math.max(1, Math.ceil(pattern.notes.length / PRACTICE_PATTERN_NOTES_PER_ROW));
  const rows = Array.from({ length: rowCount }, (_, rowIndex) => {
    const startIndex = rowIndex * PRACTICE_PATTERN_NOTES_PER_ROW;
    const notes = pattern.notes.slice(startIndex, startIndex + PRACTICE_PATTERN_NOTES_PER_ROW);
    const slots = notes.map((note, localIndex) => {
      const index = startIndex + localIndex;
      const result = practicePatternResults[index] ?? { status: "pending", playedMidi: null };
      const y = midiToStaffY(note.midi);
      const ledgers = ledgerLineYs(note.midi)
        .map((lineY) => `<div class="practice-pattern-ledger-line" style="top:${lineY.toFixed(1)}px"></div>`)
        .join("");
      const stemDirection = stemDirectionForMidi(note.midi);
      const statusClass = `status-${result.status}`;
      const activeClass = activeIndex === index ? "active active-slot" : "";
      const overlayMidi = result.status === "wrong" ? result.playedMidi : result.bleedMidi;
      const playedNoteHtml =
        overlayMidi !== null
          ? renderPracticePlayedNote(overlayMidi)
          : "";
      const playedLabel =
        overlayMidi === null
          ? "&nbsp;"
          : `${midiToSolfege(overlayMidi)} ${midiToScientific(overlayMidi)}`;

      return `
        <div class="practice-pattern-slot ${activeClass}" data-row-index="${rowIndex}">
          ${ledgers}
          <div class="staff-batch-note value-quarter practice-pattern-note ${statusClass} ${activeIndex === index ? "active" : ""} ${stemDirection === "up" ? "stem-up" : "stem-down"}" style="top:${y.toFixed(1)}px;" title="${note.label} ${midiToScientific(note.midi)}">
            <div class="staff-batch-note-head"></div>
            <div class="staff-batch-note-stem"></div>
          </div>
          ${playedNoteHtml}
          <div class="practice-pattern-target">${note.label}</div>
          <div class="practice-pattern-played ${statusClass}">${playedLabel}</div>
        </div>
      `;
    }).join("");

    const placeholders = Array.from(
      { length: PRACTICE_PATTERN_NOTES_PER_ROW - notes.length },
      () => `<div class="practice-pattern-slot placeholder"></div>`,
    ).join("");

    return `
      <div class="practice-sheet-row" data-row-index="${rowIndex}">
        <div class="practice-sheet-lines">
          <div class="staff-line l1"></div>
          <div class="staff-line l2"></div>
          <div class="staff-line l3"></div>
          <div class="staff-line l4"></div>
          <div class="staff-line l5"></div>
        </div>
        <div class="practice-pattern-grid" style="--pattern-cols:${PRACTICE_PATTERN_NOTES_PER_ROW}">
          ${slots}${placeholders}
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="practice-sheet" style="--practice-row-count:${rowCount}">
      ${rows}
    </div>
  `;
}

function scrollPracticeSheetToActiveRow(): void {
  if (!ui || state.mode !== "practice") {
    return;
  }
  const activeSlot = ui.staff.querySelector<HTMLElement>(".practice-pattern-slot.active-slot");
  if (!activeSlot) {
    practicePatternLastScrolledRow = -1;
    return;
  }
  const rowIndex = parseInt(activeSlot.dataset.rowIndex ?? "-1", 10);
  if (!Number.isFinite(rowIndex) || rowIndex === practicePatternLastScrolledRow) {
    return;
  }
  practicePatternLastScrolledRow = rowIndex;
  const row = ui.staff.querySelector<HTMLElement>(`.practice-sheet-row[data-row-index="${rowIndex}"]`);
  if (!row) {
    return;
  }
  ui.staff.scrollTo({
    top: Math.max(0, row.offsetTop - 12),
    behavior: "smooth",
  });
}

function renderPracticePlayedNote(midi: number): string {
  const y = midiToStaffY(midi);
  const stemDirection = stemDirectionForMidi(midi);

  return `
    <div class="staff-batch-note value-quarter practice-pattern-played-note ${stemDirection === "up" ? "stem-up" : "stem-down"}" style="top:${y.toFixed(1)}px;" title="Played ${midiToScientific(midi)}">
      <div class="staff-batch-note-head"></div>
      <div class="staff-batch-note-stem"></div>
    </div>
  `;
}

function renderStaffSheetEntry(): string {
  resizeSheetEntrySlots(sheetEntrySlotCount);

  const slots = sheetEntrySlots.map((slot, index) => {
    if (!slot) {
      return `
        <div class="sheet-entry-slot empty">
          <div class="sheet-entry-slot-label">${index + 1}</div>
        </div>
      `;
    }

    const y = midiToStaffY(slot.naturalMidi);
    const stemDirection = stemDirectionForMidi(slot.naturalMidi);
    const ledgers = ledgerLineYs(slot.naturalMidi)
      .map((lineY) => `<div class="staff-batch-ledger-line" style="top:${lineY.toFixed(1)}px"></div>`)
      .join("");
    const accidental = accidentalSymbol(slot.accidental);
    const label = formatSheetEntrySlot(slot);

    return `
      <div class="sheet-entry-slot">
        ${ledgers}
        <div class="staff-batch-note value-quarter sheet-entry-note ${stemDirection === "up" ? "stem-up" : "stem-down"}" style="top:${y.toFixed(1)}px;" title="${label}">
          ${accidental ? `<div class="sheet-entry-accidental">${accidental}</div>` : ""}
          <div class="staff-batch-note-head"></div>
          <div class="staff-batch-note-stem"></div>
        </div>
        <div class="sheet-entry-slot-label">${index + 1}</div>
        <div class="sheet-entry-note-label">${label}</div>
      </div>
    `;
  }).join("");

  return `
    <div class="sheet-entry-grid" style="--sheet-cols:${Math.max(1, sheetEntrySlotCount)}">
      ${slots}
    </div>
  `;
}

function renderSheetEntrySummary(): string {
  const slotNames = sheetEntrySlots.map((slot) => (slot ? formatSheetEntrySlot(slot) : "rest"));
  const noteNames = sheetEntrySlots
    .filter((slot): slot is SheetEntrySlot => slot !== null)
    .map(formatSheetEntrySlot);

  if (noteNames.length === 0) {
    return "No notes entered yet.";
  }

  const indexed = sheetEntrySlots
    .map((slot, index) => `${index + 1}. ${slot ? formatSheetEntrySlot(slot) : "rest"}`)
    .join("\n");

  return [
    `Timing: ${sheetEntryBars} bar${sheetEntryBars === 1 ? "" : "s"} of ${sheetEntryTimeSignature}, ${sheetEntrySlotValue}-note slots`,
    "",
    "Fixed-slot sequence:",
    slotNames.join(" "),
    "",
    "Notes only:",
    noteNames.join(" "),
    "",
    "Indexed slots:",
    indexed,
  ].join("\n");
}

function handleStaffSheetEntryClick(event: MouseEvent): void {
  if (!ui || state.mode !== "sheet-entry") {
    return;
  }

  const rect = ui.staff.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  const x = clamp(event.clientX - rect.left, 0, rect.width - 0.001);
  const slotIndex = clamp(Math.floor((x / rect.width) * sheetEntrySlotCount), 0, sheetEntrySlotCount - 1);
  if (sheetEntryTool === "rest") {
    sheetEntrySlots[slotIndex] = null;
    scheduleRender();
    return;
  }

  const y = clamp(event.clientY - rect.top, 0, rect.height);
  const naturalMidi = staffYToNearestNaturalMidi(y);
  const midi = naturalMidi + accidentalOffset(sheetEntryTool);
  sheetEntrySlots[slotIndex] = {
    naturalMidi,
    accidental: sheetEntryTool,
    midi: clamp(midi, 0, 127),
  };
  scheduleRender();
}

function resizeSheetEntrySlots(nextCount: number): void {
  const normalizedCount = clamp(Math.round(nextCount), 1, 64);
  if (sheetEntrySlots.length === normalizedCount) {
    return;
  }
  const nextSlots = createEmptySheetSlots(normalizedCount);
  for (let i = 0; i < Math.min(sheetEntrySlots.length, normalizedCount); i += 1) {
    nextSlots[i] = sheetEntrySlots[i];
  }
  sheetEntrySlots = nextSlots;
  sheetEntrySlotCount = normalizedCount;
}

function createEmptySheetSlots(count: number): Array<SheetEntrySlot | null> {
  return Array.from({ length: clamp(Math.round(count), 1, 64) }, () => null);
}

function defaultSheetSlotCount(
  timeSignature: typeof sequenceSettings.timeSignature,
  slotValue: SheetEntrySlotValue,
  bars: number,
): number {
  return clamp(sheetEntrySlotsPerBar(timeSignature, slotValue) * bars, 1, 64);
}

function syncSheetEntryTiming(): void {
  sheetEntrySlotCount = defaultSheetSlotCount(
    sheetEntryTimeSignature,
    sheetEntrySlotValue,
    sheetEntryBars,
  );
  resizeSheetEntrySlots(sheetEntrySlotCount);
}

function sheetEntrySlotsPerBar(
  timeSignature: typeof sequenceSettings.timeSignature,
  slotValue: SheetEntrySlotValue,
): number {
  const [numeratorText, denominatorText] = timeSignature.split("/");
  const numerator = parseInt(numeratorText ?? "4", 10);
  const denominator = parseInt(denominatorText ?? "4", 10);
  const beats = Number.isFinite(numerator) && numerator > 0 ? numerator : 4;
  const beatWeight = 16 / (Number.isFinite(denominator) && denominator > 0 ? denominator : 4);
  const barWeight = beats * beatWeight;
  return Math.max(1, Math.round(barWeight / sheetEntrySlotWeight(slotValue)));
}

function sheetEntrySlotWeight(slotValue: SheetEntrySlotValue): number {
  if (slotValue === "quarter") return 4;
  if (slotValue === "sixteenth") return 1;
  return 2;
}

function asSheetEntryTool(value: string): SheetEntryTool {
  if (value === "sharp" || value === "flat" || value === "rest") {
    return value;
  }
  return "natural";
}

function asSheetEntrySlotValue(value: string): SheetEntrySlotValue {
  if (value === "quarter" || value === "sixteenth") {
    return value;
  }
  return "eighth";
}

function accidentalOffset(accidental: SheetEntryAccidental): number {
  if (accidental === "sharp") return 1;
  if (accidental === "flat") return -1;
  return 0;
}

function accidentalSymbol(accidental: SheetEntryAccidental): string {
  if (accidental === "sharp") return "#";
  if (accidental === "flat") return "b";
  return "";
}

function formatSheetEntrySlot(slot: SheetEntrySlot): string {
  const base = naturalMidiNameParts(slot.naturalMidi);
  return `${base.letter}${accidentalSymbol(slot.accidental)}${base.octave}`;
}

function staffYToNearestNaturalMidi(y: number): number {
  const bottomLineY = 160;
  const halfLineGap = 13;
  const e4Step = 30;
  const step = e4Step + Math.round((bottomLineY - y) / halfLineGap);
  return diatonicStepToNaturalMidi(step);
}

function diatonicStepToNaturalMidi(step: number): number {
  const octave = Math.floor(step / 7);
  const letterStep = ((step % 7) + 7) % 7;
  const pitchClass = [0, 2, 4, 5, 7, 9, 11][letterStep] ?? 0;
  return (octave + 1) * 12 + pitchClass;
}

function naturalMidiNameParts(midi: number): { letter: string; octave: number } {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const letterByPitchClass: Record<number, string> = {
    0: "C",
    2: "D",
    4: "E",
    5: "F",
    7: "G",
    9: "A",
    11: "B",
  };
  return {
    letter: letterByPitchClass[pitchClass] ?? "C",
    octave,
  };
}

function renderStaffBeatBatch(nowMs: number): string {
  const batch = currentBeatBatch;
  const beatCount = beatsPerBar(sequenceSettings.timeSignature);
  const alive: Array<{ batch: BeatBatch; startedAtMs: number }> = [];
  let fadingHtml = "";

  for (const fading of fadingBeatBatches) {
    const ageMs = nowMs - fading.startedAtMs;
    if (ageMs >= BATCH_FADE_MS) {
      continue;
    }
    const progress = ageMs / BATCH_FADE_MS;
    const opacity = 1 - progress;
    const shiftPct = -55 * progress;
    alive.push(fading);
    fadingHtml += renderStaffBeatBatchGrid(
      fading.batch.beats,
      `staff-batch-grid fading`,
      `opacity:${opacity.toFixed(3)}; transform:translateX(${shiftPct.toFixed(2)}%);`,
    );
  }

  fadingBeatBatches.length = 0;
  fadingBeatBatches.push(...alive);

  if (!batch) {
    const fallbackBeats = Array.from({ length: beatCount }, () => [
      {
        kind: "rest" as const,
        midi: null,
        value: beatValueFromTimeSignature(sequenceSettings.timeSignature),
        durationMs: 0,
        spanBeats: 1,
      },
    ]);
    return `<div class="staff-batch-track">${fadingHtml}${renderStaffBeatBatchGrid(
      fallbackBeats,
      "staff-batch-grid current",
      "",
    )}</div>`;
  }

  const slots = batch.beats.length > 0 ? batch.beats : Array.from({ length: beatCount }, () => []);
  return `<div class="staff-batch-track">${fadingHtml}${renderStaffBeatBatchGrid(
    slots,
    "staff-batch-grid current",
    "",
  )}</div>`;
}

function renderStaffBeatBatchGrid(
  slots: BeatSymbol[][],
  className: string,
  style: string,
): string {
  const html = slots
    .map((symbols) => {
      const symbol = symbols[0] ?? null;
      if (!symbol) {
        return `<div class="staff-beat-slot continuation"></div>`;
      }

      const span = Math.max(1, symbol.spanBeats || 1);
      const spanStyle = span > 1 ? `grid-column: span ${span};` : "";
      if (symbol.kind === "rest" || symbol.midi === null) {
        const rest = restSymbolForValue(
          symbol?.value ?? beatValueFromTimeSignature(sequenceSettings.timeSignature),
        );
        return `<div class="staff-beat-slot" style="${spanStyle}"><div class="staff-rest-token">${rest}</div></div>`;
      }

      const y = midiToStaffY(symbol.midi);
      const stemDirection = stemDirectionForMidi(symbol.midi);
      const ledgers = ledgerLineYs(symbol.midi)
        .map((lineY) => `<div class="staff-batch-ledger-line" style="top:${lineY.toFixed(1)}px"></div>`)
        .join("");
      const noteValueClass = `value-${symbol.value}`;
      const showStem = symbol.value !== "whole";
      const showFlag = symbol.value === "eighth";
      const stemHtml = showStem ? `<div class="staff-batch-note-stem"></div>` : "";
      const flagHtml = showFlag ? `<div class="staff-batch-note-flag"></div>` : "";
      return `
        <div class="staff-beat-slot" style="${spanStyle}">
          ${ledgers}
          <div class="staff-batch-note ${noteValueClass} ${stemDirection === "up" ? "stem-up" : "stem-down"}" style="top:${y.toFixed(1)}px;">
            <div class="staff-batch-note-head"></div>
            ${stemHtml}
            ${flagHtml}
          </div>
        </div>
      `;
    })
    .join("");

  return `<div class="${className}" style="--beat-cols:${Math.max(1, slots.length)}; ${style}">${html}</div>`;
}

function quantizeBeatIntoSlots(
  events: { startMs: number; endMs: number; midi: number }[],
  beatStartMs: number,
  beatEndMs: number,
  slotCount: number,
): Array<number | null> {
  const slotDurationMs = (beatEndMs - beatStartMs) / slotCount;
  const slots: Array<number | null> = [];

  for (let i = 0; i < slotCount; i += 1) {
    const slotStart = beatStartMs + i * slotDurationMs;
    const slotEnd = slotStart + slotDurationMs;

    let bestMidi: number | null = null;
    let bestOverlap = 0;

    for (const event of events) {
      const overlap = overlapMs(slotStart, slotEnd, event.startMs, event.endMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMidi = event.midi;
      }
    }

    slots.push(bestOverlap >= slotDurationMs * 0.4 ? bestMidi : null);
  }

  return slots;
}

function compressSlotsToSymbols(slots: Array<number | null>, slotDurationMs: number): BeatSymbol[] {
  const symbols: BeatSymbol[] = [];
  if (slots.length === 0) return symbols;

  let current = slots[0];
  let count = 1;
  for (let i = 1; i <= slots.length; i += 1) {
    const next = i < slots.length ? slots[i] : Symbol("end");
    if (next === current) {
      count += 1;
      continue;
    }

    for (const chunk of decomposeSlotRun(count)) {
      symbols.push({
        kind: current === null ? "rest" : "note",
        midi: current,
        value: slotsCountToBeatValue(chunk),
        durationMs: chunk * slotDurationMs,
        spanBeats: chunk,
      });
    }

    current = i < slots.length ? slots[i] : null;
    count = 1;
  }

  return symbols;
}

function decomposeSlotRun(slotCount: number): number[] {
  let remaining = slotCount;
  const parts: number[] = [];
  while (remaining >= 4) {
    parts.push(4);
    remaining -= 4;
  }
  while (remaining >= 2) {
    parts.push(2);
    remaining -= 2;
  }
  while (remaining >= 1) {
    parts.push(1);
    remaining -= 1;
  }
  return parts;
}

function slotsCountToBeatValue(slotCount: number): BeatValue {
  if (slotCount >= 4) return "half";
  if (slotCount >= 2) return "quarter";
  return "eighth";
}

function slotsPerBeatForTimeSignature(
  timeSignature: typeof sequenceSettings.timeSignature,
): number {
  const denominator = parseInt(timeSignature.split("/")[1] ?? "4", 10);
  if (denominator === 2) return 4;
  if (denominator === 4) return 2;
  return 1;
}

function formatBeatSymbol(symbol: BeatSymbol): string {
  const valueName = symbol.value;
  if (symbol.kind === "rest") {
    return `${valueName} rest ${restSymbolForValue(symbol.value)}`;
  }
  if (symbol.midi === null) {
    return `${valueName} note`;
  }
  return `${valueName} ${midiToSolfege(symbol.midi)} (${midiToScientific(symbol.midi)}) ${noteSymbolForValue(symbol.value)}`;
}

function formatBeatSymbolShort(symbol: BeatSymbol): string {
  const value =
    symbol.value === "whole"
      ? "1"
      : symbol.value === "half"
        ? "1/2"
        : symbol.value === "quarter"
          ? "1/4"
          : "1/8";
  if (symbol.kind === "rest" || symbol.midi === null) {
    return `${value} ${restSymbolForValue(symbol.value)}`;
  }
  return `${value} ${noteSymbolForValue(symbol.value)} ${midiToSolfege(symbol.midi)}`;
}

function restSymbolForValue(value: BeatValue): string {
  if (value === "whole") return "𝄻";
  if (value === "half") return "𝄼";
  if (value === "eighth") return "𝄾";
  return "𝄽";
}

function noteSymbolForValue(value: BeatValue): string {
  if (value === "whole") return "𝅝";
  if (value === "half") return "𝅗𝅥";
  if (value === "eighth") return "♪";
  return "♩";
}

function dominantMidiCount(map: Map<number, number>): { midi: number | null; count: number } {
  let bestMidi: number | null = null;
  let bestCount = 0;
  for (const [midi, count] of map.entries()) {
    if (count > bestCount) {
      bestMidi = midi;
      bestCount = count;
    }
  }
  return { midi: bestMidi, count: bestCount };
}

function beatValueFromTimeSignature(
  timeSignature: typeof sequenceSettings.timeSignature,
): BeatValue {
  const denominator = parseInt(timeSignature.split("/")[1] ?? "4", 10);
  if (denominator === 2) return "half";
  if (denominator === 8) return "eighth";
  return "quarter";
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

function trimBeatHistory(): void {
  if (beatAttempts.length > 12) {
    beatAttempts.length = 12;
  }
}

function classifyBeat(errorMs: number, toleranceMs: number): BeatStatus {
  if (Math.abs(errorMs) <= toleranceMs) {
    return "On Time";
  }
  return errorMs < 0 ? "Short" : "Long";
}

function metronomeBeatPattern(
  timeSignature: typeof sequenceSettings.timeSignature,
): Array<"strong" | "medium" | "weak"> {
  if (timeSignature === "2/2") return ["strong", "weak"];
  if (timeSignature === "2/4") return ["strong", "weak"];
  if (timeSignature === "3/4") return ["strong", "weak", "weak"];
  if (timeSignature === "4/4") return ["strong", "weak", "medium", "weak"];
  return ["strong", "weak", "weak", "medium", "weak", "weak"]; // 6/8
}

function beatDurationForTimeSignature(
  bpm: number,
  timeSignature: typeof sequenceSettings.timeSignature,
): number {
  const denominator = parseInt(timeSignature.split("/")[1] ?? "4", 10);
  // BPM follows denominator beat unit: quarter for /4, half for /2, eighth for /8.
  const quarterMs = 60_000 / bpm;
  if (denominator === 2) return quarterMs * 2;
  if (denominator === 8) return quarterMs / 2;
  return quarterMs;
}

function beatsPerBar(timeSignature: typeof sequenceSettings.timeSignature): number {
  const numerator = parseInt(timeSignature.split("/")[0] ?? "4", 10);
  return Number.isFinite(numerator) && numerator > 0 ? numerator : 4;
}

function barDurationMs(
  bpm: number,
  timeSignature: typeof sequenceSettings.timeSignature,
): number {
  return beatsPerBar(timeSignature) * beatDurationForTimeSignature(bpm, timeSignature);
}

function beatUnitToMs(bpm: number, unit: BeatUnit): number {
  const quarterMs = 60_000 / bpm;
  if (unit === "half") return quarterMs * 2;
  if (unit === "eighth") return quarterMs / 2;
  return quarterMs;
}

function beatUnitLabel(unit: BeatUnit): string {
  if (unit === "half") return "half note";
  if (unit === "eighth") return "eighth note";
  return "quarter note";
}

function defaultBeatUnitForTimeSignature(timeSignature: typeof sequenceSettings.timeSignature): BeatUnit {
  const denominator = parseInt(timeSignature.split("/")[1] ?? "4", 10);
  if (denominator === 2) return "half";
  if (denominator === 8) return "eighth";
  return "quarter";
}

function asTimeSignature(value: string): typeof sequenceSettings.timeSignature {
  if (value === "2/2" || value === "2/4" || value === "3/4" || value === "4/4" || value === "6/8") {
    return value;
  }
  return "4/4";
}

function asBeatUnit(value: string): BeatUnit {
  if (value === "half" || value === "quarter" || value === "eighth") {
    return value;
  }
  return "quarter";
}

function makeWarmupGroup(
  midi: number,
  label: PracticePatternNote["label"],
  repeatCount = 4,
): PracticePatternNote[] {
  return Array.from({ length: repeatCount }, () => ({ midi, label }));
}

function practicePatternById(id: string): PracticePattern {
  return PRACTICE_PATTERNS.find((pattern) => pattern.id === id) ?? PRACTICE_PATTERNS[0];
}

function selectedPracticePattern(): PracticePattern {
  return practicePatternById(selectedPracticePatternId);
}

function createPracticePatternResults(): PracticePatternResult[] {
  return selectedPracticePattern().notes.map(() => ({
    status: "pending",
    playedMidi: null,
    bleedMidi: null,
  }));
}

function practicePatternLabels(pattern: PracticePattern): string {
  return pattern.notes
    .map((note) => note.label)
    .reduce<string[]>((parts, label, index) => {
      if (index > 0 && index % 4 === 0) {
        parts.push("|");
      }
      parts.push(label);
      return parts;
    }, [])
    .join(" ");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function formatStringPurityLine(frame: PitchFrame | null): string {
  if (!frame || frame.stringPurity === null || frame.primaryString === null) {
    return "String purity: -";
  }

  const purityPct = Math.round(frame.stringPurity * 100);
  const bleedRatio = frame.adjacentBleedRatio ?? 0;
  const bleedPct = `${Math.round(bleedRatio * 100)}%`;
  const bleedThreshold = activeBleedThreshold();
  const bleedDetected = bleedRatio >= bleedThreshold;
  const severity =
    !bleedDetected
      ? "Clean"
      : bleedRatio >= Math.min(PRACTICE_BLEED_MAX, bleedThreshold + 0.18)
        ? "High bleed"
        : "Possible bleed";
  const bleedText =
    bleedDetected && frame.bleedString ? ` | likely extra ${frame.bleedString} string` : "";
  return `String purity ${purityPct}% | bleed ${bleedPct} | ${severity} (target ${frame.primaryString})${bleedText}`;
}

function buildBleedNoteLine(frame: PitchFrame | null): string {
  if (!frame || frame.bleedString === null || frame.adjacentBleedRatio === null) {
    return "&nbsp;";
  }
  if (frame.adjacentBleedRatio < activeBleedThreshold()) {
    return "&nbsp;";
  }
  const bleedLabel = bleedStringToSolfege(frame.bleedString);
  const intensity = bleedOverlayIntensity(frame.adjacentBleedRatio);
  const opacity = (0.08 + intensity * 0.92).toFixed(3);
  return `<span class="bleed-note-prefix">Secondary:</span> <span class="bleed-note" style="opacity:${opacity};">${bleedLabel} (${frame.bleedString} string)</span>`;
}

function bleedStringToSolfege(stringName: "G" | "D" | "A" | "E"): string {
  if (stringName === "G") return "Sol";
  if (stringName === "D") return "Re";
  if (stringName === "A") return "La";
  return "Mi";
}

function bleedOverlayIntensity(bleedRatio: number): number {
  // Map bleed intensity to [0..1] where 1 is the strongest bleed that is still
  // plausibly "secondary", before it would become the dominant/main tone.
  const minBleed = activeBleedThreshold();
  const maxSecondaryBleed = Math.min(PRACTICE_BLEED_MAX, minBleed + 0.24);
  if (maxSecondaryBleed <= minBleed) {
    return bleedRatio >= minBleed ? 1 : 0;
  }
  return clamp((bleedRatio - minBleed) / (maxSecondaryBleed - minBleed), 0, 1);
}

function setAudioSessionType(type: "auto" | "playback" | "play-and-record"): void {
  try {
    const nav = navigator as Navigator & {
      audioSession?: {
        type?: string;
      };
    };
    if (nav.audioSession && typeof nav.audioSession.type === "string") {
      nav.audioSession.type = type;
    }
  } catch {
    // Best-effort Safari optimization only.
  }
}

function detectLikelyIOS(): boolean {
  const ua = navigator.userAgent ?? "";
  const platform = (navigator as Navigator & { platform?: string }).platform ?? "";
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
}

mountUi();
render();
