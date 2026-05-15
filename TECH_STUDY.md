# Violin Note Recognition Technical Study

## Objective
Design a browser-based monophonic violin recognizer that supports:
- Live note feedback with low latency.
- Start/stop sequence capture with rhythm discretization for staff display.

## 1) Input Signal Characteristics (Violin-Specific)
- Strong harmonic content can cause octave/harmonic confusion in naive FFT peak methods.
- Vibrato introduces periodic frequency modulation (pitch center remains stable musically).
- Bow attacks can be noisy and unstable before the tone settles.
- Legato and glissando make note boundaries ambiguous.

Implication: robust pitch + confidence + temporal state logic is required.

## 2) Pitch Detection Candidates
### A) FFT Peak Picking
Pros:
- Simple and fast.

Cons:
- Sensitive to harmonics and timbral changes.
- Less stable on bowed string transients.

Use:
- Optional baseline or debug, not primary detector.

### B) Autocorrelation / YIN Family (Recommended)
Pros:
- Better fundamental estimation for monophonic instruments.
- Works well with violin when paired with confidence gating.

Cons:
- Requires careful window sizing and thresholds.

Use:
- Primary detector for MVP.

## 3) Timing and Window Recommendations
Starting points (to tune empirically):
- Sample rate: browser default (often 44.1k or 48k).
- Analysis frame: 20-40 ms equivalent.
- Hop size: 10-20 ms.
- UI refresh: 30-50 ms.

Tradeoff:
- Larger window: better pitch stability, higher latency.
- Smaller window: lower latency, more jitter.

## 4) Confidence and State Machine Strategy
Frame-level detector output should include confidence 0..1.

Recommended transitions:
- `silence`: confidence below threshold.
- `candidate`: confidence above threshold but not stable long enough.
- `stable`: held for minimum duration and pitch consistency.
- `release`: confidence drops or sustained silence.

Key controls:
- `minStableMs`: prevents instant false positives.
- `pitchToleranceCents`: permits vibrato without note flipping.
- `minChangeHoldMs`: requires new pitch to persist before splitting a note.

## 5) Sequence Segmentation and Quantization
Pipeline:
1. Pitch frames -> stable note spans.
2. Merge tiny fragments below `minNoteMs` into neighbors when reasonable.
3. Detect rests from confidence/silence gaps.
4. Convert durations (ms) to beats via BPM.
5. Quantize to grid (e.g., 1/8) with optional swing/triplet support later.

Important:
- Keep both raw and quantized timelines for debugging.

## 6) Time Signature and Rhythm Settings
What each setting does:
- BPM: converts milliseconds to beat units.
- Time signature numerator: beats per measure.
- Time signature denominator: beat unit (quarter, eighth, etc.).
- Quantization grid: minimum rhythmic unit (e.g., 1/8, 1/16).

Common issue:
- Wrong BPM/time signature can make a correct performance look rhythmically wrong after quantization.

## 7) Notation Mapping Concerns
- MIDI -> staff position is straightforward.
- Enharmonic spelling is not trivial without key context (A# vs Bb).

MVP recommendation:
- Use a simple spelling policy (sharp-preferred or key-fixed).
- Add key-aware spelling as post-MVP enhancement.

## 8) Solfege Display (Do Re Mi)
Support options:
- Fixed Do (default): C=Do always.
- Movable Do (optional later): tonic=Do based on key.

MVP should clearly label mode to avoid confusion.

## 9) UX Requirements That Affect DSP Perception
- Visible confidence indicator helps user trust output.
- If uncertain, show "listening" state rather than wrong note.
- Keep latency consistent; jittery timing feels less reliable than modest fixed delay.

## 10) Performance and Browser Constraints
- Prefer AudioWorklet for real-time processing.
- iOS Safari requires explicit user interaction before starting audio context.
- Avoid heavy main-thread rendering in parallel with DSP.

## 11) Evaluation Protocol
Test set categories:
- Sustained notes with vibrato.
- Scale passages with clear note boundaries.
- Rhythmic exercises (quarters/eighths/rests).
- Slurs/legato transitions.

Metrics:
- Pitch accuracy (% frames or % note events correct).
- False split rate (extra notes per phrase).
- Miss rate (undetected intended notes).
- Rhythm error after quantization (event duration difference in beats).

## 12) Recommended MVP Acceptance Criteria
- Live mode detects intended pitch center correctly for steady tones with moderate vibrato in quiet room.
- Sequence mode produces readable 1-bar to 4-bar outputs with plausible rhythm in 4/4 at moderate tempo.
- End-to-end live feedback remains under ~100 ms perceived latency on target devices.

## 13) Post-MVP Expansion Ideas
- Key-aware enharmonic spelling.
- Triplet and dotted-rhythm-aware quantization.
- Visual intonation feedback in cents.
- Export to MusicXML/MIDI.
- Personalized threshold auto-calibration per device.
