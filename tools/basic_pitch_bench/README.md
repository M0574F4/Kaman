# Basic Pitch Runtime Benchmark

Benchmarks local Basic Pitch runtimes on the same deterministic 2.4 second input
window used by the AI Probe experiments.

## Setup

```bash
/home/idlab340/.pyenv/versions/3.9.19/bin/python -m venv tools/basic_pitch_bench/.venv
tools/basic_pitch_bench/.venv/bin/python -m pip install -r tools/basic_pitch_bench/requirements.txt
```

## Run

```bash
tools/basic_pitch_bench/.venv/bin/python tools/basic_pitch_bench/bench_basic_pitch_runtimes.py \
  --runs 30 \
  --warmups 8 \
  --json tmp/basic-pitch-runtime-bench.json
```

The script benchmarks:

- `onnxruntime` using `CPUExecutionProvider`
- `openvino-onnx`, where OpenVINO reads the ONNX model directly
- `openvino-ir`, where the ONNX model is converted to FP32 OpenVINO IR first

The OpenVINO IR conversion intentionally uses `compress_to_fp16=False` so contour
threshold behavior matches ONNX more closely.

## First Result On This Machine

Input: `2.4s`, framed as `[2, 43844, 1]`, output clipped to `206` contour frames.

| Runtime | Inference Median | Total Median | Detections |
| --- | ---: | ---: | ---: |
| ONNX Runtime CPU | 32.19 ms | 36.54 ms | 157 |
| OpenVINO from ONNX CPU | 17.42 ms | 20.87 ms | 157 |
| OpenVINO IR FP32 CPU | 17.86 ms | 21.26 ms | 157 |

OpenVINO CPU is about `1.7x` faster than ONNX Runtime CPU for this contour-only
Basic Pitch benchmark on the tested machine.
