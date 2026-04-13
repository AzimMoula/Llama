import requests

print("=== Whisplay Interactive Vision Console ===")
print("Type 'exit' to quit.\n")

while True:
    user_text = input("You: ")
    if user_text.lower() in ['exit', 'quit']:
        break

    # 1. Ask YOLO what it sees
    try:
        vision_response = requests.get("http://localhost:5000/scene", timeout=5)
        vision_json = vision_response.json()
        scene_data = vision_json.get("scene", "I see no stable objects right now.")
        objects = vision_json.get("objects", [])
        compact_objects = ", ".join([
            (
                f"{obj.get('name')}={obj.get('count')}(color={obj.get('color')})"
                if obj.get("color")
                else f"{obj.get('name')}={obj.get('count')}"
            )
            for obj in objects[:5]
        ])
        camera_context = f"objects({compact_objects})" if compact_objects else scene_data
    except Exception:
        camera_context = "Vision system currently offline or busy."

    # 2. THE FIX: Strict, First-Person System Prompt
    # We tell the model specifically NOT to narrate.
  # Use a simpler, cleaner prompt for TinyLlama
    # Use a much simpler prompt format for TinyLlama
    # This prevents it from repeating the system instructions back to you
    final_prompt = (
        f"You are Whisplay, a friendly AI robot. "
        f"Answer the user based on the Vision data provided.\n\n"
        f"Vision Data: {camera_context}\n"
        f"User: {user_text}\n"
        f"Assistant: "
    )

    print(f"\n--- [DEBUG VISION DATA]: {camera_context} ---\n")

    # 3. Send to Local TinyLlama Engine
    try:
        llm_response = requests.post(
            "http://localhost:8000/v1/chat/completions",
            headers={"Content-Type": "application/json"},
            json={
                "model": "tinyllama",
                "messages": [{"role": "user", "content": final_prompt}],
                "temperature": 0.2, # LOWER temperature makes it more factual/less crazy
                "max_tokens":40     # Increased slightly so it doesn't cut off
            }
        )
        
        if llm_response.status_code == 200:
            reply = llm_response.json()['choices'][0]['message']['content']
            
            # Clean up potential "narration" if the model slips up
            clean_reply = reply.strip().replace("The robot sees", "I see").replace("Based on the context,", "")
            print(f"Whisplay: {clean_reply}\n")
        else:
            print(f"Error: LLM status {llm_response.status_code}\n")
            
    except Exception as e:
        print(f"Error connecting to the LLM: {e}\n")