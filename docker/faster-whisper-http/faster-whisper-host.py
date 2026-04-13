# import base64
# import time
# import tempfile
# import os
# from flask import Flask, request, jsonify
# from faster_whisper import WhisperModel
# import argparse
# import signal
# import sys

# try:
#   import ctranslate2
# except Exception:
#   ctranslate2 = None

# # read model path from /app/model-path.txt if exists
# model_path_file = "/app/model-path.txt"
# if os.path.exists(model_path_file):
#     with open(model_path_file, "r") as f:
#         model_path = f.read().strip()
#     os.environ["FASTER_WHISPER_MODEL_SIZE_OR_PATH"] = model_path

# # ---------- Configuration ----------
# MODEL_NAME = os.getenv("FASTER_WHISPER_MODEL_SIZE_OR_PATH", "tiny")
# REQUESTED_DEVICE = os.getenv("FASTER_WHISPER_DEVICE", "auto").strip().lower()
# COMPUTE_TYPE = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8")
# CPU_THREADS = int(os.getenv("FASTER_WHISPER_CPU_THREADS", "3"))
# VAD_FILTER = os.getenv("FASTER_WHISPER_VAD_FILTER", "true").strip().lower() in {"1", "true", "yes", "on"}
# BEAM_SIZE = int(os.getenv("FASTER_WHISPER_BEAM_SIZE", "1"))
# BEST_OF = int(os.getenv("FASTER_WHISPER_BEST_OF", "1"))
# CONDITION_ON_PREVIOUS_TEXT = os.getenv("FASTER_WHISPER_CONDITION_ON_PREVIOUS_TEXT", "false").strip().lower() in {"1", "true", "yes", "on"}
# WITHOUT_TIMESTAMPS = os.getenv("FASTER_WHISPER_WITHOUT_TIMESTAMPS", "true").strip().lower() in {"1", "true", "yes", "on"}
# TEMPERATURE = float(os.getenv("FASTER_WHISPER_TEMPERATURE", "0.0"))


# def _detect_cuda_available() -> bool:
#   if ctranslate2 is None:
#     return False
#   try:
#     return ctranslate2.get_cuda_device_count() > 0
#   except Exception:
#     return False


# def _device_candidates():
#   if REQUESTED_DEVICE in {"cuda", "cpu"}:
#     return [REQUESTED_DEVICE]
#   # auto
#   return ["cuda", "cpu"] if _detect_cuda_available() else ["cpu"]

# # ---------- Initialization ----------
# app = Flask(__name__)

# t0 = time.perf_counter()
# print("[INIT] Loading whisper model...")
# model = None
# last_error = None
# for device in _device_candidates():
#   try:
#     model = WhisperModel(
#       MODEL_NAME,
#       device=device,
#       cpu_threads=CPU_THREADS,
#       compute_type=COMPUTE_TYPE,
#     )
#     print(f"[INIT] Loaded model on device={device}, compute_type={COMPUTE_TYPE}, cpu_threads={CPU_THREADS}")
#     break
#   except Exception as e:
#     last_error = e
#     print(f"[INIT] Failed loading on device={device}: {e}")

# if model is None:
#   raise RuntimeError(f"Failed to load Faster-Whisper model '{MODEL_NAME}': {last_error}")

# t1 = time.perf_counter()
# print(f"[INIT] Model loaded in {round(t1 - t0, 2)} seconds")


# # ---------- Utility Functions ----------
# def save_base64_to_temp_file(b64: str):
#   """Save base64 audio to a temporary file and return its path"""
#   try:
#     audio_bytes = base64.b64decode(b64)
#     # Create temporary file
#     fd, temp_path = tempfile.mkstemp(suffix=".wav")
#     os.close(fd)  # Close file descriptor
    
#     # Write to file
#     with open(temp_path, 'wb') as f:
#       f.write(audio_bytes)
    
#     return temp_path
#   except Exception as e:
#     raise ValueError(f"Failed to save base64 to temp file: {e}")

# # ---------- API ----------
# @app.route("/recognize", methods=["POST"])
# def recognize():
#   data = request.get_json(force=True, silent=True)
#   if not data:
#     return jsonify({"error": "Invalid JSON"}), 400

#   file_path = data.get("filePath")
#   b64_audio = data.get("base64")
#   language = data.get("language")

#   if not file_path and not b64_audio:
#     return jsonify({
#       "error": "Either filePath or base64 must be provided"
#     }), 400

#   temp_file = None
#   try:
#     t0 = time.perf_counter()

#     # 1. Determine audio file path
#     if file_path:
#       audio_path = file_path
#     else:
#       # Convert base64 to temporary file
#       temp_file = save_base64_to_temp_file(b64_audio)
#       audio_path = temp_file

#     # 2. Transcribe using file path
#     segments, info = model.transcribe(
#       audio_path,
#       language=language,
#       vad_filter=VAD_FILTER,
#       beam_size=BEAM_SIZE,
#       best_of=BEST_OF,
#       condition_on_previous_text=CONDITION_ON_PREVIOUS_TEXT,
#       without_timestamps=WITHOUT_TIMESTAMPS,
#       temperature=TEMPERATURE,
#     )

