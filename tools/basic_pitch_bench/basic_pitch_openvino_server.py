#!/usr/bin/env python3
"""Local OpenVINO Basic Pitch server for AI Probe.

The browser sends raw mic chunks. This service keeps the rolling audio buffer,
runs Basic Pitch contour inference with OpenVINO, scans contour peaks locally,
and returns compact detections to the UI.
"""

from __future__ import annotations

import json
import math
import sys
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from openvino import Core

from bench_basic_pitch_runtimes import (
    ANNOTATIONS_BASE_MIDI,
    BASIC_PITCH_SAMPLE_RATE,
    CONTOUR_DETECTION_THRESHOLD,
    CONTOURS_BINS_PER_SEMITONE,
    MODEL_ANNOTATIONS_FPS,
    MODEL_AUDIO_N_SAMPLES,
    MODEL_HOP_SIZE,
    MODEL_OVERLAP_HALF_FRAMES,
    MODEL_OVERLAP_LENGTH_SAMPLES,
    choose_openvino_contour_output,
    find_basic_pitch_onnx_model,
)


HOST = "127.0.0.1"
PORT = 8790
WINDOW_SECONDS = 2.4
ANALYSIS_INTERVAL_MS = 950.0
SESSION_TTL_SECONDS = 300.0
MAX_BODY_BYTES = 1_200_000
DEFAULT_MIN_FREQ_HZ = 180.0
DEFAULT_MAX_FREQ_HZ = 2800.0
DEFAULT_RMS_THRESHOLD = 0.008


@dataclass
class Session:
    session_id: str
    sample_rate: float
    ring: np.ndarray
    write_index: int = 0
    samples_written: int = 0
    last_rms: float = 0.0
    last_analysis_started_ms: float = -1e12
    last_frame: Dict[str, Any] = field(default_factory=lambda: silent_pitch_frame(0.0, 0.0))
    last_used: float = field(default_factory=time.time)

    @classmethod
    def create(cls, session_id: str, sample_rate: float) -> "Session":
        return cls(
            session_id=session_id,
            sample_rate=sample_rate,
            ring=np.zeros(int(math.ceil(sample_rate * (WINDOW_SECONDS + 0.4))), dtype=np.float32),
        )

    def append(self, samples: np.ndarray) -> float:
        started = time.perf_counter()
        self.last_rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
        for sample in samples:
            self.ring[self.write_index] = sample
            self.write_index = (self.write_index + 1) % self.ring.shape[0]
        self.samples_written = min(self.ring.shape[0], self.samples_written + samples.shape[0])
        self.last_used = time.time()
        return elapsed_ms(started)

    def has_enough_audio(self) -> bool:
        return self.samples_written >= int(self.sample_rate * WINDOW_SECONDS)

    def latest_samples(self, sample_count: int) -> np.ndarray:
        count = min(sample_count, self.samples_written)
        start = (self.write_index - count) % self.ring.shape[0]
        if start + count <= self.ring.shape[0]:
            return self.ring[start : start + count].copy()
        first = self.ring[start:]
        second = self.ring[: count - first.shape[0]]
        return np.concatenate([first, second]).astype(np.float32, copy=False)


