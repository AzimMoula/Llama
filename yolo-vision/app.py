from collections import Counter, deque
from flask import Flask, jsonify
import glob
import io
import json
import logging
import os
import re
import sys
import threading
import time
import cv2

from ultralytics import YOLO
try:
    from ultralytics.utils import LOGGER as ultralytics_logger
except Exception:
    ultralytics_logger = None

try:
    import torch
except Exception:
    torch = None

# Suppress verbose YOLO / ultralytics logging
logging.getLogger("ultralytics").setLevel(logging.WARNING)
logging.getLogger("torch").setLevel(logging.WARNING)
logging.getLogger("PIL").setLevel(logging.WARNING)
if ultralytics_logger is not None:
    ultralytics_logger.setLevel(logging.ERROR)

app = Flask(__name__)

MODEL_PATH = os.getenv("YOLO_MODEL", "yolov5nu.pt")
CONFIDENCE = float(os.getenv("YOLO_CONF", "0.3"))
IOU = float(os.getenv("YOLO_IOU", "0.45"))
IMG_SIZE = int(os.getenv("YOLO_IMGSZ", "320"))
MAX_DET = int(os.getenv("YOLO_MAX_DET", "12"))
VID_STRIDE = int(os.getenv("YOLO_VID_STRIDE", "4"))
POLL_SLEEP = float(os.getenv("YOLO_LOOP_SLEEP", "0.15"))
WINDOW_SIZE = int(os.getenv("YOLO_WINDOW", "6"))
MIN_APPEAR_RATIO = float(os.getenv("YOLO_MIN_APPEAR_RATIO", "0.45"))
UPDATE_FPS = float(os.getenv("YOLO_UPDATE_FPS", "2.0"))
UPDATE_INTERVAL = (1.0 / UPDATE_FPS) if UPDATE_FPS > 0 else 0.0
# Extra pause for manual testing so scene updates are easier to inspect.
TEST_HOLD_SECONDS = float(os.getenv("YOLO_TEST_HOLD_SECONDS", "0.5"))
CAMERA_RETRY_SECONDS = float(os.getenv("YOLO_CAMERA_RETRY_SECONDS", "2.0"))
CAMERA_FAILURE_LOG_INTERVAL = float(os.getenv("YOLO_CAMERA_FAILURE_LOG_INTERVAL", "5.0"))
CAPTURE_WIDTH = int(os.getenv("YOLO_CAPTURE_WIDTH", "640"))
CAPTURE_HEIGHT = int(os.getenv("YOLO_CAPTURE_HEIGHT", "480"))
CAPTURE_FPS = float(os.getenv("YOLO_CAPTURE_FPS", "30"))


def _parse_camera_source(raw: str):
    value = raw.strip().strip('"').strip("'")
    if not value:
        return None
    if value.isdigit():
        return int(value)
    return value


_camera_sources_env = os.getenv("YOLO_CAMERA_SOURCES", "0,1,/dev/video0,/dev/video1").strip()
_camera_source_items = []
if _camera_sources_env.startswith("["):
    try:
        loaded = json.loads(_camera_sources_env)
        if isinstance(loaded, list):
            _camera_source_items = [str(item) for item in loaded]
    except Exception:
        _camera_source_items = []

if not _camera_source_items:
    delimiter = ";" if ";" in _camera_sources_env else ","
    _camera_source_items = [item.strip() for item in _camera_sources_env.split(delimiter) if item.strip()]

CAMERA_SOURCES = [
    parsed
    for parsed in (_parse_camera_source(item) for item in _camera_source_items)
    if parsed is not None
]


def _append_discovered_camera_sources(sources):
    # Merge env-configured sources with currently visible /dev/video* devices.
    # This avoids hard failures when YOLO_CAMERA_SOURCES is set to a single index
    # but the active camera is exposed on another index (common on SBCs/USB cams).
    merged = list(sources)
    seen = {str(item) for item in merged}
    discovered_nodes = sorted(glob.glob("/dev/video*"))

    for node in discovered_nodes:
        if node not in seen:
            merged.append(node)
            seen.add(node)

        match = re.search(r"(\d+)$", node)
        if match:
            idx = int(match.group(1))
            if str(idx) not in seen:
                merged.append(idx)
                seen.add(str(idx))

    return merged


