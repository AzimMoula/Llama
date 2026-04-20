import {
  getCurrentTimeTag,
  getRecordFileDurationMs,
  splitSentences,
} from "./../utils/index";
import { display } from "../device/display";
import { recognizeAudio, ttsProcessor } from "../cloud-api/server";
import { isImMode } from "../cloud-api/llm";
import { DEFAULT_EMOJI, extractEmojis } from "../utils";
import { StreamResponser } from "./StreamResponsor";
import { recordingsDir } from "../utils/dir";
import dotEnv from "dotenv";
import { WakeWordListener } from "../device/wakeword";
import { WhisplayIMBridgeServer } from "../device/im-bridge";
import { FlowStateMachine } from "./chat-flow/stateMachine";
import { flowStates } from "./chat-flow/states";
import { ChatFlowContext, FlowName } from "./chat-flow/types";
import { playWakeupChime } from "../device/audio";

dotEnv.config();

class ChatFlow implements ChatFlowContext {
  currentFlowName: FlowName = "sleep";
  recordingsDir: string = "";
  currentRecordFilePath: string = "";
  asrText: string = "";
  streamResponser: StreamResponser;
  partialThinking: string = "";
  thinkingSentences: string[] = [];
  answerId: number = 0;
  enableCamera: boolean = false;
  knowledgePrompts: string[] = [];
  wakeWordListener: WakeWordListener | null = null;
  wakeSessionActive: boolean = false;
  wakeSessionStartAt: number = 0;
  wakeSessionLastSpeechAt: number = 0;
  answerTimeoutMs: number =
    parseInt(process.env.ANSWER_MAX_DURATION_SEC || "10", 10) * 1000;
  answerTimeoutTimer: NodeJS.Timeout | null = null;
  answerTimeoutArmedFlow: "answer" | "external_answer" | null = null;
  wakeSessionIdleTimeoutMs: number =
    parseInt(process.env.WAKE_WORD_IDLE_TIMEOUT_SEC || "60") * 1000;
  wakeRecordMaxSec: number = parseInt(
    process.env.WAKE_WORD_RECORD_MAX_SEC || "60",
  );
  wakeEmptyAsrRetries: number = 0;
  wakeEndKeywords: string[] = (process.env.WAKE_WORD_END_KEYWORDS || "byebye,goodbye,stop,byebye").toLowerCase()
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  endAfterAnswer: boolean = false;
  whisplayIMBridge: WhisplayIMBridgeServer | null = null;
  pendingExternalReply: string = "";
  pendingExternalEmoji: string = "";
  currentExternalEmoji: string = "";
  stateMachine: FlowStateMachine;
  isFromWakeListening: boolean = false;
  lastVisionContext: string = "";
  cameraContextForLLM: string = "camera_unavailable";
  cameraObjectsSummaryForLLM: string = "";
  cameraSceneSummaryForLLM: string = "";
  wakeListenerRestartTimer: NodeJS.Timeout | null = null;

  constructor(options: { enableCamera?: boolean } = {}) {
    console.log(`[${getCurrentTimeTag()}] ChatBot started.`);
    this.recordingsDir = recordingsDir;
    this.stateMachine = new FlowStateMachine(this, flowStates);
    this.streamResponser = new StreamResponser(
      ttsProcessor,
      (sentences: string[]) => {
        if (!this.isAnswerFlow()) return;
        const fullText = sentences.join(" ");
        let emoji = DEFAULT_EMOJI;
        if (this.currentFlowName === "external_answer") {
          emoji = this.currentExternalEmoji || extractEmojis(fullText) || emoji;
        } else {
          emoji = extractEmojis(fullText) || emoji;
        }
        display({
          status: "answering",
          emoji,
          text: fullText,
          RGB: "#0000ff",
          scroll_speed: 3,
        });
      },
      (text: string) => {
        if (!this.isAnswerFlow()) return;
        display({
          status: "answering",
          text: text || undefined,
          scroll_speed: 3,
        });
      },
      ({ charEnd, durationMs }) => {
        if (!this.isAnswerFlow()) return;
        if (!durationMs || durationMs <= 0) return;
        // Start timeout when audio actually starts playing, not when answer state begins.
        if (
          this.currentFlowName === "answer" ||
          this.currentFlowName === "external_answer"
        ) {
          this.armAnswerTimeout(this.currentFlowName);
        }
        display({
          scroll_sync: {
            char_end: charEnd,
            duration_ms: durationMs,
          },
        });
      }
    );
    if (options?.enableCamera) {
      this.enableCamera = true;
    }

    this.transitionTo("sleep");

    const wakeEnabled = (process.env.WAKE_WORD_ENABLED || "").toLowerCase();
    if (wakeEnabled === "true") {
      this.wakeWordListener = new WakeWordListener();
      this.wakeWordListener.on("wake", () => {
        if (this.currentFlowName === "sleep") {
          this.startWakeSession();
        }
      });
      this.wakeWordListener.start();
    }

    if (isImMode) {
      this.whisplayIMBridge = new WhisplayIMBridgeServer();
      this.whisplayIMBridge.on(
        "reply",
        (payload: { reply: string; emoji?: string }) => {
          this.pendingExternalReply = payload.reply;
          this.pendingExternalEmoji = payload.emoji || "";
          this.transitionTo("external_answer");
        },
      );
      this.whisplayIMBridge.start();
    }
  }

