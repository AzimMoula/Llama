#!/bin/bash

# Ensure required scripts are executable so a single ./startup.sh is enough.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$SCRIPT_DIR/startup.sh" "$SCRIPT_DIR/run_chatbot.sh" "$SCRIPT_DIR/launch_kiosk.sh" 2>/dev/null || true

# Browser auto-launch requires graphical target.
if [ "$(systemctl get-default)" != "graphical.target" ]; then
    echo "Graphical interface is currently disabled. Enabling graphical target..."
    sudo systemctl set-default graphical.target
    echo "Graphical target enabled."
else
    echo "Graphical interface is currently enabled."
fi

# Get user info
TARGET_USER=$(whoami)
USER_HOME=$HOME
TARGET_UID=$(id -u $TARGET_USER)

# Make sure we do not return roon (in case user called the script with sudo)
if [ "$TARGET_USER" == "root" ]; then
    echo "Error: Please run this script as your normal user (WITHOUT sudo)."
    echo "The script will ask for sudo permissions only when writing the service file."
    exit 1
fi

echo "----------------------------------------"
echo "Detected User: $TARGET_USER"
echo "Detected Home: $USER_HOME"
echo "Detected UID:  $TARGET_UID"

if getent group docker >/dev/null 2>&1; then
    if ! id -nG "$TARGET_USER" | grep -qw docker; then
        echo "Adding $TARGET_USER to docker group for non-root docker access..."
        sudo usermod -aG docker "$TARGET_USER"
        echo "User added to docker group. Re-login or reboot is required for group changes to apply."
    fi
fi

# Find Node bin
NODE_BIN=$(which node)

if [ -z "$NODE_BIN" ]; then
    echo "Error: Could not find 'node'. Make sure you can run 'node -v' in this terminal."
    exit 1
fi

NODE_FOLDER=$(dirname $NODE_BIN)
echo "Found Node at: $NODE_FOLDER"
echo "----------------------------------------"

# Create the service file
PROJECT_DIR="$SCRIPT_DIR"
echo "Creating systemd service file for project at $PROJECT_DIR..."
sudo tee /etc/systemd/system/chatbot.service > /dev/null <<EOF
[Unit]
Description=Chatbot Service
After=network-online.target docker.service display-manager.service sound.target graphical.target
Wants=network-online.target docker.service display-manager.service sound.target

[Service]
Type=simple
User=$TARGET_USER
Group=audio
SupplementaryGroups=audio video gpio docker

# Use the dynamic Project Directory
WorkingDirectory=$PROJECT_DIR
ExecStart=/bin/bash $PROJECT_DIR/run_chatbot.sh

# Inject the dynamic Node path and dynamic User ID
Environment=PATH=$NODE_FOLDER:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
Environment=HOME=$USER_HOME
Environment=XDG_RUNTIME_DIR=/run/user/$TARGET_UID
Environment=NODE_ENV=production

# Audio permissions
PrivateDevices=no

# Logs
StandardOutput=append:$PROJECT_DIR/chatbot.log
StandardError=append:$PROJECT_DIR/chatbot.log

Restart=always
RestartSec=2

[Install]
WantedBy=graphical.target
EOF

# Create a desktop autostart entry to launch browser in kiosk mode after user login.
AUTOSTART_DIR="$USER_HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

cat > "$AUTOSTART_DIR/whisplay-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Whisplay Kiosk
Comment=Open Whisplay UI in full-screen kiosk mode
Exec=/bin/bash $PROJECT_DIR/launch_kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
X-LXQt-Need-Tray=false
EOF

chmod +x "$PROJECT_DIR/launch_kiosk.sh"
echo "Desktop autostart created at $AUTOSTART_DIR/whisplay-kiosk.desktop"

# start the service
echo "Service file created. Reloading Systemd..."
sudo systemctl daemon-reload
sudo systemctl enable chatbot.service
sudo systemctl restart chatbot.service

echo "Launching kiosk browser for current desktop session..."
nohup /bin/bash "$PROJECT_DIR/launch_kiosk.sh" >/dev/null 2>&1 &

echo "Done! Chatbot is starting..."
echo "Checking status..."
sleep 2
sudo systemctl status chatbot --no-pager