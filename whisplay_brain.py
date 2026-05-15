# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false

import argparse
import os
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import requests  # type: ignore[reportMissingImports]
import serial  # type: ignore[reportMissingImports]


DEFAULT_BAUD_RATE = int(os.getenv("ARDUINO_BAUD_RATE", "115200"))
DEFAULT_COMMAND_TIMEOUT_SEC = float(os.getenv("ARDUINO_COMMAND_TIMEOUT_SEC", "8.0"))
DEFAULT_VISION_TIMEOUT_SEC = float(os.getenv("VISION_API_TIMEOUT_SEC", "2.0"))
DEFAULT_VISION_API_URL = os.getenv("VISION_API_URL", "http://yolo-vision:5000/scene")
DEFAULT_CAMERA_WIDTH = float(os.getenv("VISION_CAMERA_WIDTH", "640"))
DEFAULT_CENTER_DEADZONE = float(os.getenv("VISION_CENTER_DEADZONE", "0.15"))
DEFAULT_SEARCH_TURN_DEG = float(os.getenv("VISION_SEARCH_TURN_DEG", "15.0"))
DEFAULT_SEARCH_FULL_ROTATIONS = float(os.getenv("VISION_SEARCH_FULL_ROTATIONS", "2.0"))


def _normalize_name(value: str) -> str:
    return " ".join((value or "").strip().lower().replace("_", " ").split())


def _port_candidates() -> Iterable[str]:
    explicit = (os.getenv("ARDUINO_PORT") or "").strip()
    if explicit:
        yield explicit
    candidates_raw = os.getenv("ARDUINO_PORT_CANDIDATES", "/dev/ttyACM0,/dev/ttyUSB0")
    seen: Set[str] = set()
    for item in candidates_raw.split(","):
        port = item.strip()
        if not port or port in seen:
            continue
        seen.add(port)
        yield port


def _open_arduino() -> serial.Serial:
    last_error: Optional[Exception] = None
    for port in _port_candidates():
        try:
            print(f"[NAV] Connecting to Arduino on {port}...")
            conn = serial.Serial(port, DEFAULT_BAUD_RATE, timeout=1)
            # Many Arduino boards reset on serial open; give firmware time to boot.
            time.sleep(2.0)
            try:
                conn.reset_input_buffer()
                conn.reset_output_buffer()
            except Exception:
                pass
            print(f"[NAV] Arduino connection established on {port}.")
            return conn
        except Exception as exc:  # pragma: no cover - hardware path
            last_error = exc
            print(f"[NAV] Failed on {port}: {exc}")
    raise RuntimeError(f"Unable to connect to Arduino. Last error: {last_error}")


def _format_command_value(value: float) -> str:
    rounded = round(value)
    if abs(value - rounded) < 1e-6:
        return str(int(rounded))
    return f"{value:.1f}".rstrip("0").rstrip(".")


def _send_command(arduino: serial.Serial, command: str, value: float) -> bool:
    payload = f"{command}:{_format_command_value(value)}\n"
    print(f"[NAV] -> {payload.strip()}")
    arduino.write(payload.encode("utf-8"))
    arduino.flush()

    deadline = time.time() + DEFAULT_COMMAND_TIMEOUT_SEC
    while time.time() < deadline:
        if arduino.in_waiting > 0:
            response = arduino.readline().decode("utf-8", errors="ignore").strip()
            if response:
                print(f"[NAV] <- {response}")
            if response.upper() == "DONE":
                return True
        time.sleep(0.01)

    print("[NAV] Movement command timeout; continuing with failsafe.")
    return False


def _fetch_vision(vision_url: str) -> Optional[Dict[str, Any]]:
    try:
        response = requests.get(vision_url, timeout=DEFAULT_VISION_TIMEOUT_SEC)
        if response.status_code == 200:
            return response.json()
        print(f"[NAV] Vision API HTTP {response.status_code}")
    except Exception as exc:
        print(f"[NAV] Vision API error: {exc}")
    return None


def _select_target(raw_boxes: Iterable[Dict[str, Any]], target_name: str) -> Optional[Dict[str, Any]]:
    normalized_target = _normalize_name(target_name)
    target_obj = None
    for item in raw_boxes:
        name = _normalize_name(str(item.get("name", "")))
        if name != normalized_target:
            continue
        box_raw = item.get("box")
        box: Dict[str, Any] = box_raw if isinstance(box_raw, dict) else {}
        area = float(box.get("area", 0) or 0)

        target_box_raw = (target_obj or {}).get("box") if target_obj else {}
        target_box: Dict[str, Any] = (
            target_box_raw if isinstance(target_box_raw, dict) else {}
        )
        if not target_obj or area > float(target_box.get("area", 0) or 0):
            target_obj = item
    return target_obj


