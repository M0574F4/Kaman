import { startMic, stopMic, type MicHandle } from "./audio/mic";
import { startPitchPipeline, type PipelineHandle } from "./audio/pipeline";
import { type PitchFrame } from "./audio/types";
import { LiveNoteTracker, initialLiveSettings } from "./modes/live-mode";
import {
  SequenceCollector,
  initialSequenceSettings,
} from "./modes/sequence-mode";
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

const state = createInitialState();
const sequenceSettings = initialSequenceSettings();
const liveSettings = initialLiveSettings();
const liveTracker = new LiveNoteTracker(liveSettings, 30_000);
const collector = new SequenceCollector(sequenceSettings);

const TRAIL_DURATION_MS = 1400;
const TRAIL_START_LEFT_PCT = 58;
const TRAIL_END_LEFT_PCT = 2;
const BATCH_FADE_MS = 1700;

let micHandle: MicHandle | null = null;
let pipeline: PipelineHandle | null = null;
let lastFrame: PitchFrame | null = null;
let renderPending = false;
let showExactIntonation = false;
let enableFadeTrail = true;
let enableVisualMetronome = false;
let enableMetronomeSound = false;
let enableStringPurityCheck = false;
let minBleedScore = 0.14;
let sequenceSubMode: SequenceSubMode = "single-beat";
let beatUnit: BeatUnit = defaultBeatUnitForTimeSignature(sequenceSettings.timeSignature);
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
  liveMetronomeControls: HTMLDivElement;
  sequenceControls: HTMLDivElement;
  sequenceSubmodeSelect: HTMLSelectElement;
  liveBpmInput: HTMLInputElement;
  liveBpmUpBtn: HTMLButtonElement;
  liveBpmDownBtn: HTMLButtonElement;
  bpmInput: HTMLInputElement;
  timeSignatureSelect: HTMLSelectElement;
  beatUnitSelect: HTMLSelectElement;
  toleranceInput: HTMLInputElement;
  visualMetronomeToggle: HTMLInputElement;
  soundMetronomeToggle: HTMLInputElement;
  bleedThresholdInput: HTMLInputElement;
  stringPurityToggle: HTMLInputElement;
  exactToggle: HTMLInputElement;
  trailToggle: HTMLInputElement;
  captureHint: HTMLParagraphElement;
  noteMetric: HTMLParagraphElement;
  bleedNoteLine: HTMLParagraphElement;
  liveMetaLine: HTMLParagraphElement;
  purityMetaLine: HTMLParagraphElement;
  sequenceSummary: HTMLPreElement;
  sequenceMeta: HTMLParagraphElement;
  beatBatchBox: HTMLDivElement;
  metronomeBox: HTMLDivElement;
  staffBatchLayer: HTMLDivElement;
  noteGroup: HTMLDivElement;
  ledgerLayer: HTMLDivElement;
  trailLayer: HTMLDivElement;
};

let ui: UiRefs | null = null;

