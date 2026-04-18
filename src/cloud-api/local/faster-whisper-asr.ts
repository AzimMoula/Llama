import axios from "axios";
import dotenv from "dotenv";
import { resolve } from "path";
import { ASRServer } from "../../type";
import { spawn } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";

dotenv.config();

const fasterWhisperPort = process.env.FASTER_WHISPER_PORT || "8803";
const fasterWhisperHost = process.env.FASTER_WHISPER_HOST || "localhost";
const fasterWhisperLanguage = process.env.FASTER_WHISPER_LANGUAGE || "en";
const fasterWhisperRequestType =
  process.env.FASTER_WHISPER_REQUEST_TYPE || "filePath";
const fasterWhisperHttpTimeoutMs = Math.max(
  3000,
  parseInt(process.env.FASTER_WHISPER_HTTP_TIMEOUT_MS || "25000", 10)
);

let pyProcess: any = null;
const asrServer = process.env.ASR_SERVER || "";

if (
  asrServer.trim().toLowerCase() === ASRServer.fasterwhisper &&
  ["localhost", "0.0.0.0", "127.0.0.1"].includes(fasterWhisperHost)
) {
  pyProcess = spawn(
    "python3",
    [
      resolve(__dirname, "../../../python/speech-service/faster-whisper-host.py"),
      "--port",
      fasterWhisperPort,
    ],
    {
      detached: true,
      stdio: "inherit",
    }
  );
}

interface FasterWhisperResponse {
  filePath: string;
  recognition: string;
}

type WhisperRequestBody = {
  filePath?: string;
  base64?: string;
  language?: string;
};

const buildWhisperBody = (
  audioFilePath: string,
  requestType: "filePath" | "base64"
): WhisperRequestBody => {
  const body: WhisperRequestBody = { language: fasterWhisperLanguage };
  if (requestType === "base64") {
    const audioData = readFileSync(audioFilePath);
    body.base64 = audioData.toString("base64");
  } else {
    body.filePath = audioFilePath;
  }
  return body;
};

const postRecognize = async (body: WhisperRequestBody): Promise<string> => {
  const response = await axios.post<FasterWhisperResponse>(
    `http://${fasterWhisperHost}:${fasterWhisperPort}/recognize`,
    body,
    {
      timeout: fasterWhisperHttpTimeoutMs,
    }
  );
  if (
    response.data &&
    Object.prototype.hasOwnProperty.call(response.data, "recognition") &&
    typeof response.data.recognition === "string"
  ) {
    return response.data.recognition;
  }
  console.error("Invalid response from Whisper service:", response.data);
  return "";
};

export const recognizeAudio = async (
  audioFilePath: string
): Promise<string> => {
  if (!existsSync(audioFilePath)) {
    console.warn(`[ASR] Recording file not found: ${audioFilePath}`);
    return "";
  }

  try {
    const stat = statSync(audioFilePath);
    if (!stat.isFile() || stat.size <= 44) {
      // 44 bytes is a typical WAV header-only file with no audio payload.
      console.warn(`[ASR] Recording file is empty or too short: ${audioFilePath}`);
      return "";
    }
  } catch (e) {
    console.warn(`[ASR] Failed to stat recording file: ${audioFilePath}`);
    return "";
  }

  const normalizedRequestType =
    fasterWhisperRequestType === "base64" ? "base64" : "filePath";

  try {
    return await postRecognize(
      buildWhisperBody(audioFilePath, normalizedRequestType)
    );
  } catch (error: any) {
    const responseError = error?.response?.data?.error;
    const status = error?.response?.status;
    const filePathMissing =
      typeof responseError === "string" &&
      responseError.includes("No such file or directory");

    if (normalizedRequestType === "filePath" && filePathMissing) {
      console.warn(
        `[ASR] filePath is not visible in whisper container, retrying with base64: ${audioFilePath}`
      );
      try {
        return await postRecognize(buildWhisperBody(audioFilePath, "base64"));
      } catch (retryError: any) {
        const retryStatus = retryError?.response?.status ?? "unknown";
        const retryMessage =
          retryError?.response?.data?.error || retryError?.message || "unknown";
        console.error(
          `[ASR] Whisper retry failed (status=${retryStatus}): ${retryMessage}`
        );
        return "";
      }
    }

    const message = responseError || error?.message || "unknown";
    console.error(
      `[ASR] Whisper request failed (status=${status ?? "unknown"}, timeoutMs=${fasterWhisperHttpTimeoutMs}): ${message}`
    );
    return "";
  }
};

function cleanup() {
  if (pyProcess && !pyProcess.killed) {
    console.log("Killing python server...");
    process.kill(-pyProcess.pid, "SIGTERM");
  }
}

process.on("SIGINT", cleanup); // Ctrl+C
process.on("SIGTERM", cleanup); // systemctl / docker stop
process.on("exit", cleanup);
process.on("uncaughtException", (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
