# Violin Practice Web App MVP Spec

## 1) Product Goal
Build a mobile-first web app (also laptop-browser compatible) for violin practice with two modes:
- Live Note Mode: show the current played note in near real time.
- Sequence Mode: record a played phrase and render pitch plus rhythm on a standard 5-line staff.

The app must support Do-Re-Mi naming and score-like visualization rather than text-only notes.

## 2) Scope
### In Scope (MVP)
- Monophonic violin input via browser microphone.
- Real-time pitch detection with confidence score.
- Do-Re-Mi note labels (fixed Do by default).
- Live display: current note on staff + textual solfege.
- Sequence capture: start/stop recording, detect note events, quantize rhythm, render measures on staff.
- Configurable tempo and time signature for sequence interpretation.
- Works on modern mobile + desktop browsers.

### Out of Scope (MVP)
- Polyphonic detection.
- Automatic key detection.
- Advanced engraving (tuplets, grace notes, complex ties/slurs).
- Multi-track accompaniment.
- Cloud sync/auth.

## 3) User Stories
- As a learner, I can play a note and instantly see which note I produced.
- As a learner, I can press Start, play a short passage, and see a notated note sequence.
- As a learner, I can choose Do-Re-Mi naming and compare against my printed sheet.
- As a learner, I can set BPM and time signature so rhythm interpretation matches my exercise.

## 4) Mode Definitions and Required Settings
### A) Live Note Mode (Instant Feedback)
Purpose: low-latency pitch feedback.

Required settings:
- Reference tuning: A4 = 440 Hz (default), optional 442/443.
- Pitch range filter: violin-relevant range (default G3 to E7).
- Display notation:
  - Staff placement enabled.
  - Solfege labels enabled (`Do Re Mi Fa Sol La Si`).
- Smoothing/hysteresis:
  - Median/EMA window for pitch stabilization.
  - Note-change hysteresis threshold to avoid flicker during vibrato.
- Confidence threshold:
  - Ignore or gray-out uncertain frames.
- Update interval target:
  - UI update every ~30-50 ms.

### B) Sequence Mode (Capture + Staff Output)
Purpose: convert a performed phrase into note events and rhythm.

Required settings:
- Tempo (BPM), default 80.
- Time signature, default 4/4.
- Quantization grid, default 1/8.
- Minimum note duration (debounce), default 80-120 ms.
- Rest threshold (silence/confidence gap), default 120-180 ms.
- Note event boundary policy:
  - Split when stable pitch changes beyond semitone threshold for minimum hold time.
- Measure/bar rendering based on selected time signature.
- Enharmonic policy:
  - Simple sharp-preferred default for MVP, optional key-based spelling later.

## 5) Functional Requirements
- Acquire mic permission and stream audio with Web Audio API.
- Run low-latency pitch detector in an AudioWorklet (preferred) or Worker fallback.
- Produce frame-level output:
  - timestamp
  - frequency_hz
  - midi
  - note_name_chromatic
  - solfege
  - confidence
- Live Mode:
  - show current stable note in notation and solfege text.
- Sequence Mode:
  - Start/Stop capture.
  - Convert frames into note events: {start_ms, end_ms, midi, confidence_avg}.
  - Quantize durations to grid from BPM + time signature.
  - Render bars on staff with basic note/rest values.

## 6) Non-Functional Targets
- End-to-end perceived latency (Live Mode): target < 100 ms.
- Stability under moderate vibrato: avoid rapid false note toggling.
- Mobile performance: smooth UI on mid-range phones.
- Privacy: audio processed on-device in MVP.

## 7) Proposed Technical Architecture
- Frontend: React + TypeScript + Vite (or equivalent).
- Audio pipeline:
  - MediaStream -> AudioContext -> AudioWorklet processor.
  - Pitch detection: YIN-style algorithm (more robust than raw FFT peak).
- State machine for note tracking:
  - `silence -> candidate -> stable -> release`.
- Sequence builder:
  - Frame aggregation -> note segmentation -> quantization -> notation model.
- Staff rendering:
  - VexFlow or OSMD for score-like display.

## 8) Data Model (Initial)
```ts
type PitchFrame = {
  tMs: number;
  freqHz: number | null;
  midi: number | null;
  cents: number | null;
  confidence: number; // 0..1
};

type NoteEvent = {
  startMs: number;
  endMs: number;
  midi: number;
  confidenceAvg: number;
};

type SequenceSettings = {
  bpm: number; // e.g., 80
  timeSignature: "2/4" | "3/4" | "4/4" | "6/8";
  quantization: "1/4" | "1/8" | "1/16";
  minNoteMs: number;
  minRestMs: number;
};
```

## 9) Algorithm Notes and Best Practices
- Prefer YIN/pYIN-style pitch tracking over FFT peak-only method for bowed strings.
- Use confidence gating before state transitions.
- Add hysteresis both in pitch class and in time to reduce vibrato over-segmentation.
- Quantize only after note segmentation; never quantize raw frame stream.
- Keep raw event timeline for debugging alongside quantized timeline.

## 10) Common Failure Modes to Test
- Vibrato causes note fragmentation.
- Attack transients produce wrong initial pitch.
- Low-volume playing misclassified as rests.
- Glissando creates excessive intermediate notes.
- Staff spelling awkward enharmonics (e.g., A# vs Bb).
- Browser/device mic variability impacts confidence.

## 11) Browser/Platform Compatibility
- Primary: Chrome (Android/Desktop), Safari (iOS), Firefox (desktop).
- Notes:
  - iOS requires user gesture to start AudioContext.
  - Keep fallback behavior if AudioWorklet unsupported.

## 12) MVP Defaults (First Build)
- A4: 440 Hz
- Range: G3-E7
- Live UI update: 40 ms
- Sequence BPM: 80
- Time signature: 4/4
- Quantization: 1/8
- minNoteMs: 100
- minRestMs: 140

## 13) Validation Plan (Before Feature Expansion)
- Build a fixed set of 15-20 violin exercises:
  - long tones
  - scale fragments
  - simple rhythmic patterns (quarter/eighth mixes)
- Measure:
  - Pitch correctness rate
  - False split count per phrase
  - Rhythm quantization error per bar
- Tune thresholds from measured results, not intuition.

## 14) Implementation Phases
1. Foundation
- Project scaffold, mic capture, frame logger.

2. Live Mode
- Stable pitch tracking + staff + solfege display.

3. Sequence Mode
- Capture, event segmentation, quantization, bar rendering.

4. Calibration + QA
- Device tuning presets, regression recordings, threshold refinement.

## 15) Risks and Mitigations
- Risk: unstable pitch on some phones.
- Mitigation: larger smoothing window + confidence gating presets.

- Risk: rhythm over/under-segmentation.
- Mitigation: adjustable minNoteMs/minRestMs and visual debug timeline.

- Risk: notation complexity explosion.
- Mitigation: keep MVP engraving simple; postpone advanced symbols.