CAMERA_SOURCES = _append_discovered_camera_sources(CAMERA_SOURCES)
if not CAMERA_SOURCES:
    CAMERA_SOURCES = [0]


def _source_exists(source) -> bool:
    # Integer sources map to /dev/videoN on Linux/OpenCV V4L2.
    if isinstance(source, int):
        return os.path.exists(f"/dev/video{source}")
    # For path sources, let OpenCV try opening even if exists checks are flaky.
    # This avoids false negatives from transient device node races.
    if isinstance(source, str) and source.startswith("/dev/"):
        return True
    # For URLs / pipelines we cannot pre-validate here.
    return True


def _list_visible_video_nodes() -> str:
    nodes = sorted(glob.glob("/dev/video*"))
    return ", ".join(nodes) if nodes else "none"


def _is_local_camera_source(source) -> bool:
    if isinstance(source, int):
        return True
    if isinstance(source, str) and source.startswith("/dev/video"):
        return True
    return False


def _open_local_capture(source):
    api = cv2.CAP_V4L2
    cap = None

    if isinstance(source, int):
        cap = cv2.VideoCapture(source, api)
        if not cap.isOpened():
            cap.release()
            cap = cv2.VideoCapture(f"/dev/video{source}", api)
    else:
        cap = cv2.VideoCapture(source, api)

    if cap and cap.isOpened():
        # Keep capture latency low on embedded devices.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)
    return cap


def _iter_local_camera_results(source):
    warmup_frames = max(0, int(os.getenv("YOLO_CAMERA_WARMUP_FRAMES", "5")))
    max_read_failures = max(1, int(os.getenv("YOLO_CAMERA_MAX_READ_FAILURES", "8")))

    cap = _open_local_capture(source)
    if not cap or not cap.isOpened():
        raise RuntimeError(f"Unable to open camera source: {source}")

    try:
        for _ in range(warmup_frames):
            cap.read()

        read_failures = 0
        while True:
            ok, frame = cap.read()
            if not ok or frame is None or frame.size == 0:
                read_failures += 1
                if read_failures >= max_read_failures:
                    raise RuntimeError(f"Failed to read images from {source}")
                time.sleep(0.05)
                continue

            read_failures = 0
            predictions = model.predict(
                source=frame,
                show=False,
                conf=CONFIDENCE,
                iou=IOU,
                imgsz=IMG_SIZE,
                max_det=MAX_DET,
                device=DEVICE,
                half=USE_HALF,
                verbose=False,
            )
            if predictions:
                yield predictions[0]
    finally:
        cap.release()

# Optional HSV color detection that can be fused with YOLO detections.
COLOR_DETECTION = os.getenv("COLOR_DETECTION", "0").strip().lower() in {"1", "true", "yes", "on"}
COLOR_TARGETS = [
    c.strip().lower()
    for c in os.getenv("COLOR_TARGETS", "red,blue,green,yellow,orange").split(",")
    if c.strip()
]
COLOR_OBJECT_CLASSES = {
    c.strip().lower()
    for c in os.getenv("COLOR_OBJECT_CLASSES", "sports ball,bottle,cup").split(",")
    if c.strip()
}
COLOR_MIN_PIXELS = int(os.getenv("COLOR_MIN_PIXELS", "120"))
COLOR_MIN_RATIO = float(os.getenv("COLOR_MIN_RATIO", "0.08"))
COLOR_DOMINANCE = float(os.getenv("COLOR_DOMINANCE", "1.25"))
COLOR_MIN_SAT = int(os.getenv("COLOR_MIN_SAT", "70"))
COLOR_MIN_VAL = int(os.getenv("COLOR_MIN_VAL", "60"))
COLOR_CENTER_CROP = float(os.getenv("COLOR_CENTER_CROP", "0.7"))
COLOR_FALLBACK_CLASSES = {
    c.strip().lower()
    for c in os.getenv("COLOR_FALLBACK_CLASSES", "sports ball").split(",")
    if c.strip()
}
COLOR_FALLBACK_MIN_PIXELS = int(os.getenv("COLOR_FALLBACK_MIN_PIXELS", "25"))
COLOR_FALLBACK_MIN_RATIO = float(os.getenv("COLOR_FALLBACK_MIN_RATIO", "0.02"))
COLOR_WINDOW = int(os.getenv("COLOR_WINDOW", "8"))
COLOR_MIN_APPEAR_RATIO = float(os.getenv("COLOR_MIN_APPEAR_RATIO", "0.4"))