  async recognizeAudio(path: string, isFromAutoListening?: boolean): Promise<string> {
    const isAsrStillActive = () => this.currentFlowName === "asr";
    if (!isFromAutoListening && (await getRecordFileDurationMs(path)) < 500) {
      console.log("Record audio too short, skipping recognition.");
      return Promise.resolve("");
    }
    console.time(`[ASR time]`);
    var result = await recognizeAudio(path);
    console.timeEnd(`[ASR time]`);

    // If ASR already timed out or state moved on, ignore stale results
    // to keep display/state in sync with current interaction.
    if (!isAsrStillActive()) {
      console.log("[ASR] Ignoring stale recognition result after state transition.");
      return "";
    }

    if (result && result.trim().length > 0) {
      const userTranscript = result.trim();
      const visionTimeoutMs = parseInt(process.env.VISION_FETCH_TIMEOUT_MS || "3000", 10);
      const visionRetryCount = Math.max(1, parseInt(process.env.VISION_FETCH_RETRY_COUNT || "3", 10));
      const visionRetryDelayMs = Math.max(100, parseInt(process.env.VISION_FETCH_RETRY_DELAY_MS || "350", 10));

      let cameraContext = "camera_unavailable";
      let fromCache = false;

      console.log("[Vision] Fetching visual context from YOLO...");
      for (let i = 0; i < visionRetryCount; i += 1) {
        if (!isAsrStillActive()) {
          console.log("[Vision] Skipping stale vision fetch after ASR state exit.");
          return "";
        }
        try {
          const response = await fetch("http://yolo-vision:5000/scene", {
            signal: AbortSignal.timeout(visionTimeoutMs),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = (await response.json()) as {
            scene: string;
            objects?: Array<{ name: string; count: number; color?: string | null }>;
            color_observations?: Array<{ name: string; color: string; pixel_ratio?: number }>;
            pipeline_fps?: number | null;
            inference_ms?: number | null;
          };

          const compactObjects = (data.objects || [])
            .slice(0, 5)
            .map((obj) =>
              obj.color
                ? `${obj.name}=${obj.count}(color=${obj.color})`
                : `${obj.name}=${obj.count}`,
            )
            .join(", ");

          const objectSummary = (data.objects || [])
            .slice(0, 6)
            .map((obj) => `${obj.count} ${obj.name}`)
            .join(", ");

          const sceneText = (data.scene || "").toLowerCase();
          const unavailableScene =
            sceneText.includes("camera unavailable") ||
            sceneText.includes("no camera stream") ||
            sceneText.includes("retrying camera sources") ||
            sceneText.includes("vision error") ||
            sceneText.includes("initializing");

          if (unavailableScene && !objectSummary) {
            throw new Error("YOLO scene is temporarily unavailable");
          }

          const compactColors = (data.color_observations || [])
            .slice(0, 5)
            .map((obs) =>
              `${obs.name}->${obs.color}${typeof obs.pixel_ratio === "number" ? `(${obs.pixel_ratio})` : ""}`,
            )
            .join(", ");

          const perfParts = [
            typeof data.pipeline_fps === "number" ? `fps=${data.pipeline_fps}` : "",
            typeof data.inference_ms === "number" ? `inference_ms=${Math.round(data.inference_ms)}` : "",
          ].filter(Boolean);

          const structuredParts = [
            compactObjects ? `objects(${compactObjects})` : "",
            compactColors ? `colors(${compactColors})` : "",
            data.scene ? `scene(${data.scene})` : "",
            perfParts.length > 0 ? `perf(${perfParts.join(",")})` : "",
          ].filter(Boolean);

          cameraContext = structuredParts.length > 0
            ? structuredParts.join(" | ")
            : "scene(I see no stable objects right now.)";
          this.lastVisionContext = cameraContext;
          this.cameraObjectsSummaryForLLM = objectSummary;
          this.cameraSceneSummaryForLLM = data.scene || "";
          break;
        } catch (e: any) {
          if (i < visionRetryCount - 1) {
            await new Promise((resolve) => setTimeout(resolve, visionRetryDelayMs));
          }
        }
      }

      if (cameraContext === "camera_unavailable" && this.lastVisionContext) {
        cameraContext = this.lastVisionContext;
        fromCache = true;
      }

      // Keep transcript clean and pass camera grounding through structured system prompt later.
      this.cameraContextForLLM = cameraContext;
      if (cameraContext === "camera_unavailable") {
        this.cameraObjectsSummaryForLLM = "";
        this.cameraSceneSummaryForLLM = "";
      }
      result = userTranscript;

      if (cameraContext === "camera_unavailable") {
        console.log("[Vision] Camera context unavailable after retries.");
      } else if (fromCache) {
        console.log(`[Vision] Injected cached camera context: ${cameraContext}`);
      } else {
        console.log(`[Vision] Successfully injected: ${cameraContext}`);
      }
    }
    return result;
  }

  partialThinkingCallback = (partialThinking: string): void => {
    this.partialThinking += partialThinking;
    const { sentences, remaining } = splitSentences(this.partialThinking);
    if (sentences.length > 0) {
      this.thinkingSentences.push(...sentences);
      const displayText = this.thinkingSentences.join(" ");
      display({
        status: "Thinking",
        emoji: "🤔",
        text: displayText,
        RGB: "#ff6800", // yellow
        scroll_speed: 6,
      });
    }
    this.partialThinking = remaining;
  };

  private syncWakeListenerForFlow = (nextFlow: FlowName): void => {
    if (!this.wakeWordListener) return;
    if (this.wakeListenerRestartTimer) {
      clearTimeout(this.wakeListenerRestartTimer);
      this.wakeListenerRestartTimer = null;
    }
    // Wake detector should only own the mic while idle; release it for active recording/ASR.
    if (nextFlow === "sleep") {
      const restartDelayMs = Math.max(
        0,
        parseInt(process.env.WAKE_WORD_RESTART_DELAY_MS || "1500", 10),
      );
      if (restartDelayMs <= 0) {
        this.wakeWordListener.start();
      } else {
        this.wakeListenerRestartTimer = setTimeout(() => {
          this.wakeWordListener?.start();
          this.wakeListenerRestartTimer = null;
        }, restartDelayMs);
      }
      return;
    }
    this.wakeWordListener.stop();
  };

  clearAnswerTimeout = (): void => {
    if (this.answerTimeoutTimer) {
      clearTimeout(this.answerTimeoutTimer);
      this.answerTimeoutTimer = null;
    }
    this.answerTimeoutArmedFlow = null;
  };

  armAnswerTimeout = (flowName: "answer" | "external_answer"): void => {
    if (this.answerTimeoutTimer && this.answerTimeoutArmedFlow === flowName) {
      return;
    }
    this.clearAnswerTimeout();
    if (!Number.isFinite(this.answerTimeoutMs) || this.answerTimeoutMs <= 0) {
      return;
    }
    this.answerTimeoutArmedFlow = flowName;
    this.answerTimeoutTimer = setTimeout(() => {
      if (this.currentFlowName !== flowName) return;
      console.log(
        `[Answer] Max duration ${this.answerTimeoutMs}ms reached. Returning to sleep.`,
      );
      // Invalidate in-flight callbacks for this answer turn.
      this.answerId += 1;
      this.streamResponser.stopAfterCurrentChunk();
      if (this.wakeSessionActive) {
        this.endWakeSession();
      }
    }, this.answerTimeoutMs);
  };

  transitionTo = (flowName: FlowName): void => {
    if (flowName !== "answer" && flowName !== "external_answer") {
      this.clearAnswerTimeout();
    }
    this.syncWakeListenerForFlow(flowName);
    console.log(`[${getCurrentTimeTag()}] switch to:`, flowName);
    this.stateMachine.transitionTo(flowName);
  };

  isAnswerFlow = (): boolean => {
    return (
      this.currentFlowName === "answer" ||
      this.currentFlowName === "external_answer"
    );
  };

  streamExternalReply = async (text: string, emoji?: string): Promise<void> => {
    if (!text) {
      this.streamResponser.endPartial();
      return;
    }
    if (emoji) {
      display({
        status: "answering",
        emoji,
        scroll_speed: 3,
      });
    }
    const { sentences, remaining } = splitSentences(text);
    const parts = [...sentences];
    if (remaining.trim()) {
      parts.push(remaining);
    }
    for (const part of parts) {
      this.streamResponser.partial(part);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    this.streamResponser.endPartial();
  };

  startWakeSession = (): void => {
    this.wakeSessionActive = true;
    this.wakeSessionStartAt = Date.now();
    this.wakeSessionLastSpeechAt = this.wakeSessionStartAt;
    this.wakeEmptyAsrRetries = 0;
    this.endAfterAnswer = false;
    playWakeupChime();
    this.transitionTo("wake_listening");
  };

  endWakeSession = (): void => {
    this.wakeSessionActive = false;
    this.wakeEmptyAsrRetries = 0;
    this.endAfterAnswer = false;
  };

  shouldContinueWakeSession = (): boolean => {
    if (!this.wakeSessionActive) return false;
    const last = this.wakeSessionLastSpeechAt || this.wakeSessionStartAt;
    return Date.now() - last < this.wakeSessionIdleTimeoutMs;
  };

  shouldEndAfterAnswer = (text: string): boolean => {
    const lower = text.toLowerCase();
    return this.wakeEndKeywords.some(
      (keyword) => keyword && lower.includes(keyword),
    );
  };
}

export default ChatFlow;