def _object_pose(target_obj: Dict[str, Any], frame_width: float) -> Optional[Tuple[float, float]]:
    box_raw = target_obj.get("box")
    box: Dict[str, Any] = box_raw if isinstance(box_raw, dict) else {}
    if "x1" not in box or "x2" not in box:
        return None
    x1 = float(box["x1"])
    x2 = float(box["x2"])
    obj_w = max(0.0, x2 - x1)
    center_x = x1 + (obj_w / 2.0)
    offset_x = (center_x / frame_width) - 0.5
    fill_ratio = obj_w / frame_width
    return offset_x, fill_ratio


def move_towards_object(
    arduino: serial.Serial,
    target_class: str,
    target_fill_ratio: float,
    max_steps: int,
    vision_url: str,
) -> str:
    print(f"[NAV] Starting homing sequence: target='{target_class}', target_fill={target_fill_ratio:.2f}")
    if max_steps <= 0:
        return "invalid_config"

    empty_reads = 0
    saw_target = False
    search_rotation_deg = 0.0
    max_search_rotation_deg = max(0.0, DEFAULT_SEARCH_FULL_ROTATIONS * 360.0)

    for step in range(1, max_steps + 1):
        payload = _fetch_vision(vision_url)
        raw_boxes_raw = (payload or {}).get("raw_boxes") or []
        if isinstance(raw_boxes_raw, list):
            raw_boxes: List[Dict[str, Any]] = [
                item for item in raw_boxes_raw if isinstance(item, dict)
            ]
        else:
            raw_boxes = []

        if not raw_boxes:
            empty_reads += 1
            print(f"[NAV] Step {step}/{max_steps}: no vision boxes yet.")
            time.sleep(0.25)
            continue

        target_obj = _select_target(raw_boxes, target_class)
        if not target_obj:
            print(f"[NAV] Step {step}/{max_steps}: target '{target_class}' not visible. Rotating search.")
            _send_command(arduino, "TRN_R", round(DEFAULT_SEARCH_TURN_DEG, 1))
            search_rotation_deg += DEFAULT_SEARCH_TURN_DEG
            if max_search_rotation_deg > 0 and search_rotation_deg >= max_search_rotation_deg:
                print("[NAV] Search rotation limit reached; target not found.")
                return "target_not_found"
            time.sleep(0.2)
            continue

        saw_target = True
        search_rotation_deg = 0.0
        pose = _object_pose(target_obj, DEFAULT_CAMERA_WIDTH)
        if not pose:
            print(f"[NAV] Step {step}/{max_steps}: target box payload missing x1/x2.")
            time.sleep(0.2)
            continue

        offset_x, fill_ratio = pose
        print(
            f"[NAV] Step {step}/{max_steps}: target locked | offset={offset_x:.3f}, fill={fill_ratio:.3f}")

        if abs(offset_x) > DEFAULT_CENTER_DEADZONE:
            turn_deg = max(6.0, min(45.0, abs(offset_x) * 60.0))
            _send_command(arduino, "TRN_R" if offset_x > 0 else "TRN_L", round(turn_deg, 1))
            time.sleep(0.2)
            continue

        if fill_ratio >= target_fill_ratio:
            print(
                f"[NAV] Target reached with fill_ratio={fill_ratio:.3f} (goal={target_fill_ratio:.3f}).")
            return "target_reached"

        forward_dist = (target_fill_ratio - fill_ratio) * 100.0
        forward_dist = max(8.0, min(forward_dist, 45.0))
        _send_command(arduino, "FWD", round(forward_dist, 1))
        time.sleep(0.2)

    if empty_reads >= max_steps:
        return "vision_unavailable"
    if not saw_target:
        return "target_not_found"
    return "max_steps_exceeded"


def _run() -> int:
    parser = argparse.ArgumentParser(description="Whisplay motor + vision navigation controller")
    parser.add_argument("--mode", choices=["vision", "motor"], required=True)
    parser.add_argument("--target", default="person")
    parser.add_argument("--fill", type=float, default=0.70)
    parser.add_argument("--max-steps", type=int, default=int(os.getenv("NAVIGATION_MAX_STEPS", "28")))
    parser.add_argument("--vision-url", default=DEFAULT_VISION_API_URL)
    parser.add_argument("--action", choices=["FWD", "REV", "TRN_L", "TRN_R"], default="FWD")
    parser.add_argument("--value", type=float, default=10.0)
    args = parser.parse_args()

    try:
        arduino = _open_arduino()
    except Exception as exc:
        print(f"NAV_RESULT arduino_unavailable ({exc})")
        return 20

    try:
        if args.mode == "vision":
            result = move_towards_object(
                arduino=arduino,
                target_class=args.target,
                target_fill_ratio=max(0.2, min(args.fill, 0.95)),
                max_steps=max(1, args.max_steps),
                vision_url=args.vision_url,
            )
            print(f"NAV_RESULT {result}")
            return 0 if result == "target_reached" else 21

        _send_command(arduino, args.action, args.value)
        print("NAV_RESULT motor_command_sent")
        return 0
    finally:
        try:
            arduino.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(_run())