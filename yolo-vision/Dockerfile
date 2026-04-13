FROM python:3.9-slim

WORKDIR /app

# Install the sneaky Linux C++ libraries OpenCV needs
RUN apt-get update && apt-get install -y libglib2.0-0 libgl1 libxcb1 && rm -rf /var/lib/apt/lists/*

# Install Python packages permanently into the image
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The command to run when the container starts
CMD ["python", "app.py"]
