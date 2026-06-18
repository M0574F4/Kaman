#!/usr/bin/env python3
"""Benchmark Basic Pitch model runtimes on a fixed local input window.

This focuses on the model/runtime bottleneck rather than browser microphone or UI
cost. It generates a deterministic 2.4 second mono signal, frames it the same way
the Basic Pitch JS wrapper does, then measures ONNX Runtime and OpenVINO.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np


BASIC_PITCH_SAMPLE_RATE = 22_050
FFT_HOP = 256
MODEL_AUDIO_WINDOW_SECONDS = 2
MODEL_AUDIO_N_SAMPLES = BASIC_PITCH_SAMPLE_RATE * MODEL_AUDIO_WINDOW_SECONDS - FFT_HOP
MODEL_OVERLAPPING_FRAMES = 30
MODEL_OVERLAP_HALF_FRAMES = MODEL_OVERLAPPING_FRAMES // 2
MODEL_OVERLAP_LENGTH_SAMPLES = MODEL_OVERLAPPING_FRAMES * FFT_HOP
MODEL_HOP_SIZE = MODEL_AUDIO_N_SAMPLES - MODEL_OVERLAP_LENGTH_SAMPLES
MODEL_ANNOTATIONS_FPS = BASIC_PITCH_SAMPLE_RATE // FFT_HOP
CONTOURS_BINS_PER_SEMITONE = 3
ANNOTATIONS_BASE_MIDI = 21
CONTOUR_DETECTION_THRESHOLD = 0.28


@dataclass
class BenchResult:
    runtime: str
    provider: str
    model_path: str
    runs: int
    warmups: int
    input_shape: Sequence[int]
    output_shape: Sequence[int]
    timings_ms: Dict[str, float]
    detections: int
    contour_frames: int


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--warmups", type=int, default=5)
    parser.add_argument("--window-seconds", type=float, default=2.4)
    parser.add_argument("--model", type=Path, default=None)
    parser.add_argument("--json", type=Path, default=Path("tmp/basic-pitch-runtime-bench.json"))
    parser.add_argument("--openvino-ir", type=Path, default=Path("tmp/basic_pitch_openvino_ir/nmp_fp32.xml"))
    parser.add_argument(
        "--runtime",
        choices=["all", "onnx", "openvino"],
        default="all",
        help="Runtime to benchmark.",
    )
    args = parser.parse_args()

    model_path = args.model or find_basic_pitch_onnx_model()
    if not model_path:
        print("Could not find a Basic Pitch ONNX model. Install basic-pitch[onnx] or pass --model.", file=sys.stderr)
        return 2

    audio = make_test_audio(args.window_seconds)
    framed = frame_basic_pitch_audio(audio)
    expected_frames = int(math.floor(audio.shape[0] * (MODEL_ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE)))

    results: List[BenchResult] = []
    if args.runtime in ("all", "onnx"):
        if importlib.util.find_spec("onnxruntime") is None:
            print("Skipping ONNX Runtime: package not installed.", file=sys.stderr)
        else:
            results.append(bench_onnxruntime(model_path, framed, expected_frames, args.runs, args.warmups))

    if args.runtime in ("all", "openvino"):
        if importlib.util.find_spec("openvino") is None:
            print("Skipping OpenVINO: package not installed.", file=sys.stderr)
        else:
            results.append(
                bench_openvino(
                    model_path,
                    framed,
                    expected_frames,
                    args.runs,
                    args.warmups,
                    runtime_name="openvino-onnx",
                )
            )
            ir_path = ensure_openvino_ir(model_path, args.openvino_ir)
            results.append(
                bench_openvino(
                    ir_path,
                    framed,
                    expected_frames,
                    args.runs,
                    args.warmups,
                    runtime_name="openvino-ir",
                )
            )

    payload = {
        "python": sys.version,
        "model_path": str(model_path),
        "audio_seconds": args.window_seconds,
        "audio_samples": int(audio.shape[0]),
        "framed_shape": list(framed.shape),
        "expected_contour_frames": expected_frames,
        "results": [result.__dict__ for result in results],
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(format_summary(payload))
    print(f"\nWrote {args.json}")
    return 0 if results else 1


def find_basic_pitch_onnx_model() -> Optional[Path]:
    try:
        import basic_pitch  # type: ignore
    except Exception:
        return None

    root = Path(basic_pitch.__file__).resolve().parent
    candidates = sorted(root.rglob("*.onnx"))
    if candidates:
        preferred = [path for path in candidates if "icassp" in str(path).lower()]
        return preferred[0] if preferred else candidates[0]
    return None


def make_test_audio(window_seconds: float) -> np.ndarray:
    sample_count = int(round(window_seconds * BASIC_PITCH_SAMPLE_RATE))
    t = np.arange(sample_count, dtype=np.float32) / BASIC_PITCH_SAMPLE_RATE
    # A deterministic rising pitch plus a quieter harmonic to mimic the contour
    # ambiguity we care about in the probe.
    start_hz = 146.83
    end_hz = 293.66
    sweep = start_hz * np.power(end_hz / start_hz, t / max(t[-1], 1e-6))
    phase = 2 * np.pi * np.cumsum(sweep) / BASIC_PITCH_SAMPLE_RATE
    audio = 0.55 * np.sin(phase) + 0.12 * np.sin(phase * 2.0)
    envelope = np.minimum(1.0, np.arange(sample_count, dtype=np.float32) / (0.03 * BASIC_PITCH_SAMPLE_RATE))
    audio *= envelope
    return audio.astype(np.float32)


def frame_basic_pitch_audio(audio: np.ndarray) -> np.ndarray:
    prefix = np.zeros(MODEL_OVERLAP_LENGTH_SAMPLES // 2, dtype=np.float32)
    wav = np.concatenate([prefix, audio.astype(np.float32)])
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


def bench_onnxruntime(
    model_path: Path,
    framed: np.ndarray,
    expected_frames: int,
    runs: int,
    warmups: int,
) -> BenchResult:
    import onnxruntime as ort  # type: ignore

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    contour_output = choose_contour_output(session.get_outputs())

    def run_once() -> Tuple[np.ndarray, Dict[str, float]]:
        started = time.perf_counter()
        outputs = session.run([contour_output.name], {input_name: framed})
        infer_ms = elapsed_ms(started)
        unwrap_started = time.perf_counter()
        contours = unwrap_contour_output(outputs[0], expected_frames)
        unwrap_ms = elapsed_ms(unwrap_started)
        post_started = time.perf_counter()
        detections = count_contour_peaks(contours)
        post_ms = elapsed_ms(post_started)
        return contours, {"inference": infer_ms, "unwrap": unwrap_ms, "postprocess": post_ms, "detections": detections}

    timings, contours, detections = run_benchmark(run_once, runs, warmups)
    return BenchResult(
        runtime="onnxruntime",
        provider="CPUExecutionProvider",
        model_path=str(model_path),
        runs=runs,
        warmups=warmups,
        input_shape=framed.shape,
        output_shape=contours.shape,
        timings_ms=timings,
        detections=detections,
        contour_frames=int(contours.shape[0]),
    )


def bench_openvino(
    model_path: Path,
    framed: np.ndarray,
    expected_frames: int,
    runs: int,
    warmups: int,
    runtime_name: str,
) -> BenchResult:
    from openvino import Core  # type: ignore

    core = Core()
    model = core.read_model(str(model_path))
    compiled = core.compile_model(model, "CPU")
    input_port = compiled.inputs[0]
    contour_output = choose_openvino_contour_output(compiled.outputs)
    request = compiled.create_infer_request()

    def run_once() -> Tuple[np.ndarray, Dict[str, float]]:
        started = time.perf_counter()
        request.infer({input_port: framed})
        raw = request.get_tensor(contour_output).data
        infer_ms = elapsed_ms(started)
        unwrap_started = time.perf_counter()
        contours = unwrap_contour_output(np.asarray(raw), expected_frames)
        unwrap_ms = elapsed_ms(unwrap_started)
        post_started = time.perf_counter()
        detections = count_contour_peaks(contours)
        post_ms = elapsed_ms(post_started)
        return contours, {"inference": infer_ms, "unwrap": unwrap_ms, "postprocess": post_ms, "detections": detections}

    timings, contours, detections = run_benchmark(run_once, runs, warmups)
    return BenchResult(
        runtime=runtime_name,
        provider="CPU",
        model_path=str(model_path),
        runs=runs,
        warmups=warmups,
        input_shape=framed.shape,
        output_shape=contours.shape,
        timings_ms=timings,
        detections=detections,
        contour_frames=int(contours.shape[0]),
    )


def ensure_openvino_ir(model_path: Path, output_xml: Path) -> Path:
    if output_xml.exists() and output_xml.with_suffix(".bin").exists():
        return output_xml

    from openvino import convert_model, save_model  # type: ignore

    output_xml.parent.mkdir(parents=True, exist_ok=True)
    converted = convert_model(str(model_path))
    save_model(converted, str(output_xml), compress_to_fp16=False)
    return output_xml


def run_benchmark(
    run_once: Callable[[], Tuple[np.ndarray, Dict[str, float]]],
    runs: int,
    warmups: int,
) -> Tuple[Dict[str, float], np.ndarray, int]:
    contours: Optional[np.ndarray] = None
    detections = 0
    for _ in range(warmups):
        contours, measures = run_once()
        detections = int(measures["detections"])

    samples: Dict[str, List[float]] = {}
    for _ in range(runs):
        contours, measures = run_once()
        detections = int(measures["detections"])
        for key, value in measures.items():
            if key == "detections":
                continue
            samples.setdefault(key, []).append(float(value))

    assert contours is not None
    timings = {}
    total_values = [sum(values) for values in zip(*samples.values())] if samples else []
    for key, values in samples.items():
        timings[f"{key}_median"] = statistics.median(values)
        timings[f"{key}_mean"] = statistics.fmean(values)
        timings[f"{key}_min"] = min(values)
        timings[f"{key}_max"] = max(values)
    if total_values:
        timings["total_median"] = statistics.median(total_values)
        timings["total_mean"] = statistics.fmean(total_values)
    return timings, contours, detections


def choose_contour_output(outputs: Sequence[Any]) -> Any:
    for output in outputs:
        shape = [dim if isinstance(dim, int) else None for dim in output.shape]
        if shape and shape[-1] == 264:
            return output
    for output in outputs:
        if "contour" in output.name.lower():
            return output
    raise RuntimeError(f"Could not identify contour output from {[output.name for output in outputs]}")


def choose_openvino_contour_output(outputs: Sequence[Any]) -> Any:
    for output in outputs:
        shape = list(output.partial_shape)
        last = shape[-1] if shape else None
        if last is not None and last.is_static and int(last.get_length()) == 264:
            return output
    for output in outputs:
        names = {str(name).lower() for name in output.names}
        if any("contour" in name for name in names):
            return output
    raise RuntimeError("Could not identify OpenVINO contour output.")


def unwrap_contour_output(raw: np.ndarray, expected_frames: int) -> np.ndarray:
    # Raw output is [batch, 172, 264]. Match Basic Pitch JS/Python behavior by
    # dropping overlap frames from each batch, then clipping to original audio.
    trimmed = raw[:, MODEL_OVERLAP_HALF_FRAMES : raw.shape[1] - MODEL_OVERLAP_HALF_FRAMES, :]
    unwrapped = trimmed.reshape((-1, trimmed.shape[-1]))
    return np.ascontiguousarray(unwrapped[:expected_frames])


def count_contour_peaks(contours: np.ndarray) -> int:
    count = 0
    for row in contours:
        center = row[1:-1]
        mask = (
            (center >= CONTOUR_DETECTION_THRESHOLD)
            & (center >= row[:-2])
            & (center >= row[2:])
        )
        if np.any(mask):
            bins = np.nonzero(mask)[0] + 1
            midi = ANNOTATIONS_BASE_MIDI + bins / CONTOURS_BINS_PER_SEMITONE
            freq = 440.0 * np.power(2.0, (midi - 69.0) / 12.0)
            count += int(np.count_nonzero((freq >= 180.0) & (freq <= 2800.0)))
    return count


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000.0


def format_summary(payload: Dict[str, Any]) -> str:
    lines = [
        "Basic Pitch Runtime Benchmark",
        f"model: {payload['model_path']}",
        f"input: {payload['audio_seconds']}s, frames {payload['framed_shape']}",
        "",
    ]
    for result in payload["results"]:
        timings = result["timings_ms"]
        lines.append(f"{result['runtime']} ({result['provider']})")
        lines.append(f"  total median: {timings.get('total_median', 0):.2f} ms")
        lines.append(f"  inference median: {timings.get('inference_median', 0):.2f} ms")
        lines.append(f"  unwrap median: {timings.get('unwrap_median', 0):.2f} ms")
        lines.append(f"  postprocess median: {timings.get('postprocess_median', 0):.2f} ms")
        lines.append(f"  detections: {result['detections']}, contour frames: {result['contour_frames']}")
        lines.append("")
    return "\n".join(lines).rstrip()


if __name__ == "__main__":
    raise SystemExit(main())
