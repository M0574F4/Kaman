# Kaman Practice Web App

A browser-based Kamancheh practice app for turning microphone input into useful musical feedback. It listens to monophonic playing, estimates pitch in real time, labels notes with fixed-Do solfege, and renders practice output on a simple staff.

The app is built as a TypeScript/Vite frontend and is designed for both mobile and desktop browsers. Current modes include live note feedback, sequence capture for short phrases, spectrum visualization, tempo-aware rhythm checks, and basic staff-oriented practice tools.

## Features

- Live pitch detection from the browser microphone
- Solfege note labels with scientific pitch names
- Staff-style visualization for notes and captured phrases
- Sequence capture with basic timing and rhythm interpretation
- Spectrum and tempo feedback for practice diagnostics
- Local, browser-side audio processing

## Development

```bash
npm install
npm run dev
```

Browser-side autocorrelation audio processing remains the default. Choose
`AI Probe` in the mode selector to inspect Spotify Basic Pitch as a buffered,
browser-side model. The probe shows raw contour pitch detections rather than
grouped or pitch-quantized note events. For local
experiments with backend processing, run:

```bash
npm run dev:backend
```

Then choose `Local backend` in the app's Audio selector. The backend listens on
`http://127.0.0.1:8787` and reuses the same pitch and tempo estimators as the
browser pipeline. If the backend is unavailable, the app stays on browser
processing and reports the error.

When the app is served from localhost with the local backend running, Pattern
Entry can save custom practice patterns to `.kaman/custom-patterns.json`.
Custom patterns are loaded on restart and can be deleted from the pattern list.
This save/delete feature is disabled for the static GitHub Pages build.
Adjacent repeated notes in Pattern Entry are saved as one held note, so two
eighth slots become a quarter note, four eighth slots become a half note, and
so on.

## Build

```bash
npm run build
```

The production build is written to `dist/` and is deployed to GitHub Pages by the workflow in `.github/workflows/static.yml`.