# Optional class filter. Leave YOLO_ALLOWED_CLASSES empty to allow all classes.
# Example: YOLO_ALLOWED_CLASSES=person,chair,table,bottle,sports ball
allowed_classes_env = os.getenv("YOLO_ALLOWED_CLASSES", "").strip()
ALLOWED_CLASSES = {
    c.strip().lower()
    for c in allowed_classes_env.split(",")
    if c.strip()
}


def _select_device() -> str:
    if torch is not None:
        try:
            if torch.cuda.is_available():
                return "0"
        except Exception:
            pass
    return "cpu"


DEVICE = _select_device()
USE_HALF = DEVICE != "cpu"
model = YOLO(MODEL_PATH)

# Shared variable
latest_scene = "Vision system initializing..."
latest_payload = {
    "scene": latest_scene,
    "objects": [],
    "color_observations": [],
    "inference_ms": None,
    "device": DEVICE,
    "pipeline_fps": None,
}
scene_lock = threading.Lock()
history = deque(maxlen=max(1, WINDOW_SIZE))
color_history = deque(maxlen=max(1, COLOR_WINDOW))


DEFAULT_COLOR_RANGES = {
    "red": [((0, 120, 70), (10, 255, 255)), ((170, 120, 70), (180, 255, 255))],
    "blue": [((100, 120, 70), (140, 255, 255))],
    "green": [((35, 80, 60), (85, 255, 255))],
    "yellow": [((20, 100, 100), (35, 255, 255))],
    "orange": [((8, 110, 90), (22, 255, 255))],
}


def _parse_hsv_triplet(text: str):
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 3:
        return None
    try:
        return tuple(max(0, int(v)) for v in parts)
    except Exception:
        return None


def _load_color_ranges():
    ranges = {}
    for color_name, default_ranges in DEFAULT_COLOR_RANGES.items():
        env_name = f"HSV_{color_name.upper()}_RANGES"
        raw = os.getenv(env_name, "").strip()
        if not raw:
            ranges[color_name] = default_ranges
            continue

        parsed_ranges = []
        # Format: "H,S,V-H,S,V;H,S,V-H,S,V"
        for segment in [s.strip() for s in raw.split(";") if s.strip()]:
            if "-" not in segment:
                continue
            low_raw, high_raw = segment.split("-", 1)
            low = _parse_hsv_triplet(low_raw)
            high = _parse_hsv_triplet(high_raw)
            if low and high:
                parsed_ranges.append((low, high))

        ranges[color_name] = parsed_ranges if parsed_ranges else default_ranges
    return ranges


COLOR_RANGES = _load_color_ranges()