#     text = "".join(seg.text for seg in segments).strip()

#     t1 = time.perf_counter()

#     return jsonify({
#       "recognition": text,
#       "language": info.language,
#       "time_cost": round(t1 - t0, 3)
#     })

#   except Exception as e:
#     return jsonify({"error": str(e)}), 500
  
#   finally:
#     # Clean up temporary file
#     if temp_file and os.path.exists(temp_file):
#       try:
#         os.remove(temp_file)
#       except:
#         pass

# def shutdown(sig, frame):
#     print("Shutting down python server...")
#     sys.exit(0)

# # ---------- Startup ----------
# if __name__ == "__main__":
#   parser = argparse.ArgumentParser(description='Faster Whisper API Server')
#   parser.add_argument('--port', type=int, default=8803, help='Port to run the server on')
#   args = parser.parse_args()
  
#   signal.signal(signal.SIGTERM, shutdown)
#   signal.signal(signal.SIGINT, shutdown)
  
#   print(f"[STARTING] Starting Faster Whisper server on port {args.port}...")
  
#   app.run(
#     host="0.0.0.0",
#     port=args.port,
#     threaded=False  # Very important on Pi
#   )



###the changes are from here
import base64
import time
import tempfile
import os
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
import argparse
import signal
import sys

# read model path from /app/model-path.txt if exists
model_path_file = "/app/model-path.txt"
if os.path.exists(model_path_file):
    with open(model_path_file, "r") as f:
        model_path = f.read().strip()
    os.environ["FASTER_WHISPER_MODEL_SIZE_OR_PATH"] = model_path

# ---------- Configuration ----------
MODEL_NAME = os.getenv("FASTER_WHISPER_MODEL_SIZE_OR_PATH", "tiny")     # tiny / base
DEVICE = "cpu"
COMPUTE_TYPE = "int8"    # Pi must use int8
CPU_THREADS = int(os.getenv("FASTER_WHISPER_CPU_THREADS", "4"))
VAD_FILTER = os.getenv("FASTER_WHISPER_VAD_FILTER", "false").strip().lower() in {"1", "true", "yes", "on"}

# ---------- Initialization ----------
app = Flask(__name__)

t0 = time.perf_counter()
print("[INIT] Loading whisper model...")
model = WhisperModel(
  MODEL_NAME,
  device=DEVICE,
  cpu_threads=CPU_THREADS,
  compute_type=COMPUTE_TYPE,
)
t1 = time.perf_counter()
print(f"[INIT] Model loaded in {round(t1 - t0, 2)} seconds")


# ---------- Utility Functions ----------
def save_base64_to_temp_file(b64: str):
  """Save base64 audio to a temporary file and return its path"""
  try:
    audio_bytes = base64.b64decode(b64)
    # Create temporary file
    fd, temp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)  # Close file descriptor
    
    # Write to file
    with open(temp_path, 'wb') as f:
      f.write(audio_bytes)
    
    return temp_path
  except Exception as e:
    raise ValueError(f"Failed to save base64 to temp file: {e}")

# ---------- API ----------
@app.route("/recognize", methods=["POST"])
def recognize():
  data = request.get_json(force=True, silent=True)
  if not data:
    return jsonify({"error": "Invalid JSON"}), 400

  file_path = data.get("filePath")
  b64_audio = data.get("base64")
  language = data.get("language")

  if not file_path and not b64_audio:
    return jsonify({
      "error": "Either filePath or base64 must be provided"
    }), 400

  temp_file = None
  try:
    t0 = time.perf_counter()

    # 1. Determine audio file path
    if file_path:
      audio_path = file_path
    else:
      # Convert base64 to temporary file
      temp_file = save_base64_to_temp_file(b64_audio)
      audio_path = temp_file

    # 2. Transcribe using file path
    segments, info = model.transcribe(
      audio_path,
      language=language,
      vad_filter=VAD_FILTER
    )

    text = "".join(seg.text for seg in segments).strip()

    t1 = time.perf_counter()

    return jsonify({
      "recognition": text,
      "language": info.language,
      "time_cost": round(t1 - t0, 3)
    })

  except Exception as e:
    return jsonify({"error": str(e)}), 500
  
  finally:
    # Clean up temporary file
    if temp_file and os.path.exists(temp_file):
      try:
        os.remove(temp_file)
      except:
        pass

def shutdown(sig, frame):
    print("Shutting down python server...")
    sys.exit(0)

# ---------- Startup ----------
if __name__ == "__main__":
  parser = argparse.ArgumentParser(description='Faster Whisper API Server')
  parser.add_argument('--port', type=int, default=8803, help='Port to run the server on')
  args = parser.parse_args()
  
  signal.signal(signal.SIGTERM, shutdown)
  signal.signal(signal.SIGINT, shutdown)
  
  print(f"[STARTING] Starting Faster Whisper server on port {args.port}...")
  
  app.run(
    host="0.0.0.0",
    port=args.port,
    threaded=False  # Very important on Pi
  )