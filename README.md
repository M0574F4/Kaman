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

## Build

```bash
npm run build
```

The production build is written to `dist/` and is deployed to GitHub Pages by the workflow in `.github/workflows/static.yml`.