function mountUi(): void {
  appRoot.innerHTML = `
    <main class="panel">
      <h1>Violin Practice MVP</h1>
      <div class="controls">
        <button id="listen-btn" class="primary">Start Listening</button>
        <select id="mode-select" aria-label="Mode">
          <option value="live">Live Mode</option>
          <option value="sequence">Sequence Mode</option>
        </select>
        <button id="record-btn" disabled>Start Capture</button>
      </div>

      <p id="capture-hint" class="muted"></p>

      <div class="grid">
        <section class="card">
          <div class="note-readout">
            <p id="note-metric" class="metric">- <span class="muted">(-)</span></p>
            <p id="bleed-note-line" class="bleed-note-line">&nbsp;</p>
          </div>
          <div class="staff" aria-label="5-line staff">
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
        </section>

        <section class="card">
          <h2>Sequence Output</h2>
          <div id="live-metronome-controls" class="sequence-controls live-metro-controls">
            <label>Live BPM
              <span class="live-bpm-stepper">
                <input id="live-bpm-input" class="live-bpm-input" type="number" min="30" max="240" step="1" value="80" />
                <span class="live-bpm-arrows">
                  <button id="live-bpm-up" type="button" class="live-bpm-arrow" aria-label="Increase live BPM">▲</button>
                  <button id="live-bpm-down" type="button" class="live-bpm-arrow" aria-label="Decrease live BPM">▼</button>
                </span>
              </span>
            </label>
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
          <label class="toggle-row" for="exact-pitch-toggle">
            <input id="exact-pitch-toggle" type="checkbox" />
            Show exact intonation offset on staff (unquantized live placement)
          </label>
          <label class="toggle-row" for="trail-toggle">
            <input id="trail-toggle" type="checkbox" checked />
            Enable note fade trail animation
          </label>
          <label class="toggle-row" for="string-purity-toggle">
            <input id="string-purity-toggle" type="checkbox" />
            Detect adjacent-string bleed (experimental)
            <span class="bleed-threshold-group">
              Min bleed score
              <input id="bleed-threshold-input" type="number" min="0.05" max="0.49" step="0.01" value="0.14" />
            </span>
          </label>
          <label class="toggle-row compact" for="visual-metronome-toggle">
            <input id="visual-metronome-toggle" type="checkbox" />
            Visual metronome
          </label>
          <label class="toggle-row compact" for="sound-metronome-toggle">
            <input id="sound-metronome-toggle" type="checkbox" />
            Metronome sound
          </label>
          <div id="metronome-box" class="metronome-box"></div>
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
  const liveMetronomeControls = appRoot.querySelector<HTMLDivElement>("#live-metronome-controls");
  const sequenceControls = appRoot.querySelector<HTMLDivElement>("#sequence-controls");
  const sequenceSubmodeSelect = appRoot.querySelector<HTMLSelectElement>("#sequence-submode-select");
  const liveBpmInput = appRoot.querySelector<HTMLInputElement>("#live-bpm-input");
  const liveBpmUpBtn = appRoot.querySelector<HTMLButtonElement>("#live-bpm-up");
  const liveBpmDownBtn = appRoot.querySelector<HTMLButtonElement>("#live-bpm-down");
  const bpmInput = appRoot.querySelector<HTMLInputElement>("#bpm-input");
  const timeSignatureSelect = appRoot.querySelector<HTMLSelectElement>("#time-signature-select");
  const beatUnitSelect = appRoot.querySelector<HTMLSelectElement>("#beat-unit-select");
  const toleranceInput = appRoot.querySelector<HTMLInputElement>("#tolerance-input");
  const visualMetronomeToggle = appRoot.querySelector<HTMLInputElement>("#visual-metronome-toggle");
  const soundMetronomeToggle = appRoot.querySelector<HTMLInputElement>("#sound-metronome-toggle");
  const bleedThresholdInput = appRoot.querySelector<HTMLInputElement>("#bleed-threshold-input");
  const stringPurityToggle = appRoot.querySelector<HTMLInputElement>("#string-purity-toggle");
  const exactToggle = appRoot.querySelector<HTMLInputElement>("#exact-pitch-toggle");
  const trailToggle = appRoot.querySelector<HTMLInputElement>("#trail-toggle");
  const captureHint = appRoot.querySelector<HTMLParagraphElement>("#capture-hint");
  const noteMetric = appRoot.querySelector<HTMLParagraphElement>("#note-metric");
  const bleedNoteLine = appRoot.querySelector<HTMLParagraphElement>("#bleed-note-line");
  const liveMetaLine = appRoot.querySelector<HTMLParagraphElement>("#live-meta-line");
  const purityMetaLine = appRoot.querySelector<HTMLParagraphElement>("#purity-meta-line");
  const sequenceSummary = appRoot.querySelector<HTMLPreElement>("#sequence-summary");
  const sequenceMeta = appRoot.querySelector<HTMLParagraphElement>("#sequence-meta");
  const beatBatchBox = appRoot.querySelector<HTMLDivElement>("#beat-batch-box");
  const metronomeBox = appRoot.querySelector<HTMLDivElement>("#metronome-box");
  const staffBatchLayer = appRoot.querySelector<HTMLDivElement>("#staff-batch-layer");
  const noteGroup = appRoot.querySelector<HTMLDivElement>("#staff-note-group");
  const ledgerLayer = appRoot.querySelector<HTMLDivElement>("#ledger-layer");
  const trailLayer = appRoot.querySelector<HTMLDivElement>("#trail-layer");

  if (
    !listenBtn ||
    !modeSelect ||
    !recordBtn ||
    !liveMetronomeControls ||
    !sequenceControls ||
    !sequenceSubmodeSelect ||
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
    liveMetronomeControls,
    sequenceControls,
    sequenceSubmodeSelect,
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
    staffBatchLayer,
    noteGroup,
    ledgerLayer,
    trailLayer,
  };

  listenBtn.addEventListener("click", () => {
    void onToggleListening();
  });

  modeSelect.addEventListener("change", onModeChange);

  recordBtn.addEventListener("click", () => {
    void onToggleRecording();
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

  const applyBpmInput = (target: HTMLInputElement): void => {
    const raw = parseInt(target.value || "80", 10);
    if (!Number.isFinite(raw)) {
      return;
    }
    const nextBpm = clamp(raw, 30, 240);
    if (nextBpm === sequenceSettings.bpm) {
      return;
    }
    sequenceSettings.bpm = nextBpm;
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
    sequenceSettings.bpm = nextBpm;
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

  soundMetronomeToggle.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    enableMetronomeSound = target.checked;
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
    pipeline?.setStringPurityEnabled(enableStringPurityCheck);
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

  ui.listenBtn.textContent = state.listening ? "Stop Listening" : "Start Listening";
  ui.listenBtn.style.display = state.mode === "live" ? "" : "none";
  ui.modeSelect.value = state.mode;
  ui.recordBtn.disabled = state.mode !== "sequence";
  ui.recordBtn.style.display = state.mode === "sequence" ? "" : "none";
  ui.liveMetronomeControls.style.display = state.mode === "live" ? "grid" : "none";
  ui.sequenceControls.style.display = state.mode === "sequence" ? "grid" : "none";
  ui.recordBtn.textContent = captureButtonLabel();
  ui.sequenceSubmodeSelect.value = sequenceSubMode;
  const activeElement = document.activeElement;
  if (activeElement !== ui.liveBpmInput) {
    ui.liveBpmInput.value = String(sequenceSettings.bpm);
  }
  if (activeElement !== ui.bpmInput) {
    ui.bpmInput.value = String(sequenceSettings.bpm);
  }
  ui.timeSignatureSelect.value = sequenceSettings.timeSignature;
  ui.beatUnitSelect.value = beatUnit;
  ui.beatUnitSelect.disabled = sequenceSubMode === "single-beat";
  ui.toleranceInput.value = String(beatToleranceMs);
  ui.visualMetronomeToggle.checked = enableVisualMetronome;
  ui.soundMetronomeToggle.checked = enableMetronomeSound;
  if (document.activeElement !== ui.bleedThresholdInput) {
    ui.bleedThresholdInput.value = minBleedScore.toFixed(2);
  }
  ui.stringPurityToggle.checked = enableStringPurityCheck;
  ui.exactToggle.checked = showExactIntonation;
  ui.trailToggle.checked = enableFadeTrail;
  syncMetronomeAnimationLoop();

  const centsText = state.live.cents === null ? "" : ` (${formatSigned(state.live.cents)} cents)`;
  ui.noteMetric.innerHTML = `${solfege} <span class="muted">(${scientific})${centsText}</span>`;
  ui.bleedNoteLine.innerHTML = enableStringPurityCheck ? buildBleedNoteLine(lastFrame) : "&nbsp;";

  const statusText = !state.listening
    ? "Not listening"
    : state.live.holdingLastNote
      ? "Holding last note"
      : "Listening";

  const freqText = state.live.freqHz ? `${state.live.freqHz.toFixed(1)} Hz` : "-";
  const confText = `${(state.live.confidence * 100).toFixed(0)}%`;
  const centsLine = state.live.cents === null ? "cents: -" : `cents: ${formatSigned(state.live.cents)}`;
  ui.liveMetaLine.textContent = `${freqText} | ${confText} | ${centsLine} | ${statusText}`;
  ui.purityMetaLine.style.display = enableStringPurityCheck ? "" : "none";
  if (enableStringPurityCheck) {
    ui.purityMetaLine.textContent = formatStringPurityLine(lastFrame);
  }

  if (state.mode === "live") {
    ui.captureHint.textContent = "Live Mode: intonation feedback only.";
  } else if (sequenceSubMode === "single-beat") {
    ui.captureHint.textContent =
      "Single Beat Drill: use Start/Stop Single Beat Drill only; mic starts/stops automatically.";
  } else if (state.recording) {
    ui.captureHint.textContent = "Phrase recording in progress. Stop capture to finalize the phrase.";
  } else if (state.listening) {
    ui.captureHint.textContent = "Phrase mode ready: use Start/Stop Phrase Capture; mic is managed automatically.";
  } else {
    ui.captureHint.textContent = "Sequence Mode: one Start/Stop button controls both capture and mic.";
  }

  const singleBeatModeActive = state.mode === "sequence" && sequenceSubMode === "single-beat";
  const currentSnapshot = buildCurrentNoteSnapshot(displayedMidi);

  if (!singleBeatModeActive) {
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

  const showMetronome = enableVisualMetronome;
  ui.metronomeBox.style.display = showMetronome ? "block" : "none";
  if (showMetronome) {
    ui.metronomeBox.innerHTML = renderVisualMetronome(performance.now());
  } else {
    ui.metronomeBox.innerHTML = "";
  }

  if (sequenceSubMode === "single-beat") {
    const targetMs = barDurationMs(sequenceSettings.bpm, sequenceSettings.timeSignature);
    const beatsInBar = beatsPerBar(sequenceSettings.timeSignature);
    ui.sequenceMeta.textContent =
      `Single Beat Drill | ${sequenceSettings.timeSignature} | ${beatsInBar} beats per bar | bar target ${Math.round(targetMs)} ms | tolerance ±${beatToleranceMs} ms`;
    ui.beatBatchBox.style.display = "block";
    ui.beatBatchBox.innerHTML = renderBeatBatchVisualization();
    ui.sequenceSummary.textContent = `${singleBeatDebug}\n\n${renderBeatDrillSummary()}`;
  } else {
    ui.beatBatchBox.style.display = "none";
    ui.beatBatchBox.innerHTML = "";
    ui.sequenceMeta.textContent = `${sequenceSettings.timeSignature} at ${sequenceSettings.bpm} BPM, grid ${sequenceSettings.quantization}`;
    ui.sequenceSummary.textContent = renderSequenceSummary(state.sequence);
  }

  if (fadingBeatBatches.length > 0) {
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
    state.mode === "live"
      ? `Live | beat ${beatInBar}/${beats.length} | ${sequenceSettings.bpm} BPM`
      : `${sequenceSettings.timeSignature} | beat ${beatInBar}/${beats.length} | ${sequenceSettings.bpm} BPM`;

  return `<div class="metro-row">${pulseHtml}</div><div class="metro-label">${label}</div>`;
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
  if (state.mode === "live") {
    return ["strong"];
  }
  return metronomeBeatPattern(sequenceSettings.timeSignature);
}

function metronomeBeatDurationMs(): number {
  if (state.mode === "live") {
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
    pipeline?.stop();
    pipeline = null;

    if (micHandle) {
      stopMic(micHandle);
      micHandle = null;
    }

    state.listening = false;
    state.recording = false;
    lastFrame = null;
    liveTracker.reset();
    state.live = createInitialState().live;
    previousDisplayedSnapshot = null;
    trailNotes.length = 0;
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

    pipeline = startPitchPipeline(micHandle, onPitchFrame);
    pipeline.setStringPurityEnabled(enableStringPurityCheck);
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
  state.mode = target.value === "sequence" ? "sequence" : "live";
  resetMetronomeClock();

  if (state.mode === "live") {
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

  scheduleRender();
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
  const bleedDetected = bleedRatio >= minBleedScore;
  const severity =
    !bleedDetected
      ? "Clean"
      : bleedRatio >= Math.min(0.34, minBleedScore + 0.18)
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
  if (frame.adjacentBleedRatio < minBleedScore) {
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
  const minBleed = minBleedScore;
  const maxSecondaryBleed = 0.49;
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