def _center_crop(roi, crop_ratio: float):
    if roi is None or roi.size == 0:
        return roi
    ratio = max(0.3, min(crop_ratio, 1.0))
    if ratio >= 0.999:
        return roi

    h, w = roi.shape[:2]
    cw = max(1, int(w * ratio))
    ch = max(1, int(h * ratio))
    x1 = max(0, (w - cw) // 2)
    y1 = max(0, (h - ch) // 2)
    x2 = min(w, x1 + cw)
    y2 = min(h, y1 + ch)
    return roi[y1:y2, x1:x2]


def _counts_from_result(result):
    counts = Counter()
    if not hasattr(result, "boxes") or len(result.boxes) == 0:
        return counts

    for box in result.boxes:
        cls_id = int(box.cls[0])
        label = model.names.get(cls_id, str(cls_id))
        if ALLOWED_CLASSES and label.lower() not in ALLOWED_CLASSES:
            continue
        counts[label] += 1
    return counts


def _extract_color_observations(result):
    if not COLOR_DETECTION:
        return []
    if not hasattr(result, "orig_img"):
        return []
    if not hasattr(result, "boxes") or len(result.boxes) == 0:
        return []

    frame = result.orig_img
    if frame is None:
        return []

    observations = []
    frame_h, frame_w = frame.shape[:2]

    for box in result.boxes:
        cls_id = int(box.cls[0])
        label = model.names.get(cls_id, str(cls_id))
        label_lower = label.lower()
        if ALLOWED_CLASSES and label.lower() not in ALLOWED_CLASSES:
            continue
        if COLOR_OBJECT_CLASSES and label_lower not in COLOR_OBJECT_CLASSES:
            continue

        x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
        x1 = max(0, min(x1, frame_w - 1))
        x2 = max(0, min(x2, frame_w))
        y1 = max(0, min(y1, frame_h - 1))
        y2 = max(0, min(y2, frame_h))
        if x2 <= x1 or y2 <= y1:
            continue

        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            continue

        roi = _center_crop(roi, COLOR_CENTER_CROP)
        if roi.size == 0:
            continue

        hsv_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        valid_sv_mask = cv2.inRange(
            hsv_roi,
            (0, max(0, COLOR_MIN_SAT), max(0, COLOR_MIN_VAL)),
            (180, 255, 255),
        )
        valid_pixels = int(cv2.countNonZero(valid_sv_mask))
        if valid_pixels <= 0:
            continue

        color_scores = []

        for color_name in COLOR_TARGETS:
            color_ranges = COLOR_RANGES.get(color_name)
            if not color_ranges:
                continue

            mask = None
            for low, high in color_ranges:
                low_np = tuple(int(v) for v in low)
                high_np = tuple(int(v) for v in high)
                part = cv2.inRange(hsv_roi, low_np, high_np)
                mask = part if mask is None else cv2.bitwise_or(mask, part)

            if mask is None:
                continue

            # Remove low-saturation and low-value pixels to avoid gray/background bleed.
            mask = cv2.bitwise_and(mask, valid_sv_mask)
            # Light morphology cleanup reduces speckle noise.
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

            pixels = int(cv2.countNonZero(mask))
            ratio = pixels / float(valid_pixels)
            color_scores.append((color_name, pixels, ratio))

        if not color_scores:
            continue

        color_scores.sort(key=lambda item: item[1], reverse=True)
        best_color, best_pixels, best_ratio = color_scores[0]
        second_pixels = color_scores[1][1] if len(color_scores) > 1 else 0
        dominance_ok = (second_pixels <= 0) or (best_pixels >= (second_pixels * COLOR_DOMINANCE))

        strict_ok = dominance_ok and best_pixels >= COLOR_MIN_PIXELS and best_ratio >= COLOR_MIN_RATIO
        fallback_ok = (
            label_lower in COLOR_FALLBACK_CLASSES
            and best_pixels >= COLOR_FALLBACK_MIN_PIXELS
            and best_ratio >= COLOR_FALLBACK_MIN_RATIO
        )

        if strict_ok or fallback_ok:
            observations.append(
                {
                    "name": label,
                    "color": best_color,
                    "pixel_ratio": round(best_ratio, 3),
                    "bbox": [x1, y1, x2, y2],
                }
            )

    return observations


def _smooth_counts() -> Counter:
    if not history:
        return Counter()

    total_frames = len(history)
    class_presence = Counter()
    sum_counts = Counter()

    for frame_counts in history:
        for cls_name, count in frame_counts.items():
            class_presence[cls_name] += 1
            sum_counts[cls_name] += count

    stable = Counter()
    for cls_name, seen_frames in class_presence.items():
        if (seen_frames / total_frames) >= MIN_APPEAR_RATIO:
            # Average only across frames where the class was present, so multi-object
            # counts are not reduced by temporary misses in other frames.
            stable[cls_name] = max(1, round(sum_counts[cls_name] / seen_frames))
    return stable


def _best_color_by_name(color_observations):
    best = {}
    for obs in color_observations:
        name = obs.get("name")
        color = obs.get("color")
        ratio = float(obs.get("pixel_ratio", 0.0))
        if not name or not color:
            continue
        prev = best.get(name)
        if prev is None or ratio > prev[1]:
            best[name] = (color, ratio)
    return best


def _smooth_color_map() -> dict:
    if not color_history:
        return {}

    total_frames = len(color_history)
    name_frame_presence = Counter()
    color_votes = {}

    for frame_map in color_history:
        for name, (color, ratio) in frame_map.items():
            name_frame_presence[name] += 1
            bucket = color_votes.setdefault(name, {})
            if color not in bucket:
                bucket[color] = [0, 0.0]
            bucket[color][0] += 1
            bucket[color][1] += ratio

    smoothed = {}
    for name, seen_frames in name_frame_presence.items():
        if (seen_frames / total_frames) < COLOR_MIN_APPEAR_RATIO:
            continue

        candidates = color_votes.get(name, {})
        if not candidates:
            continue

        best_color = max(
            candidates.items(),
            key=lambda item: (item[1][0], item[1][1] / max(1, item[1][0])),
        )[0]
        smoothed[name] = best_color

    return smoothed


def _build_scene_text(counts: Counter, color_by_name=None) -> str:
    if not counts:
        return "I see no stable objects right now."

    color_by_name = color_by_name or {}

    # Keep summary short for the LLM context window.
    top_items = counts.most_common(5)
    parts = []
    for name, count in top_items:
        color = color_by_name.get(name)
        if color:
            parts.append(f"{count} {color} {name}")
        else:
            parts.append(f"{count} {name}")
    object_text = ", ".join(parts)
    return f"Currently in view: {object_text}."


def vision_loop():
    global latest_scene, latest_payload
    last_publish_ts = 0.0
    ema_pipeline_fps = 0.0
    frame_counter = 0

    old_stdout = sys.stdout
    old_stderr = sys.stderr
    last_source_error_log = {}
    last_no_camera_log = 0.0

    def user_print(msg: str) -> None:
        old_stdout.write(msg + "\n")
        old_stdout.flush()

    def has_stable_scene() -> bool:
        with scene_lock:
            scene = str(latest_payload.get("scene", "") or "")
            objects = latest_payload.get("objects") or []
        unavailable_tokens = (
            "camera unavailable",
            "no camera stream",
            "retrying camera sources",
            "vision error",
            "initializing",
        )
        return bool(objects) and not any(token in scene.lower() for token in unavailable_tokens)

    try:
        # Suppress YOLO verbose output for the whole streaming loop.
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()

        while True:
            stream_started = False
            for source in CAMERA_SOURCES:
                try:
                    now = time.monotonic()
                    if not _source_exists(source):
                        prev_log = last_source_error_log.get(source, 0.0)
                        if (now - prev_log) >= CAMERA_FAILURE_LOG_INTERVAL:
                            user_print(
                                f"[VISION] Skipping unavailable source: {source} | visible nodes: {_list_visible_video_nodes()}"
                            )
                            last_source_error_log[source] = now
                        continue

                    user_print(f"[VISION] Trying camera source: {source}")
                    # For local cameras, use direct OpenCV capture for better V4L2 stability.
                    if _is_local_camera_source(source):
                        results = _iter_local_camera_results(source)
                    else:
                        # stream=True keeps camera ownership in one loop and avoids open/close races.
                        results = model.predict(
                            source=source,
                            show=False,
                            stream=True,
                            conf=CONFIDENCE,
                            iou=IOU,
                            imgsz=IMG_SIZE,
                            max_det=MAX_DET,
                            vid_stride=VID_STRIDE,
                            device=DEVICE,
                            half=USE_HALF,
                            verbose=False,
                        )

                    source_is_active = False

                    for result in results:
                        if not source_is_active:
                            source_is_active = True
                            stream_started = True
                            user_print(f"[VISION] Camera stream active on source: {source}")

                        frame_counter += 1
                        now = time.monotonic()

                        infer_ms = None
                        if hasattr(result, "speed") and isinstance(result.speed, dict):
                            infer_ms = result.speed.get("inference")

                        frame_counts = _counts_from_result(result)
                        color_observations = _extract_color_observations(result)
                        frame_color_map = _best_color_by_name(color_observations)
                        color_history.append(frame_color_map)
                        color_by_name = _smooth_color_map()
                        history.append(frame_counts)
                        stable_counts = _smooth_counts()

                        latest_scene = _build_scene_text(stable_counts, color_by_name)
                        objects = [
                            {
                                "name": name,
                                "count": count,
                                "color": color_by_name.get(name),
                            }
                            for name, count in stable_counts.most_common(8)
                        ]

                        # Publish at a controlled cadence so humans can inspect detections.
                        if UPDATE_INTERVAL > 0 and (now - last_publish_ts) < UPDATE_INTERVAL:
                            if POLL_SLEEP > 0:
                                time.sleep(POLL_SLEEP)
                            continue

                        if last_publish_ts > 0:
                            dt = max(1e-6, now - last_publish_ts)
                            inst_fps = 1.0 / dt
                            # Smooth measured rate to avoid noisy jumps.
                            ema_pipeline_fps = (0.8 * ema_pipeline_fps) + (0.2 * inst_fps) if ema_pipeline_fps > 0 else inst_fps

                        last_publish_ts = now

                        with scene_lock:
                            latest_payload = {
                                "scene": latest_scene,
                                "objects": objects,
                                "color_observations": color_observations,
                                "inference_ms": infer_ms,
                                "device": DEVICE,
                                "pipeline_fps": round(ema_pipeline_fps, 2) if ema_pipeline_fps > 0 else None,
                            }

                        # Print clear terminal output for human inspection
                        user_print("\n" + "=" * 70)
                        user_print(f"[DETECTION #{frame_counter}] {latest_scene}")
                        if objects:
                            object_summary = ", ".join(
                                (
                                    f"{obj['name']}={obj['count']}(color={obj['color']})"
                                    if obj.get("color")
                                    else f"{obj['name']}={obj['count']}"
                                )
                                for obj in objects
                            )
                            user_print(f"[OBJECTS] {object_summary}")
                        if infer_ms is not None:
                            user_print(f"[INFERENCE] {infer_ms:.1f}ms | [FPS] {ema_pipeline_fps:.1f}")
                        if color_observations:
                            color_summary = ", ".join(
                                f"{name}->{color}" for name, color in color_by_name.items()
                            )
                            user_print(f"[COLORS] {color_summary}")
                        user_print("=" * 70)

                        if TEST_HOLD_SECONDS > 0:
                            user_print(f"[WAITING] {TEST_HOLD_SECONDS}s for you to view/place objects...")
                            time.sleep(TEST_HOLD_SECONDS)

                        time.sleep(POLL_SLEEP)

                    # If the generator exits, try reconnecting from the source list.
                    if source_is_active:
                        user_print(f"[VISION] Camera stream ended for source: {source}")
                    break

                except Exception as source_error:
                    now = time.monotonic()
                    prev_log = last_source_error_log.get(source, 0.0)
                    if (now - prev_log) >= CAMERA_FAILURE_LOG_INTERVAL:
                        user_print(f"[VISION] Source {source} unavailable: {source_error}")
                        last_source_error_log[source] = now

            if not stream_started:
                # Preserve last good detections during temporary camera dropouts.
                if not has_stable_scene():
                    with scene_lock:
                        latest_scene = "Vision camera unavailable. Retrying camera sources..."
                        latest_payload = {
                            "scene": latest_scene,
                            "objects": [],
                            "color_observations": [],
                            "inference_ms": None,
                            "device": DEVICE,
                            "pipeline_fps": None,
                        }
                now = time.monotonic()
                if (now - last_no_camera_log) >= CAMERA_FAILURE_LOG_INTERVAL:
                    user_print(
                        f"[VISION] No camera stream available. Retrying in {CAMERA_RETRY_SECONDS:.1f}s | visible nodes: {_list_visible_video_nodes()}"
                    )
                    last_no_camera_log = now

            if CAMERA_RETRY_SECONDS > 0:
                time.sleep(CAMERA_RETRY_SECONDS)

    except Exception as e:
        with scene_lock:
            latest_scene = f"Vision Error: {str(e)}"
            latest_payload = {
                "scene": latest_scene,
                "objects": [],
                "color_observations": [],
                "inference_ms": None,
                "device": DEVICE,
                "pipeline_fps": None,
            }
        user_print(f"[VISION ERROR] {str(e)}")
    finally:
        # Ensure stdout/stderr are restored even if exception occurs
        sys.stdout = old_stdout
        sys.stderr = old_stderr

# Start the thread
thread = threading.Thread(target=vision_loop, daemon=True)
thread.start()

@app.route('/scene')
def get_scene():
    with scene_lock:
        return jsonify(latest_payload)


@app.route('/health')
def health():
    return jsonify({"status": "ok", "device": DEVICE, "model": MODEL_PATH})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)