class BasicPitchOpenVinoEngine:
    def __init__(self) -> None:
        model_path = find_basic_pitch_onnx_model()
        if model_path is None:
            raise RuntimeError("Could not find Basic Pitch ONNX model in the installed basic_pitch package.")
        self.model_path = Path(model_path)
        core = Core()
        model = core.read_model(str(model_path))
        self.compiled = core.compile_model(model, "CPU")
        self.input_port = self.compiled.inputs[0]
        self.contour_output = choose_openvino_contour_output(self.compiled.outputs)
        self.request = self.compiled.create_infer_request()
        self.sessions: Dict[str, Session] = {}

    def append(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        now_ms = float(payload.get("tMs") or time.perf_counter() * 1000.0)
        session_id = str(payload.get("sessionId") or uuid.uuid4())
        sample_rate = float(payload.get("sampleRate") or 48_000.0)
        options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
        min_freq = float(options.get("minFreq", DEFAULT_MIN_FREQ_HZ))
        max_freq = float(options.get("maxFreq", DEFAULT_MAX_FREQ_HZ))
        rms_threshold = float(options.get("rmsThreshold", DEFAULT_RMS_THRESHOLD))
        raw_samples = payload.get("samples")
        if not isinstance(raw_samples, list):
            raise ValueError("samples must be a JSON number array")
        samples = np.asarray(raw_samples, dtype=np.float32)

        session = self.sessions.get(session_id)
        if session is None or abs(session.sample_rate - sample_rate) > 1e-6:
            session = Session.create(session_id, sample_rate)
            self.sessions[session_id] = session

        append_ms = session.append(samples)
        self.cleanup_sessions()

        if session.last_rms < rms_threshold:
            session.last_frame = silent_pitch_frame(now_ms, 0.0)
            return {"analysis": None, "pitchFrame": session.last_frame}

        if not session.has_enough_audio() or now_ms - session.last_analysis_started_ms < ANALYSIS_INTERVAL_MS:
            return {"analysis": None, "pitchFrame": {**session.last_frame, "tMs": now_ms}}

        session.last_analysis_started_ms = now_ms
        audio_tap_copy_ms = float(payload.get("audioTapCopyMs") or 0.0)
        audio_tap_interval_ms = payload.get("audioTapIntervalMs")
        if audio_tap_interval_ms is not None:
            audio_tap_interval_ms = float(audio_tap_interval_ms)
        analysis = self.analyze(
            session,
            now_ms,
            append_ms,
            min_freq,
            max_freq,
            audio_tap_copy_ms,
            audio_tap_interval_ms,
        )
        session.last_frame = analysis["selectedFrame"]
        return {"analysis": analysis, "pitchFrame": session.last_frame}

    def analyze(
        self,
        session: Session,
        t_ms: float,
        append_ms: float,
        min_freq: float,
        max_freq: float,
        audio_tap_copy_ms: float,
        audio_tap_interval_ms: Optional[float],
    ) -> Dict[str, Any]:
        total_started = time.perf_counter()

        latest_started = time.perf_counter()
        source = session.latest_samples(int(session.sample_rate * WINDOW_SECONDS))
        latest_samples_ms = elapsed_ms(latest_started)

        resample_started = time.perf_counter()
        resampled = resample_linear(source, session.sample_rate, BASIC_PITCH_SAMPLE_RATE)
        resample_ms = elapsed_ms(resample_started)

        prepare_started = time.perf_counter()
        framed = frame_basic_pitch_audio(resampled)
        tf_prepare_ms = elapsed_ms(prepare_started)

        expected_frames = int(math.floor(resampled.shape[0] * (MODEL_ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE)))
        infer_started = time.perf_counter()
        self.request.infer({self.input_port: framed})
        raw = np.asarray(self.request.get_tensor(self.contour_output).data)
        graph_execute_ms = elapsed_ms(infer_started)

        unwrap_started = time.perf_counter()
        contours = unwrap_contour_output(raw, expected_frames)
        tensor_unwrap_ms = elapsed_ms(unwrap_started)

        post_started = time.perf_counter()
        detections = contours_to_pitch_detections(contours, min_freq, max_freq)
        contour_postprocess_ms = elapsed_ms(post_started)

        frame_started = time.perf_counter()
        selected = select_pitch_detection_frame(detections, resampled.shape[0] / BASIC_PITCH_SAMPLE_RATE, t_ms)
        frame_select_ms = elapsed_ms(frame_started)

        total_ms = elapsed_ms(total_started)
        return {
            "tMs": t_ms,
            "windowSeconds": resampled.shape[0] / BASIC_PITCH_SAMPLE_RATE,
            "analysisMs": total_ms,
            "profile": {
                "inputSampleRate": session.sample_rate,
                "inputSamples": int(source.shape[0]),
                "resampledSamples": int(resampled.shape[0]),
                "modelAlreadyLoaded": True,
                "audioTapCopyMs": audio_tap_copy_ms,
                "audioTapIntervalMs": audio_tap_interval_ms,
                "appendMs": append_ms,
                "latestSamplesMs": latest_samples_ms,
                "resampleMs": resample_ms,
                "modelLoadWaitMs": 0.0,
                "evaluateModelMs": graph_execute_ms + tensor_unwrap_ms,
                "tfPrepareMs": tf_prepare_ms,
                "graphExecuteMs": graph_execute_ms,
                "tensorUnwrapMs": tensor_unwrap_ms,
                "tensorToArrayMs": 0.0,
                "contourCallbackMs": 0.0,
                "contourPostprocessMs": contour_postprocess_ms,
                "frameSelectMs": frame_select_ms,
                "totalAnalysisMs": total_ms,
                "contourFrames": int(contours.shape[0]),
                "pitchDetections": len(detections),
            },
            "pitchDetections": detections,
            "selectedFrame": selected,
        }

    def cleanup_sessions(self) -> None:
        now = time.time()
        expired = [
            session_id for session_id, session in self.sessions.items()
            if now - session.last_used > SESSION_TTL_SECONDS
        ]
        for session_id in expired:
            del self.sessions[session_id]


def frame_basic_pitch_audio(audio: np.ndarray) -> np.ndarray:
    prefix = np.zeros(MODEL_OVERLAP_LENGTH_SAMPLES // 2, dtype=np.float32)
    wav = np.concatenate([prefix, audio.astype(np.float32, copy=False)])
    if wav.shape[0] <= MODEL_AUDIO_N_SAMPLES:
        frame_count = 1
    else:
        frame_count = int(math.ceil((wav.shape[0] - MODEL_AUDIO_N_SAMPLES) / MODEL_HOP_SIZE)) + 1
    frames = np.zeros((frame_count, MODEL_AUDIO_N_SAMPLES, 1), dtype=np.float32)
    for index in range(frame_count):
        start = index * MODEL_HOP_SIZE
        end = min(start + MODEL_AUDIO_N_SAMPLES, wav.shape[0])
        frames[index, : end - start, 0] = wav[start:end]
    return frames


def unwrap_contour_output(raw: np.ndarray, expected_frames: int) -> np.ndarray:
    trimmed = raw[:, MODEL_OVERLAP_HALF_FRAMES : raw.shape[1] - MODEL_OVERLAP_HALF_FRAMES, :]
    return np.ascontiguousarray(trimmed.reshape((-1, trimmed.shape[-1]))[:expected_frames])


def contours_to_pitch_detections(contours: np.ndarray, min_freq: float, max_freq: float) -> List[Dict[str, Any]]:
    detections: List[Dict[str, Any]] = []
    for frame_index, row in enumerate(contours):
        center = row[1:-1]
        mask = (
            (center >= CONTOUR_DETECTION_THRESHOLD)
            & (center >= row[:-2])
            & (center >= row[2:])
        )
        if not np.any(mask):
            continue
        for bin_index in np.nonzero(mask)[0] + 1:
            confidence = float(row[bin_index])
            left = float(row[bin_index - 1])
            right = float(row[bin_index + 1])
            bin_float = float(bin_index) + parabolic_peak_offset(left, confidence, right)
            midi_float = ANNOTATIONS_BASE_MIDI + bin_float / CONTOURS_BINS_PER_SEMITONE
            freq_hz = 440.0 * 2.0 ** ((midi_float - 69.0) / 12.0)
            if freq_hz < min_freq or freq_hz > max_freq:
                continue
            nearest = round(midi_float)
            detections.append({
                "timeSeconds": (frame_index * 256) / BASIC_PITCH_SAMPLE_RATE,
                "midiFloat": midi_float,
                "freqHz": freq_hz,
                "cents": (midi_float - nearest) * 100.0,
                "confidence": max(0.0, min(1.0, confidence)),
                "frameIndex": frame_index,
                "binIndex": int(bin_index),
            })
    return detections


def select_pitch_detection_frame(detections: List[Dict[str, Any]], window_seconds: float, t_ms: float) -> Dict[str, Any]:
    recent_start = max(0.0, window_seconds - 0.85)
    recent = [detection for detection in detections if detection["timeSeconds"] >= recent_start]
    if not recent:
        return silent_pitch_frame(t_ms, 0.0)
    best = recent[0]
    for detection in recent[1:]:
        if detection["timeSeconds"] > best["timeSeconds"] + 0.04:
            best = detection
        elif abs(detection["timeSeconds"] - best["timeSeconds"]) <= 0.04 and detection["confidence"] > best["confidence"]:
            best = detection
    midi = round(best["midiFloat"])
    return {
        "tMs": t_ms,
        "freqHz": best["freqHz"],
        "midiFloat": best["midiFloat"],
        "midi": midi,
        "cents": best["cents"],
        "confidence": best["confidence"],
        "stringPurity": None,
        "adjacentBleedRatio": None,
        "primaryString": None,
        "bleedString": None,
    }


def silent_pitch_frame(t_ms: float, confidence: float) -> Dict[str, Any]:
    return {
        "tMs": t_ms,
        "freqHz": None,
        "midiFloat": None,
        "midi": None,
        "cents": None,
        "confidence": confidence,
        "stringPurity": None,
        "adjacentBleedRatio": None,
        "primaryString": None,
        "bleedString": None,
    }


def parabolic_peak_offset(left: float, center: float, right: float) -> float:
    denom = left - 2.0 * center + right
    if abs(denom) < 1e-9:
        return 0.0
    return max(-0.5, min(0.5, 0.5 * (left - right) / denom))


def resample_linear(input_audio: np.ndarray, source_rate: float, target_rate: float) -> np.ndarray:
    if abs(source_rate - target_rate) < 1e-6:
        return input_audio.astype(np.float32, copy=True)
    output_length = max(1, int(round(input_audio.shape[0] * target_rate / source_rate)))
    x_old = np.arange(input_audio.shape[0], dtype=np.float32)
    x_new = np.arange(output_length, dtype=np.float32) * (source_rate / target_rate)
    return np.interp(x_new, x_old, input_audio).astype(np.float32)


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000.0


ENGINE = BasicPitchOpenVinoEngine()


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.set_cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {
                "ok": True,
                "service": "kaman-basic-pitch-openvino",
                "runtime": "openvino",
                "modelPath": str(ENGINE.model_path),
                "platform": sys.platform,
            })
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/basic-pitch/append":
            self.send_json(404, {"error": "not found"})
            return
        try:
            payload = self.read_json()
            result = ENGINE.append(payload)
            self.send_json(200, result)
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})

    def read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        data = self.rfile.read(length)
        return json.loads(data.decode("utf-8"))

    def send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.set_cors()
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def set_cors(self) -> None:
        origin = self.headers.get("origin") or "*"
        if origin == "null" or origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1"):
            self.send_header("access-control-allow-origin", origin)
        else:
            self.send_header("access-control-allow-origin", "http://localhost:5175")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")

    def log_message(self, _format: str, *args: Any) -> None:
        return


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Kaman Basic Pitch OpenVINO backend listening at http://{HOST}:{PORT}")
    print(f"model: {ENGINE.model_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
