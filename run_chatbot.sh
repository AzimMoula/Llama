#!/bin/bash
# Set working directory
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Guard against concurrent invocations (systemd + manual startup/compose).
LOCK_FILE="/tmp/whisplay-chatbot.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another run_chatbot.sh instance is already active. Exiting to avoid Docker conflicts."
  exit 0
fi

# Find the sound card index for wm8960soundcard when ALSA is available.
card_index=""
if [ -r "/proc/asound/cards" ]; then
  card_index=$(awk '/wm8960soundcard/ {print $1}' /proc/asound/cards | head -n1)
fi
# Default to 1 if not found; runtime checks below will validate availability.
if [ -z "$card_index" ]; then
  card_index=1
fi
echo "Using sound card index: $card_index"

# Output current environment information (for debugging)
echo "===== Start time: $(date) =====" 
echo "Current user: $(whoami)" 
echo "Working directory: $(pwd)" 
working_dir=$(pwd)
echo "PATH: $PATH" 
echo "Python version: $(python3 --version)" 
echo "Node version: $(node --version)"
sleep 5

# Start the service
echo "Starting Node.js application..."
cd $working_dir

get_env_value() {
  if grep -Eq "^[[:space:]]*$1[[:space:]]*=" .env; then
    val=$(grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -n1 | cut -d'=' -f2-)
    # trim whitespace and surrounding quotes
    echo "$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  else
    echo ""
  fi
}

# load .env variables, exclude comments and empty lines
# check if .env file exists
initial_volume_level=114
serve_ollama=false
if [ -f ".env" ]; then
  # Load only SERVE_OLLAMA from .env (ignore comments/other vars)
  SERVE_OLLAMA=$(get_env_value "SERVE_OLLAMA")
  [ -n "$SERVE_OLLAMA" ] && export SERVE_OLLAMA
  
  CUSTOM_FONT_PATH=$(get_env_value "CUSTOM_FONT_PATH")
  [ -n "$CUSTOM_FONT_PATH" ] && export CUSTOM_FONT_PATH

  INITIAL_VOLUME_LEVEL=$(get_env_value "INITIAL_VOLUME_LEVEL")
  [ -n "$INITIAL_VOLUME_LEVEL" ] && export INITIAL_VOLUME_LEVEL

  WHISPER_MODEL_SIZE=$(get_env_value "WHISPER_MODEL_SIZE")
  [ -n "$WHISPER_MODEL_SIZE" ] && export WHISPER_MODEL_SIZE

  FASTER_WHISPER_MODEL_SIZE=$(get_env_value "FASTER_WHISPER_MODEL_SIZE")
  [ -n "$FASTER_WHISPER_MODEL_SIZE" ] && export FASTER_WHISPER_MODEL_SIZE

  echo ".env variables loaded."

  # check if SERVE_OLLAMA is set to true
  if [ "$SERVE_OLLAMA" = "true" ]; then
    serve_ollama=true
  fi

  if [ -n "$INITIAL_VOLUME_LEVEL" ]; then
    initial_volume_level=$INITIAL_VOLUME_LEVEL
  fi
else
  echo ".env file not found, please create one based on .env.template."
  exit 1
fi

# Adjust initial volume only when amixer can access the selected card.
if command -v amixer >/dev/null 2>&1 && amixer -c "$card_index" scontrols >/dev/null 2>&1; then
  amixer -c "$card_index" set Speaker "$initial_volume_level" || true
else
  echo "Skipping amixer init: no valid ALSA card $card_index in this environment."
fi

if [ "$serve_ollama" = true ]; then
  echo "Starting Ollama server..."
  export OLLAMA_KEEP_ALIVE=-1 # ensure Ollama server stays alive
  OLLAMA_HOST=0.0.0.0:11434 ollama serve &
fi

# if file use_npm exists and is true, use npm
if [ -f "use_npm" ]; then
  use_npm=true
else
  use_npm=false
fi

# if [ "$use_npm" = true ]; then
#   echo "Using npm to start the application..."
#   SOUND_CARD_INDEX=$card_index npm start
# else
#   echo "Using yarn to start the application..."
#   SOUND_CARD_INDEX=$card_index yarn start
# fi

# Start the Docker Compose stack
echo "Starting application via Docker Compose..."

camera_nodes=$(ls /dev/video* 2>/dev/null | tr '\n' ' ')
if [ -n "$camera_nodes" ]; then
  echo "Detected camera node(s): $camera_nodes"
else
  echo "Warning: no /dev/video* nodes detected on host before compose startup."
fi

compose_cmd=()
if docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available in PATH."
  exit 1
fi

cleanup_conflicting_container() {
  local cname="$1"
  local cid
  cid=$(docker ps -aq -f "name=^/${cname}$")
  if [ -n "$cid" ]; then
    echo "Removing pre-existing container with conflicting name: ${cname} (${cid})"
    if ! docker rm -f "$cid"; then
      echo "Docker remove failed for ${cname} via current user. Trying sudo fallback..."
      sudo docker rm -f "$cid" || {
        echo "Failed to remove conflicting container ${cname}."
        echo "Run manually: sudo docker rm -f ${cid}"
      }
    fi
  fi
}

# Fixed container_name entries can collide with stale/manual containers.
cleanup_conflicting_container "yolo-vision"
cleanup_conflicting_container "faster-whisper"
cleanup_conflicting_container "llm-engine"
cleanup_conflicting_container "piper-http"
cleanup_conflicting_container "whisplay-chatbot"

echo "Refreshing yolo-vision container to remap camera devices..."
"${compose_cmd[@]}" -f docker/docker-compose.yml up -d --build --force-recreate --remove-orphans yolo-vision

echo "Starting chatbot service..."
"${compose_cmd[@]}" -f docker/docker-compose.yml up -d --build --force-recreate --remove-orphans chatbot

# Tailing logs to keep the script running for systemd limits
"${compose_cmd[@]}" -f docker/docker-compose.yml logs -f chatbot

# After the service ends, perform cleanup
echo "Cleaning up after service..."

if [ "$serve_ollama" = true ]; then
  echo "Stopping Ollama server..."
  pkill ollama
fi

# Record end status
echo "===== Service ended: $(date) ====="
