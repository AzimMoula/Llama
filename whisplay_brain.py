import serial
import time
import sys
import requests
import math

# ==========================================
# WHISPLAY - JETSON NANO BRAIN WITH VISION
# ==========================================

# 1. USB Connection Setup
# Linux usually mounts Arduinos as ttyACM0. If it fails, check ttyUSB0.
ARDUINO_PORT = '/dev/ttyACM0' 
BAUD_RATE = 115200
VISION_API_URL = "http://localhost:5000/scene"

print(f"Connecting to Arduino on {ARDUINO_PORT}...")
try:
    arduino = serial.Serial(ARDUINO_PORT, BAUD_RATE, timeout=1)
    time.sleep(2)  
    print("Connection established!\n")
except Exception as e:
    print(f"FAILED TO CONNECT: {e}")
    sys.exit()

def send_command(cmd, value):
    """Sends a string over USB and blocks Python until the Arduino replies."""
    command_string = f"{cmd}:{value}\n"
    print(f"Jetson sending:  {command_string.strip()}")
    
    arduino.write(command_string.encode('utf-8'))
    
    print("Waiting for Arduino to finish physical movement... ", end="", flush=True)
    
    start_time = time.time()
    while True:
        if arduino.in_waiting > 0:
            response = arduino.readline().decode('utf-8').strip()
            print(f"[{response}]", end="", flush=True) # Print whatever Arduino actually says
            if response == "DONE":
                print("\n[DONE]")
                break
                
        # Failsafe timeout to prevent the script from freezing forever
        # Adjust 5.0s to however long your longest movement takes
        if time.time() - start_time > 2.0:
            print("\n[TIMEOUT - Proceeding anyway]")
            break
            
        time.sleep(0.01)

def get_vision_data():
    """Fetches the latest bounding boxes from the YOLO container."""
    try:
        resp = requests.get(VISION_API_URL, timeout=2)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        print(f"Vision API error: {e}")
    return None

def move_towards_object(target_class="person", target_fill_ratio=0.7):
    """
    Finds the target object and moves towards it until its bounding box 
    covers approximately `target_fill_ratio` of the camera's width/height.
    """
    print(f"\n--- Starting Vision Homing for '{target_class}' ---")
    
    # Camera resolution standard fallback based on our yolo settings
    CAM_W = 640.0
    CAM_H = 480.0
    
    while True:
        time.sleep(0.1) # Add a small delay to avoid spamming the local Flask API and causing ConnectionResetError
        data = get_vision_data()
        if not data or 'raw_boxes' not in data:
            print("No vision data yet, waiting...")
            time.sleep(0.5)
            continue
            
        target_obj = None
        # Find the largest bounding box matching our target class
        for obj in data['raw_boxes']:
            if obj['name'].lower() == target_class.lower():
                if target_obj is None or obj['box']['area'] > target_obj['box']['area']:
                    target_obj = obj
                    
        if not target_obj:
            print(f"Cannot see '{target_class}'. Rotating to search...")
            send_command("TRN_R", 15.0)  # Spin 15 degrees to look around
            time.sleep(0.5)
            continue
            
        # We found the target! Calculate its position and size
        box = target_obj['box']
        # x_min, y_min, x_max, y_max etc. Let's find center X
        # Center of the box relative to image width (0 to 1) 
        # But YOLO container usually sends normalized coordinates or pixel coordinates.
        # Let's assume normalized ratio based on area if it's sent, or calculate from pixel bounds if sent.
        # Handling the raw dict from ultralytics:
        if 'x1' in box and 'x2' in box:
            obj_w = box['x2'] - box['x1']
            obj_center_x = box['x1'] + (obj_w / 2.0)
            
            # Normalize to -0.5 (left) to +0.5 (right)
            offset_x = (obj_center_x / CAM_W) - 0.5
            
            # Width ratio (0.0 to 1.0)
            fill_ratio = obj_w / CAM_W
            
            print(f"Target locked! Offset: {offset_x:.2f}, Fill: {fill_ratio:.2f}")
            
            # 1. Turn to center the object
            if abs(offset_x) > 0.15: # Deadzone is 15% from center
                # Scale turn angle by offset amount (up to 45 degrees max per adjustment)
                turn_deg = abs(offset_x) * 60.0 
                if offset_x > 0:
                    send_command("TRN_R", round(turn_deg, 1))
                else:
                    send_command("TRN_L", round(turn_deg, 1))
                time.sleep(0.5)
                continue # Re-evaluate position before moving forward
                
            # 2. Check if we are close enough
            if fill_ratio >= target_fill_ratio:
                print(f"Target reached! (Fill ratio {fill_ratio:.2f} >= {target_fill_ratio})")
                break
                
            # 3. Move forward towards it
            # Drive distance inversely proportional to how close we are 
            # If fill is 0.1, we move a lot. If fill is 0.6, we just nudge.
            forward_dist = (target_fill_ratio - fill_ratio) * 100.0 # simple P-controller
            forward_dist = max(10.0, min(forward_dist, 50.0)) # clamp between 10cm and 50cm
            
            send_command("FWD", round(forward_dist, 1))
            time.sleep(0.5)
        else:
            print("Bounding box coordinates not structured as expected.")
            break

# ==========================================
# THE AUTONOMOUS SEQUENCE
# ==========================================

print("Starting Autonomous Sequence in 3 seconds...\n")
time.sleep(3)

# Define your path! You can mix normal moves and vision commands.
# For vision, use action "VISION" and a dictionary of parameters.
sequence_to_run = [
    #("FWD", 30.0),   # Drive forward 30 cm
    # ("TRN_R", 90.0), # Turn Right 90 degrees
    ("VISION", {"target_class": "bottle", "target_fill_ratio": 0.7}) # Hunt a sports ball
]

# Run the sequence loop
for step in sequence_to_run:
    action = step[0]
    amount = step[1]
    
    if action == "VISION":
        # It's a vision command, extract params and run the vision function
        target = amount.get("target_class", "person")
        fill = amount.get("target_fill_ratio", 0.6)
        move_towards_object(target_class=target, target_fill_ratio=fill)
    else:
        # It's a standard Arduino motor command
        send_command(action, amount)
        
    time.sleep(0.5)

print("\nAll tasks finished.")