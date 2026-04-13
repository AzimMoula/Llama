# Use official Node.js 20 image (ARM64 compatible for Jetson Nano)
FROM node:20-bullseye

# Set working directory
WORKDIR /app

RUN npm config set registry https://registry.npmjs.org/

RUN apt-get update && apt-get install -y mpg123 python3-pip build-essential python3-dev alsa-utils python3-libgpiod sox libsox-fmt-all

COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --upgrade pip && pip3 install -r ./python/requirements.txt
RUN pip3 install --force-reinstall Pillow RPi.GPIO
RUN pip3 install Jetson.GPIO

# Copy package.json and lock files first for better caching
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./

# Install dependencies (choose yarn or npm as needed)
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    else npm install; fi

# Copy the rest of the project files
COPY . .

# Build TypeScript (if needed)
RUN if [ -f tsconfig.json ]; then yarn build || npm run build || true; fi

# Expose port if your app is a server (uncomment if needed)
# EXPOSE 3000

# Set environment variables if needed
# ENV NODE_ENV=production

# Start the application (edit if your entry point is different)
CMD ["yarn", "start"]
# Or, if you use npm: CMD ["npm", "start"]

# To run with hardware access (GPIO/audio), use:
# sudo docker run --privileged --device /dev/gpiomem --device /dev/snd -it whisplay-chatbot /bin/bash