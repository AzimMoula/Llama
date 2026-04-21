#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_DIR/browser-kiosk.log"
URL="${WHISPLAY_UI_URL:-http://localhost:17880}"

{
  echo "===== Browser launcher start: $(date) ====="
  echo "User: $(whoami)"
  echo "Display: ${DISPLAY:-<unset>}"
  echo "URL: $URL"
} >> "$LOG_FILE"

export DISPLAY="${DISPLAY:-:0}"
if [ -z "$XAUTHORITY" ] && [ -f "$HOME/.Xauthority" ]; then
  export XAUTHORITY="$HOME/.Xauthority"
fi

wait_for_url() {
  local try
  for try in $(seq 1 120); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$URL" >/dev/null 2>&1; then
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -qO- "$URL" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

pick_browser() {
  if command -v chromium-browser >/dev/null 2>&1; then
    echo "chromium-browser"
    return 0
  fi
  if command -v chromium >/dev/null 2>&1; then
    echo "chromium"
    return 0
  fi
  if command -v google-chrome-stable >/dev/null 2>&1; then
    echo "google-chrome-stable"
    return 0
  fi
  if command -v google-chrome >/dev/null 2>&1; then
    echo "google-chrome"
    return 0
  fi
  return 1
}

if ! wait_for_url; then
  echo "Web UI did not become ready within timeout: $URL" >> "$LOG_FILE"
fi

BROWSER_BIN="$(pick_browser || true)"
if [ -z "$BROWSER_BIN" ]; then
  echo "No supported browser binary found (chromium-browser/chromium/google-chrome)." >> "$LOG_FILE"
  exit 1
fi

echo "Launching browser with: $BROWSER_BIN" >> "$LOG_FILE"
"$BROWSER_BIN" \
  --kiosk \
  --app="$URL" \
  --incognito \
  --start-fullscreen \
  --no-first-run \
  --disable-session-crashed-bubble \
  >> "$LOG_FILE" 2>&1 &
