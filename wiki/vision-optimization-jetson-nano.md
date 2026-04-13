# Vision Optimization Options for Jetson Nano 4GB

## Constraints
- Device: Jetson Nano 4GB in 5W mode.
- Current pressure: CPU and RAM are close to full.
- Goal: Better object detection quality while still feeding reliable context to the LLM.

## Best Practical Options (Ranked)

1. Optimized YOLOv5n/YOLOv5nu with temporal filtering (implemented now)
- Why: Lowest migration risk, immediate gains in accuracy stability and lower prompt noise.
- Changes:
  - Lower compute load via `imgsz=320`, `vid_stride`, `max_det`.
  - Better precision via higher confidence threshold.
  - Temporal smoothing window to suppress flicker/false positives.
  - Compact object summary passed to LLM (`objects(person=1,chair=1)`).
- Tradeoff: Still Python + Ultralytics overhead.

2. TensorRT-exported detector on Jetson (recommended next)
- Why: Best speed-per-watt on Nano vs plain PyTorch inference.
- Flow:
  - Export model to ONNX.
  - Build TensorRT engine with FP16.
  - Run inference with TensorRT runtime (or DeepStream if preferred).
- Expected impact:
  - Lower CPU usage, faster inference, more stable frame times.
- Tradeoff: Higher setup complexity.

3. DeepStream pipeline (if you want production-grade streaming)
- Why: Efficient decode + batching + tracking pipeline on NVIDIA hardware.
- Best when:
  - Multiple streams/cameras, strict latency budgets, robust deployment.
- Tradeoff: Steeper learning curve and config complexity.

## What to Avoid on Nano 4GB
- Large models (YOLOv8m/l/x) in this memory profile.
- Running STT + TTS + full-rate vision + LLM all at max quality concurrently.
- Very low confidence threshold (causes noisy detections and bad LLM context).

## Recommended Operating Profile
- Vision cadence: 4 to 8 FPS effective (not 30 FPS) for conversational robotics.
- Input size: 320 (or 416 if quality is still weak and RAM allows).
- Confidence: 0.30 to 0.40.
- Temporal smoothing: 5 to 8 frames.
- LLM context: Top 3 to 5 stable object classes only.

## Validation Checklist
- Compare before/after for:
  - False positive rate in cluttered room.
  - Miss rate for person/chair/bottle at normal distance.
  - Average inference time (`/scene` returns `inference_ms`).
  - LLM response relevance with camera context included.

## Next Migration Milestone
If quality is still insufficient after the current optimization, move to TensorRT as the next step (not larger YOLO models).
