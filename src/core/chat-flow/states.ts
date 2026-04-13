// import moment from "moment";
// import { compact, noop } from "lodash";
// import {
//   onButtonPressed,
//   onButtonReleased,
//   onButtonDoubleClick,
//   display,
//   getCurrentStatus,
//   onCameraCapture,
// } from "../../device/display";
// import {
//   recordAudio,
//   recordAudioManually,
//   recordFileFormat,
//   getDynamicVoiceDetectLevel,
// } from "../../device/audio";
// import { chatWithLLMStream } from "../../cloud-api/server";
// import { isImMode } from "../../cloud-api/llm";
// import { getSystemPromptWithKnowledge } from "../Knowledge";
// import { enableRAG } from "../../cloud-api/knowledge";
// import { cameraDir } from "../../utils/dir";
// import {
//   clearPendingCapturedImgForChat,
//   getLatestGenImg,
//   getLatestDisplayImg,
//   setLatestCapturedImg,
//   setPendingCapturedImgForChat,
// } from "../../utils/image";
// import { sendWhisplayIMMessage } from "../../cloud-api/whisplay-im/whisplay-im";
// import { ChatFlowContext, FlowName, FlowStateHandler } from "./types";
// import {
//   enterCameraMode,
//   handleCameraModePress,
//   handleCameraModeRelease,
//   onCameraModeExit,
//   resetCameraModeControl,
// } from "./camera-mode";
// import { DEFAULT_EMOJI } from "../../utils";

// let cachedVoiceDetectLevel: number | null = null;

// export const flowStates: Record<FlowName, FlowStateHandler> = {
//   sleep: (ctx: ChatFlowContext) => {
//     const webModeEnabled =
//       String(process.env.WHISPLAY_WEB_ENABLED || "").toLowerCase() === "true";
//     const allowCameraDoubleClick = ctx.enableCamera && !webModeEnabled;

//     onButtonPressed(() => {
//       resetCameraModeControl();
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//     onCameraModeExit(null);
//     if (allowCameraDoubleClick) {
//       const captureImgPath = `${cameraDir}/capture-${moment().format(
//         "YYYYMMDD-HHmmss",
//       )}.jpg`;
//       onButtonDoubleClick(() => {
//         enterCameraMode(captureImgPath);
//         ctx.transitionTo("camera");
//       });
//     }
//     display({
//       status: "idle",
//       emoji: "😴",
//       RGB: "#000055",
//       rag_icon_visible: false,
//       ...(getCurrentStatus().text === "Listening..."
//         ? {
//           text: `Press once to talk, press again to stop${allowCameraDoubleClick ? ",\ndouble click to launch camera" : ""
//             }.`,
//         }
//         : {}),
//     });
//   },
//   camera: (ctx: ChatFlowContext) => {
//     onButtonDoubleClick(null);
//     onButtonPressed(() => {
//       handleCameraModePress();
//     });
//     onButtonReleased(() => {
//       handleCameraModeRelease();
//     });
//     onCameraCapture(() => {
//       const captureImagePath = getCurrentStatus().capture_image_path;
//       if (!captureImagePath) {
//         return;
//       }
//       setLatestCapturedImg(captureImagePath);
//       setPendingCapturedImgForChat(captureImagePath);
//       display({ image_icon_visible: true });
//     });
//     onCameraModeExit(() => {
//       if (ctx.currentFlowName === "camera") {
//         ctx.transitionTo("sleep");
//       }
//     });
//     display({
//       status: "camera",
//       emoji: "📷",
//       RGB: "#00ff88",
//     });
//   },
//   listening: (ctx: ChatFlowContext) => {
//     ctx.isFromWakeListening = false;
//     ctx.answerId += 1;
//     ctx.wakeSessionActive = false;
//     ctx.endAfterAnswer = false;
//     const listenStartedAt = Date.now();
//     const minManualRecordMs = Math.max(
//       250,
//       parseInt(process.env.WHISPLAY_MIN_MANUAL_RECORD_MS || "700", 10),
//     );
//     const maxManualListenMs = Math.max(
//       minManualRecordMs + 800,
//       parseInt(process.env.WHISPLAY_MAX_MANUAL_LISTEN_MS || "8000", 10),
//     );
//     ctx.currentRecordFilePath = `${ctx.recordingsDir
//       }/user-${Date.now()}.${recordFileFormat}`;
//     onButtonPressed(noop);
//     const { result, stop } = recordAudioManually(ctx.currentRecordFilePath);

//     const forcedStopTimer = setTimeout(() => {
//       if (ctx.currentFlowName !== "listening") return;
//       console.log(
//         `[WebAudio] Force-stopping manual recording after ${maxManualListenMs}ms`,
//       );
//       stop();
//       display({
//         RGB: "#ff6800",
//         image: "",
//       });
//     }, maxManualListenMs);

//     const clearForcedStopTimer = () => {
//       clearTimeout(forcedStopTimer);
//     };

//     onButtonReleased(() => {
//       const elapsed = Date.now() - listenStartedAt;
//       if (elapsed < minManualRecordMs) {
//         console.log(
//           `[WebAudio] Ignoring early stop at ${elapsed}ms (min ${minManualRecordMs}ms)`,
//         );
//         return;
//       }
//       stop();
//       display({
//         RGB: "#ff6800",
//         image: "",
//       });
//     });
//     result
//       .then(() => {
//         clearForcedStopTimer();
//         ctx.transitionTo("asr");
//       })
//       .catch((err) => {
//         clearForcedStopTimer();
//         console.error("Error during recording:", err);
//         ctx.transitionTo("sleep");
//       });
//     display({
//       status: "listening",
//       emoji: DEFAULT_EMOJI,
//       RGB: "#00ff00",
//       text: "Listening...",
//       rag_icon_visible: false,
//     });
//   },
//   wake_listening: (ctx: ChatFlowContext) => {
//     ctx.isFromWakeListening = true;
//     ctx.answerId += 1;
//     ctx.currentRecordFilePath = `${ctx.recordingsDir
//       }/user-${Date.now()}.${recordFileFormat}`;
//     onButtonPressed(() => {
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//     display({
//       status: "detecting",
//       emoji: DEFAULT_EMOJI,
//       RGB: "#00ff00",
//       text: "Detecting voice level...",
//       rag_icon_visible: false,
//     });
//     const startWakeRecording = (level: number) => {
//       display({
//         status: "listening",
//         emoji: DEFAULT_EMOJI,
//         RGB: "#00ff00",
//         text: `(Detect level: ${level}%) Listening...`,
//         rag_icon_visible: false,
//       });
//       recordAudio(ctx.currentRecordFilePath, ctx.wakeRecordMaxSec, level)
//         .then(() => {
//           ctx.transitionTo("asr");
//         })
//         .catch((err) => {
//           console.error("Error during auto recording:", err);
//           ctx.endWakeSession();
//           ctx.transitionTo("sleep");
//         });
//     };

//     if (cachedVoiceDetectLevel !== null) {
//       startWakeRecording(cachedVoiceDetectLevel);
//       return;
//     }

//     getDynamicVoiceDetectLevel().then((level) => {
//       cachedVoiceDetectLevel = level;
//       startWakeRecording(level);
//     });
//   },
//   asr: (ctx: ChatFlowContext) => {
//     display({
//       status: "recognizing",
//     });
//     onButtonDoubleClick(null);
//     const asrTimeoutMs = Math.max(
//       4000,
//       parseInt(process.env.WHISPLAY_ASR_TIMEOUT_MS || "12000", 10),
//     );
//     const asrTimeoutHandle = setTimeout(() => {}, asrTimeoutMs);
//     Promise.race([
//       ctx.recognizeAudio(ctx.currentRecordFilePath, ctx.isFromWakeListening),
//       new Promise<string>((resolve) => {
//         onButtonPressed(() => {
//           resolve("[UserPress]");
//         });
//         onButtonReleased(noop);
//       }),
//       new Promise<string>((_, reject) => {
//         setTimeout(() => {
//           reject(new Error(`ASR timeout after ${asrTimeoutMs}ms`));
//         }, asrTimeoutMs);
//       }),
//     ]).then((result) => {
//       clearTimeout(asrTimeoutHandle);
//       if (ctx.currentFlowName !== "asr") return;
//       if (result === "[UserPress]") {
//         ctx.transitionTo("listening");
//         return;
//       }
//       if (result) {
//         console.log("Audio recognized result:", result);
//         ctx.asrText = result;
//         ctx.endAfterAnswer = ctx.shouldEndAfterAnswer(result);
//         if (ctx.wakeSessionActive) {
//           ctx.wakeSessionLastSpeechAt = Date.now();
//         }
//         display({ status: "recognizing", text: result });
//         ctx.transitionTo("answer");
//         return;
//       }
//       if (ctx.wakeSessionActive) {
//         if (ctx.shouldContinueWakeSession()) {
//           ctx.transitionTo("wake_listening");
//         } else {
//           ctx.endWakeSession();
//           ctx.transitionTo("sleep");
//         }
//         return;
//       }
//       ctx.transitionTo("sleep");
//     }).catch((err) => {
//       clearTimeout(asrTimeoutHandle);
//       console.error("[ASR] Recognition failed:", err);
//       display({
//         status: "error",
//         emoji: "⚠️",
//         text: "Speech recognition failed. Check API/network and try again.",
//         RGB: "#ff3333",
//       });
//       ctx.transitionTo("sleep");
//     });
//   },
//   answer: (ctx: ChatFlowContext) => {
//     display({
//       status: "answering...",
//       RGB: "#00c8a3",
//     });
//     const currentAnswerId = ctx.answerId;
//     if (isImMode) {
//       const prompt: {
//         role: "system" | "user";
//         content: string;
//       }[] = [
//           {
//             role: "user",
//             content: ctx.asrText,
//           },
//         ];
//       sendWhisplayIMMessage(prompt)
//         .then((ok) => {
//           if (ok) {
//             display({
//               status: "idle",
//               emoji: "🦞",
//               RGB: "#000055",
//             });
//           } else {
//             display({
//               status: "error",
//               emoji: "⚠️",
//               text: "OpenClaw send failed",
//             });
//           }
//         })
//         .finally(() => {
//           ctx.transitionTo("sleep");
//         });
//       return;
//     }
//     onButtonPressed(() => {
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//     const {
//       partial,
//       endPartial,
//       getPlayEndPromise,
//       stop: stopPlaying,
//     } = ctx.streamResponser;

//     const normalizedQuery = (ctx.asrText || "").toLowerCase();
//     const isSceneSummaryQuery =
//       /(what\s+(do|can)\s+you\s+see|describe\s+what\s+you\s+see|describe\s+the\s+(scene|view)|what\s+is\s+in\s+(front|the\s+camera\s+view))/i.test(
//         normalizedQuery,
//       );
//     const isVisionQuery =
//       /(what.*see|describe.*(scene|view|see)|who is there|what is in|how many|camera)/i.test(
//         normalizedQuery,
//       );

//     const parsedCounts = (ctx.cameraObjectsSummaryForLLM || "")
//       .split(",")
//       .map((item) => item.trim())
//       .filter(Boolean)
//       .reduce((acc, item) => {
//         const match = item.match(/^(\d+)\s+(.+)$/);
//         if (!match) return acc;
//         const count = parseInt(match[1], 10);
//         const name = match[2].trim().toLowerCase();
//         if (!Number.isFinite(count) || !name) return acc;
//         acc[name] = (acc[name] || 0) + count;
//         return acc;
//       }, {} as Record<string, number>);

//     const normalizeNoun = (text: string): string => {
//       let noun = text
//         .toLowerCase()
//         .replace(/[^a-z\s]/g, " ")
//         .replace(/\s+/g, " ")
//         .trim();
//       noun = noun.replace(/^(any|a|an|the|some)\s+/, "");
//       noun = noun.replace(/\s+(in|on|at|from|of|to)\s+.*$/, "");
//       noun = noun.replace(/\s+(here|there|now|currently)$/, "");

//       // Normalize common plural/alias forms used in speech transcripts.
//       const aliases: Record<string, string> = {
//         persons: "person",
//         people: "person",
//         chairs: "chair",
//         seats: "chair",
//         stools: "stool",
//         tables: "table",
//         televisions: "tv",
//         monitor: "tv",
//         monitors: "tv",
//         screens: "tv",
//         laptops: "laptop",
//       };
//       noun = aliases[noun] || noun;
//       return noun;
//     };

//     const pluralize = (word: string, count: number): string => {
//       const w = word.toLowerCase();
//       if (w === "person" || w === "people") {
//         return count === 1 ? "person" : "people";
//       }
//       if (w.endsWith("s")) {
//         return count === 1 ? w.slice(0, -1) : w;
//       }
//       return count === 1 ? w : `${w}s`;
//     };

//     const formatCountLabel = (name: string, count: number): string => {
//       return `${count} ${pluralize(name, count)}`;
//     };

//     const countForEntity = (entityRaw: string): number => {
//       const entity = normalizeNoun(entityRaw);
//       if (!entity) return 0;
//       const synonyms: Record<string, string[]> = {
//         person: ["person", "people", "man", "woman", "boy", "girl"],
//         chair: ["chair", "chairs", "seat", "seats", "stool", "stools"],
//         table: ["table", "tables", "dining table"],
//         tv: ["tv", "television", "monitor", "screen"],
//         laptop: ["laptop", "laptops"],
//       };

//       const keys = synonyms[entity] || [entity, `${entity}s`];
//       return Object.entries(parsedCounts)
//         .filter(([name]) =>
//           keys.some(
//             (k) => name === k || name.includes(` ${k}`) || name.endsWith(` ${k}`),
//           ),
//         )
//         .reduce((total, [, count]) => total + count, 0);
//     };

//     const sortedDetections = Object.entries(parsedCounts)
//       .sort((a, b) => b[1] - a[1]);

//     const joinNatural = (items: string[]): string => {
//       if (items.length <= 1) return items[0] || "";
//       if (items.length === 2) return `${items[0]} and ${items[1]}`;
//       return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
//     };

//     const stripTailNoise = (text: string): string => {
//       return text
//         .replace(/\b(do|can)\s+you\s+see\b.*$/i, "")
//         .replace(/\bare\s+there\b.*$/i, "")
//         .replace(/\bin\s+the\s+room\b.*$/i, "")
//         .replace(/\bin\s+the\s+current\s+camera\s+view\b.*$/i, "")
//         .replace(/\bright\s+now\b.*$/i, "")
//         .replace(/\bplease\b.*$/i, "")
//         .replace(/\bbriefly\b.*$/i, "")
//         .trim();
//     };

//     const sumByNames = (names: string[]): number =>
//       Object.entries(parsedCounts)
//         .filter(([name]) => names.some((n) => name === n || name.includes(`${n} `) || name.endsWith(` ${n}`)))
//         .reduce((total, [, count]) => total + count, 0);

//     const chairCount = sumByNames(["chair", "chairs", "seat", "seats", "stool", "stools"]);
//     const personCount = sumByNames(["person", "people", "man", "woman", "boy", "girl"]);

//     const isSeatCapacityQuery =
//       /(enough\s+(chairs|seats)|chairs?\s+for\s+everyone|seats?\s+for\s+everyone|enough\s+seats?|sit\s+down|seating)/i.test(
//         normalizedQuery,
//       );

//     if (isSeatCapacityQuery) {
//       let capacityReply = "I cannot confirm from the current camera view.";
//       if (chairCount > 0 || personCount > 0) {
//         if (chairCount >= personCount) {
//           capacityReply = `Yes. I detect ${formatCountLabel("chair", chairCount)} and ${formatCountLabel("person", personCount)}, so there appear to be enough seats.`;
//         } else {
//           capacityReply = `No. I detect ${formatCountLabel("chair", chairCount)} and ${formatCountLabel("person", personCount)}, so seats appear insufficient.`;
//         }
//       }
//       console.log(`[Vision] Deterministic seating reply: ${capacityReply}`);
//       partial(capacityReply);
//       endPartial();
//       return;
//     }

//     const extractHowManyTarget = (query: string): string => {
//       const match = query.match(
//         /(?:how many|number of)\s+(.+?)(?:\b(?:do|can)\s+you\s+see\b|\b(?:are|is)\s+there\b|\?|$)/i,
//       );
//       return (match?.[1] || "").trim();
//     };

//     const howManyTargetText = extractHowManyTarget(normalizedQuery);
//     if (howManyTargetText) {
//       let requested = stripTailNoise(howManyTargetText);

//       const targets = [...new Set(
//         requested
//           .split(/\s*(?:,| and |&)\s*/i)
//           .map((item) => normalizeNoun(item))
//           .filter(Boolean),
//       )];

//       const detectedParts: string[] = [];
//       const missingParts: string[] = [];
//       for (const target of targets) {
//         const count = countForEntity(target);
//         if (count > 0) {
//           detectedParts.push(formatCountLabel(target, count));
//         } else {
//           missingParts.push(pluralize(target, 2));
//         }
//       }

//       let reply = "I cannot confirm requested objects in the current camera view.";
//       if (detectedParts.length > 0 && missingParts.length === 0) {
//         reply = `I detect ${joinNatural(detectedParts)}.`;
//       } else if (detectedParts.length > 0) {
//         reply = `I detect ${joinNatural(detectedParts)}. I cannot confirm ${joinNatural(missingParts)}.`;
//       } else if (targets.length > 0) {
//         reply = `I cannot confirm ${joinNatural(missingParts)} in the current camera view.`;
//       }

//       console.log(`[Vision] Deterministic count reply: ${reply}`);
//       partial(reply);
//       endPartial();
//       return;
//     }

//     const presenceMatch = normalizedQuery.match(/^(?:is there|are there|do you see|can you see)\s+([a-z\s]+?)(?:\?|$)/i);
//     if (presenceMatch) {
//       const target = normalizeNoun(stripTailNoise(presenceMatch[1]));
//       if (!target) {
//         const fallbackReply = "I cannot confirm a specific object from the current camera view.";
//         console.log(`[Vision] Deterministic presence reply: ${fallbackReply}`);
//         partial(fallbackReply);
//         endPartial();
//         return;
//       }
//       const count = countForEntity(target);
//       const reply =
//         count > 0
//           ? `Yes. I detect ${formatCountLabel(target || "object", count)}.`
//           : `No. I cannot confirm ${target || "that"} in the current camera view.`;
//       console.log(`[Vision] Deterministic presence reply: ${reply}`);
//       partial(reply);
//       endPartial();
//       return;
//     }

//     const peoplePresenceQuery = /(who is there|anyone there|people there|is anyone there)/i.test(normalizedQuery);
//     if (peoplePresenceQuery) {
//       const reply =
//         personCount > 0
//           ? `I detect ${formatCountLabel("person", personCount)}.`
//           : "I cannot confirm people in the current camera view.";
//       console.log(`[Vision] Deterministic people reply: ${reply}`);
//       partial(reply);
//       endPartial();
//       return;
//     }

//     if (isSceneSummaryQuery) {
//       const topItems = sortedDetections
//         .slice(0, 6)
//         .map(([name, count]) => formatCountLabel(name, count));
//       const reply =
//         topItems.length > 0
//           ? `I see ${joinNatural(topItems)}.`
//           : "I cannot confirm objects from the current camera view.";
//       console.log(`[Vision] Deterministic scene summary reply: ${reply}`);
//       partial(reply);
//       endPartial();
//       return;
//     }

//     if (isVisionQuery) {
//       const topItems = sortedDetections
//         .slice(0, 6)
//         .map(([name, count]) => formatCountLabel(name, count));

//       const visionReply = topItems.length > 0
//         ? `I see ${joinNatural(topItems)}.`
//         : "I cannot confirm objects from the current camera view.";

//       console.log(`[Vision] Deterministic object reply: ${visionReply}`);
//       partial(visionReply);
//       endPartial();
//       return;
//     }

//     ctx.partialThinking = "";
//     ctx.thinkingSentences = [];
//     [() => Promise.resolve().then(() => ""), getSystemPromptWithKnowledge]
//     [enableRAG ? 1 : 0](ctx.asrText)
//       .then((res: string) => {
//         let knowledgePrompt = res;
//         if (res) {
//           console.log("Retrieved knowledge for RAG:\n", res);
//         }
//         if (ctx.knowledgePrompts.includes(res)) {
//           console.log(
//             "[RAG] Knowledge prompt already used in this session, skipping to avoid repetition.",
//           );
//           knowledgePrompt = "";
//         }
//         if (knowledgePrompt) {
//           ctx.knowledgePrompts.push(knowledgePrompt);
//         }
//         display({
//           rag_icon_visible: Boolean(enableRAG && knowledgePrompt),
//         });
//         const prompt: {
//           role: "system" | "user";
//           content: string;
//         }[] = compact([
//           {
//             role: "system",
//             content:
//               isVisionQuery
//                 ? ctx.cameraObjectsSummaryForLLM
//                   ? [
//                       "You are a camera-grounded assistant.",
//                       `CAMERA_OBJECTS: ${ctx.cameraObjectsSummaryForLLM}`,
//                       "Task: answer ONLY with object counts from CAMERA_OBJECTS.",
//                       "Output rules:",
//                       "1) One short sentence only.",
//                       "2) Mention only objects and counts.",
//                       "3) No extra details about walls, room, emotions, stories, or assumptions.",
//                       "4) If no objects, say: I cannot confirm objects from the current camera view.",
//                       "Good example: I see 3 chairs and 2 persons.",
//                     ].join("\n")
//                   : "I cannot confirm objects from the current camera view."
//                 : ctx.cameraContextForLLM && ctx.cameraContextForLLM !== "camera_unavailable"
//                 ? [
//                     "You are a camera-grounded assistant.",
//                     `CAMERA_GROUND_TRUTH: ${ctx.cameraContextForLLM}`,
//                     "Rules:",
//                     "1) Use only CAMERA_GROUND_TRUTH for scene/object/color claims.",
//                     "2) Do not say you cannot see or that you have no vision.",
//                     "3) If a requested detail is not present in CAMERA_GROUND_TRUTH, reply: 'I cannot confirm that from the current camera view.'",
//                     "4) Keep the answer under 35 words and specific.",
//                   ].join("\n")
//                 : "Live camera context is unavailable. Reply briefly: 'I cannot confirm from the current camera view. Please try again.' Do not invent scene details.",
//           },
//           knowledgePrompt
//             ? {
//               role: "system",
//               content: knowledgePrompt,
//             }
//             : null,
//           {
//             role: "user",
//             content: ctx.asrText,
//           },
//         ]);
//         console.log(`[Vision] System grounding sent to LLM: ${ctx.cameraContextForLLM}`);
//         void chatWithLLMStream(
//           prompt,
//           (text) => currentAnswerId === ctx.answerId && partial(text),
//           () => currentAnswerId === ctx.answerId && endPartial(),
//           (partialThinking) =>
//             currentAnswerId === ctx.answerId &&
//             ctx.partialThinkingCallback(partialThinking),
//           (functionName: string, result?: string) => {
//             if (
//               functionName === "generateImage" &&
//               result?.startsWith("[success]")
//             ) {
//               const img = getLatestGenImg();
//               if (img) {
//                 display({ image: img });
//               }
//             }
//             if (result) {
//               display({
//                 text: `[${functionName}]${result}`,
//               });
//             } else {
//               display({
//                 text: `Invoking [${functionName}]... {count}s`,
//               });
//             }
//           },
//         ).catch((err) => {
//           console.error("[LLM] Stream failed:", err);
//           if (currentAnswerId === ctx.answerId) {
//             partial("I had a temporary model connection issue. Please try again.");
//             endPartial();
//           }
//         });
//       });
//     getPlayEndPromise().then(() => {
//       if (ctx.currentFlowName === "answer") {
//         clearPendingCapturedImgForChat();
//         display({ image_icon_visible: false });
//         if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
//           if (ctx.endAfterAnswer) {
//             ctx.endWakeSession();
//             ctx.transitionTo("sleep");
//           } else {
//             ctx.transitionTo("wake_listening");
//           }
//           return;
//         }
//         const img = getLatestDisplayImg();
//         if (img) {
//           ctx.transitionTo("image");
//         } else {
//           ctx.transitionTo("sleep");
//         }
//       }
//     });
//     onButtonPressed(() => {
//       stopPlaying();
//       clearPendingCapturedImgForChat();
//       display({ image_icon_visible: false });
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//   },
//   image: (ctx: ChatFlowContext) => {
//     onButtonPressed(() => {
//       display({ image: "" });
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//   },
//   external_answer: (ctx: ChatFlowContext) => {
//     if (!ctx.pendingExternalReply) {
//       ctx.transitionTo("sleep");
//       return;
//     }
//     display({
//       status: "answering...",
//       RGB: "#00c8a3",
//       ...(ctx.pendingExternalEmoji ? { emoji: ctx.pendingExternalEmoji } : {}),
//     });
//     onButtonPressed(() => {
//       ctx.streamResponser.stop();
//       ctx.transitionTo("listening");
//     });
//     onButtonReleased(noop);
//     const replyText = ctx.pendingExternalReply;
//     const replyEmoji = ctx.pendingExternalEmoji;
//     ctx.currentExternalEmoji = replyEmoji;
//     ctx.pendingExternalReply = "";
//     ctx.pendingExternalEmoji = "";
//     void ctx.streamExternalReply(replyText, replyEmoji);
//     ctx.streamResponser.getPlayEndPromise().then(() => {
//       if (ctx.currentFlowName !== "external_answer") return;
//       if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
//         if (ctx.endAfterAnswer) {
//           ctx.endWakeSession();
//           ctx.transitionTo("sleep");
//         } else {
//           ctx.transitionTo("wake_listening");
//         }
//       } else {
//         ctx.transitionTo("sleep");
//       }
//     });
//   },
// };


// changes from here 

import moment from "moment";
import { compact, noop } from "lodash";
import {
  onButtonPressed,
  onButtonReleased,
  onButtonDoubleClick,
  display,
  getCurrentStatus,
  onCameraCapture,
} from "../../device/display";
import {
  recordAudio,
  recordAudioManually,
  recordFileFormat,
  getDynamicVoiceDetectLevel,
} from "../../device/audio";
import { chatWithLLMStream } from "../../cloud-api/server";
import { isImMode } from "../../cloud-api/llm";
import { getSystemPromptWithKnowledge } from "../Knowledge";
import { enableRAG } from "../../cloud-api/knowledge";
import { cameraDir } from "../../utils/dir";
import {
  clearPendingCapturedImgForChat,
  getLatestGenImg,
  getLatestDisplayImg,
  setLatestCapturedImg,
  setPendingCapturedImgForChat,
} from "../../utils/image";
import { sendWhisplayIMMessage } from "../../cloud-api/whisplay-im/whisplay-im";
import { ChatFlowContext, FlowName, FlowStateHandler } from "./types";
import {
  enterCameraMode,
  handleCameraModePress,
  handleCameraModeRelease,
  onCameraModeExit,
  resetCameraModeControl,
} from "./camera-mode";
import { DEFAULT_EMOJI } from "../../utils";

export const flowStates: Record<FlowName, FlowStateHandler> = {
  sleep: (ctx: ChatFlowContext) => {
    const webModeEnabled =
      String(process.env.WHISPLAY_WEB_ENABLED || "").toLowerCase() === "true";
    const allowCameraDoubleClick = ctx.enableCamera && !webModeEnabled;

    onButtonPressed(() => {
      resetCameraModeControl();
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    onCameraModeExit(null);
    if (allowCameraDoubleClick) {
      const captureImgPath = `${cameraDir}/capture-${moment().format(
        "YYYYMMDD-HHmmss",
      )}.jpg`;
      onButtonDoubleClick(() => {
        enterCameraMode(captureImgPath);
        ctx.transitionTo("camera");
      });
    }
    display({
      status: "idle",
      emoji: "😴",
      RGB: "#000055",
      rag_icon_visible: false,
      ...(getCurrentStatus().text === "Listening..."
        ? {
          text: `Press once to talk, press again to stop${allowCameraDoubleClick ? ",\ndouble click to launch camera" : ""
            }.`,
        }
        : {}),
    });
  },
  camera: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(() => {
      handleCameraModePress();
    });
    onButtonReleased(() => {
      handleCameraModeRelease();
    });
    onCameraCapture(() => {
      const captureImagePath = getCurrentStatus().capture_image_path;
      if (!captureImagePath) {
        return;
      }
      setLatestCapturedImg(captureImagePath);
      setPendingCapturedImgForChat(captureImagePath);
      display({ image_icon_visible: true });
    });
    onCameraModeExit(() => {
      if (ctx.currentFlowName === "camera") {
        ctx.transitionTo("sleep");
      }
    });
    display({
      status: "camera",
      emoji: "📷",
      RGB: "#00ff88",
    });
  },
  listening: (ctx: ChatFlowContext) => {
    ctx.isFromWakeListening = false;
    ctx.answerId += 1;
    ctx.wakeSessionActive = false;
    ctx.endAfterAnswer = false;
    const listenStartedAt = Date.now();
    const minManualRecordMs = Math.max(
      300,
      parseInt(process.env.WHISPLAY_MIN_MANUAL_RECORD_MS || "2000", 10),
    );
    const maxManualListenMs = Math.max(
      minManualRecordMs + 1000,
      parseInt(process.env.WHISPLAY_MAX_MANUAL_LISTEN_MS || "12000", 10),
    );
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(noop);
    const { result, stop } = recordAudioManually(ctx.currentRecordFilePath);

    const forcedStopTimer = setTimeout(() => {
      if (ctx.currentFlowName !== "listening") return;
      console.log(
        `[WebAudio] Force-stopping manual recording after ${maxManualListenMs}ms`,
      );
      stop();
      display({
        RGB: "#ff6800",
        image: "",
      });
    }, maxManualListenMs);

    const clearForcedStopTimer = () => {
      clearTimeout(forcedStopTimer);
    };

    onButtonReleased(() => {
      const elapsed = Date.now() - listenStartedAt;
      if (elapsed < minManualRecordMs) {
        console.log(
          `[WebAudio] Ignoring early stop at ${elapsed}ms (min ${minManualRecordMs}ms)`,
        );
        return;
      }
      stop();
      display({
        RGB: "#ff6800",
        image: "",
      });
    });
    result
      .then(() => {
        clearForcedStopTimer();
        ctx.transitionTo("asr");
      })
      .catch((err) => {
        clearForcedStopTimer();
        console.error("Error during recording:", err);
        ctx.transitionTo("sleep");
      });
    display({
      status: "listening",
      emoji: DEFAULT_EMOJI,
      RGB: "#00ff00",
      text: "Listening...",
      rag_icon_visible: false,
    });
  },
  wake_listening: (ctx: ChatFlowContext) => {
    ctx.isFromWakeListening = true;
    ctx.answerId += 1;
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(() => {
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    display({
      status: "detecting",
      emoji: DEFAULT_EMOJI,
      RGB: "#00ff00",
      text: "Detecting voice level...",
      rag_icon_visible: false,
    });
    getDynamicVoiceDetectLevel().then((level) => {
      display({
        status: "listening",
        emoji: DEFAULT_EMOJI,
        RGB: "#00ff00",
        text: `(Detect level: ${level}%) Listening...`,
        rag_icon_visible: false,
      });
      recordAudio(ctx.currentRecordFilePath, ctx.wakeRecordMaxSec, level)
        .then(() => {
          ctx.transitionTo("asr");
        })
        .catch((err) => {
          console.error("Error during auto recording:", err);
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        });
    });
  },
  asr: (ctx: ChatFlowContext) => {
    display({
      status: "recognizing",
    });
    onButtonDoubleClick(null);
    const asrTimeoutMs = Math.max(
      5000,
      parseInt(process.env.WHISPLAY_ASR_TIMEOUT_MS || "30000", 10),
    );
    const asrTimeoutHandle = setTimeout(() => {}, asrTimeoutMs);
    Promise.race([
      ctx.recognizeAudio(ctx.currentRecordFilePath, ctx.isFromWakeListening),
      new Promise<string>((resolve) => {
        onButtonPressed(() => {
          resolve("[UserPress]");
        });
        onButtonReleased(noop);
      }),
      new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`ASR timeout after ${asrTimeoutMs}ms`));
        }, asrTimeoutMs);
      }),
    ]).then((result) => {
      clearTimeout(asrTimeoutHandle);
      if (ctx.currentFlowName !== "asr") return;
      if (result === "[UserPress]") {
        ctx.transitionTo("listening");
        return;
      }
      if (result) {
        console.log("Audio recognized result:", result);
        ctx.asrText = result;
        ctx.endAfterAnswer = ctx.shouldEndAfterAnswer(result);
        if (ctx.wakeSessionActive) {
          ctx.wakeSessionLastSpeechAt = Date.now();
        }
        display({ status: "recognizing", text: result });
        ctx.transitionTo("answer");
        return;
      }
      if (ctx.wakeSessionActive) {
        if (ctx.shouldContinueWakeSession()) {
          ctx.transitionTo("wake_listening");
        } else {
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        }
        return;
      }
      ctx.transitionTo("sleep");
    }).catch((err) => {
      clearTimeout(asrTimeoutHandle);
      console.error("[ASR] Recognition failed:", err);
      display({
        status: "error",
        emoji: "⚠️",
        text: "Speech recognition failed. Check API/network and try again.",
        RGB: "#ff3333",
      });
      ctx.transitionTo("sleep");
    });
  },
  answer: (ctx: ChatFlowContext) => {
    display({
      status: "answering...",
      RGB: "#00c8a3",
    });
    const currentAnswerId = ctx.answerId;
    if (isImMode) {
      const prompt: {
        role: "system" | "user";
        content: string;
      }[] = [
          {
            role: "user",
            content: ctx.asrText,
          },
        ];
      sendWhisplayIMMessage(prompt)
        .then((ok) => {
          if (ok) {
            display({
              status: "idle",
              emoji: "🦞",
              RGB: "#000055",
            });
          } else {
            display({
              status: "error",
              emoji: "⚠️",
              text: "OpenClaw send failed",
            });
          }
        })
        .finally(() => {
          ctx.transitionTo("sleep");
        });
      return;
    }
    onButtonPressed(() => {
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    const {
      partial,
      endPartial,
      getPlayEndPromise,
      stop: stopPlaying,
    } = ctx.streamResponser;

    const normalizedQuery = (ctx.asrText || "").toLowerCase();
    const isVisionQuery =
      /(what.*see|describe.*(scene|view|see)|who is there|what is in|how many|camera)/i.test(
        normalizedQuery,
      );

    const parsedCounts = (ctx.cameraObjectsSummaryForLLM || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .reduce((acc, item) => {
        const match = item.match(/^(\d+)\s+(.+)$/);
        if (!match) return acc;
        const count = parseInt(match[1], 10);
        const name = match[2].trim().toLowerCase();
        if (!Number.isFinite(count) || !name) return acc;
        acc[name] = (acc[name] || 0) + count;
        return acc;
      }, {} as Record<string, number>);

    const normalizeNoun = (text: string): string => {
      let noun = text
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      noun = noun.replace(/^(any|a|an|the|some)\s+/, "");
      noun = noun.replace(/\s+(in|on|at|from|of|to)\s+.*$/, "");
      noun = noun.replace(/\s+(here|there|now|currently)$/, "");

      // Normalize common plural/alias forms used in speech transcripts.
      const aliases: Record<string, string> = {
        persons: "person",
        people: "person",
        chairs: "chair",
        seats: "chair",
        stools: "stool",
        tables: "table",
        televisions: "tv",
        monitor: "tv",
        monitors: "tv",
        screens: "tv",
        laptops: "laptop",
      };
      noun = aliases[noun] || noun;
      return noun;
    };

    const pluralize = (word: string, count: number): string => {
      const w = word.toLowerCase();
      if (w === "person" || w === "people") {
        return count === 1 ? "person" : "people";
      }
      if (w.endsWith("s")) {
        return count === 1 ? w.slice(0, -1) : w;
      }
      return count === 1 ? w : `${w}s`;
    };

    const formatCountLabel = (name: string, count: number): string => {
      return `${count} ${pluralize(name, count)}`;
    };

    const countForEntity = (entityRaw: string): number => {
      const entity = normalizeNoun(entityRaw);
      if (!entity) return 0;
      const synonyms: Record<string, string[]> = {
        person: ["person", "people", "man", "woman", "boy", "girl"],
        chair: ["chair", "chairs", "seat", "seats", "stool", "stools"],
        table: ["table", "tables", "dining table"],
        tv: ["tv", "television", "monitor", "screen"],
        laptop: ["laptop", "laptops"],
      };

      const keys = synonyms[entity] || [entity, `${entity}s`];
      return Object.entries(parsedCounts)
        .filter(([name]) =>
          keys.some(
            (k) => name === k || name.includes(` ${k}`) || name.endsWith(` ${k}`),
          ),
        )
        .reduce((total, [, count]) => total + count, 0);
    };

    const sortedDetections = Object.entries(parsedCounts)
      .sort((a, b) => b[1] - a[1]);

    const joinNatural = (items: string[]): string => {
      if (items.length <= 1) return items[0] || "";
      if (items.length === 2) return `${items[0]} and ${items[1]}`;
      return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
    };

    const sumByNames = (names: string[]): number =>
      Object.entries(parsedCounts)
        .filter(([name]) => names.some((n) => name === n || name.includes(`${n} `) || name.endsWith(` ${n}`)))
        .reduce((total, [, count]) => total + count, 0);

    const chairCount = sumByNames(["chair", "chairs", "seat", "seats", "stool", "stools"]);
    const personCount = sumByNames(["person", "people", "man", "woman", "boy", "girl"]);

    const isSeatCapacityQuery =
      /(enough\s+(chairs|seats)|chairs?\s+for\s+everyone|seats?\s+for\s+everyone|enough\s+seats?|sit\s+down|seating)/i.test(
        normalizedQuery,
      );

    if (isSeatCapacityQuery) {
      let capacityReply = "I cannot confirm from the current camera view.";
      if (chairCount > 0 || personCount > 0) {
        if (chairCount >= personCount) {
          capacityReply = `Yes. I detect ${formatCountLabel("chair", chairCount)} and ${formatCountLabel("person", personCount)}, so there appear to be enough seats.`;
        } else {
          capacityReply = `No. I detect ${formatCountLabel("chair", chairCount)} and ${formatCountLabel("person", personCount)}, so seats appear insufficient.`;
        }
      }
      console.log(`[Vision] Deterministic seating reply: ${capacityReply}`);
      partial(capacityReply);
      endPartial();
      return;
    }

    const howManyMatch = normalizedQuery.match(/(?:how many|number of)\s+(.+?)(?:\?|$)/i);
    if (howManyMatch) {
      let requested = howManyMatch[1]
        .replace(/\b(do|can)\s+you\s+see\b.*$/i, "")
        .replace(/\bare\s+there\b.*$/i, "")
        .replace(/\bin\s+the\s+room\b.*$/i, "")
        .replace(/\bin\s+the\s+current\s+camera\s+view\b.*$/i, "")
        .replace(/\bright\s+now\b.*$/i, "")
        .trim();

      const targets = [...new Set(
        requested
          .split(/\s*(?:,| and |&)\s*/i)
          .map((item) => normalizeNoun(item))
          .filter(Boolean),
      )];

      const detectedParts: string[] = [];
      const missingParts: string[] = [];
      for (const target of targets) {
        const count = countForEntity(target);
        if (count > 0) {
          detectedParts.push(formatCountLabel(target, count));
        } else {
          missingParts.push(pluralize(target, 2));
        }
      }

      let reply = "I cannot confirm requested objects in the current camera view.";
      if (detectedParts.length > 0 && missingParts.length === 0) {
        reply = `I detect ${joinNatural(detectedParts)}.`;
      } else if (detectedParts.length > 0) {
        reply = `I detect ${joinNatural(detectedParts)}. I cannot confirm ${joinNatural(missingParts)}.`;
      } else if (targets.length > 0) {
        reply = `I cannot confirm ${joinNatural(missingParts)} in the current camera view.`;
      }

      console.log(`[Vision] Deterministic count reply: ${reply}`);
      partial(reply);
      endPartial();
      return;
    }

    const presenceMatch = normalizedQuery.match(/^(?:is there|are there|do you see|can you see)\s+([a-z\s]+?)(?:\?|$)/i);
    if (presenceMatch) {
      const target = normalizeNoun(presenceMatch[1]);
      const count = countForEntity(target);
      const reply =
        count > 0
          ? `Yes. I detect ${formatCountLabel(target || "object", count)}.`
          : `No. I cannot confirm ${target || "that"} in the current camera view.`;
      console.log(`[Vision] Deterministic presence reply: ${reply}`);
      partial(reply);
      endPartial();
      return;
    }

    const peoplePresenceQuery = /(who is there|anyone there|people there|is anyone there)/i.test(normalizedQuery);
    if (peoplePresenceQuery) {
      const reply =
        personCount > 0
          ? `I detect ${formatCountLabel("person", personCount)}.`
          : "I cannot confirm people in the current camera view.";
      console.log(`[Vision] Deterministic people reply: ${reply}`);
      partial(reply);
      endPartial();
      return;
    }

    if (isVisionQuery) {
      const topItems = sortedDetections
        .slice(0, 6)
        .map(([name, count]) => formatCountLabel(name, count));

      const visionReply = topItems.length > 0
        ? `I see ${joinNatural(topItems)}.`
        : "I cannot confirm objects from the current camera view.";

      console.log(`[Vision] Deterministic object reply: ${visionReply}`);
      partial(visionReply);
      endPartial();
      return;
    }

    ctx.partialThinking = "";
    ctx.thinkingSentences = [];
    [() => Promise.resolve().then(() => ""), getSystemPromptWithKnowledge]
    [enableRAG ? 1 : 0](ctx.asrText)
      .then((res: string) => {
        let knowledgePrompt = res;
        if (res) {
          console.log("Retrieved knowledge for RAG:\n", res);
        }
        if (ctx.knowledgePrompts.includes(res)) {
          console.log(
            "[RAG] Knowledge prompt already used in this session, skipping to avoid repetition.",
          );
          knowledgePrompt = "";
        }
        if (knowledgePrompt) {
          ctx.knowledgePrompts.push(knowledgePrompt);
        }
        display({
          rag_icon_visible: Boolean(enableRAG && knowledgePrompt),
        });
        const prompt: {
          role: "system" | "user";
          content: string;
        }[] = compact([
          {
            role: "system",
            content:
              isVisionQuery
                ? ctx.cameraObjectsSummaryForLLM
                  ? [
                      "You are a camera-grounded assistant.",
                      `CAMERA_OBJECTS: ${ctx.cameraObjectsSummaryForLLM}`,
                      "Task: answer ONLY with object counts from CAMERA_OBJECTS.",
                      "Output rules:",
                      "1) One short sentence only.",
                      "2) Mention only objects and counts.",
                      "3) No extra details about walls, room, emotions, stories, or assumptions.",
                      "4) If no objects, say: I cannot confirm objects from the current camera view.",
                      "Good example: I see 3 chairs and 2 persons.",
                    ].join("\n")
                  : "I cannot confirm objects from the current camera view."
                : ctx.cameraContextForLLM && ctx.cameraContextForLLM !== "camera_unavailable"
                ? [
                    "You are a camera-grounded assistant.",
                    `CAMERA_GROUND_TRUTH: ${ctx.cameraContextForLLM}`,
                    "Rules:",
                    "1) Use only CAMERA_GROUND_TRUTH for scene/object/color claims.",
                    "2) Do not say you cannot see or that you have no vision.",
                    "3) If a requested detail is not present in CAMERA_GROUND_TRUTH, reply: 'I cannot confirm that from the current camera view.'",
                    "4) Keep the answer under 35 words and specific.",
                  ].join("\n")
                : "Live camera context is unavailable. Reply briefly: 'I cannot confirm from the current camera view. Please try again.' Do not invent scene details.",
          },
          knowledgePrompt
            ? {
              role: "system",
              content: knowledgePrompt,
            }
            : null,
          {
            role: "user",
            content: ctx.asrText,
          },
        ]);
        console.log(`[Vision] System grounding sent to LLM: ${ctx.cameraContextForLLM}`);
        void chatWithLLMStream(
          prompt,
          (text) => currentAnswerId === ctx.answerId && partial(text),
          () => currentAnswerId === ctx.answerId && endPartial(),
          (partialThinking) =>
            currentAnswerId === ctx.answerId &&
            ctx.partialThinkingCallback(partialThinking),
          (functionName: string, result?: string) => {
            if (
              functionName === "generateImage" &&
              result?.startsWith("[success]")
            ) {
              const img = getLatestGenImg();
              if (img) {
                display({ image: img });
              }
            }
            if (result) {
              display({
                text: `[${functionName}]${result}`,
              });
            } else {
              display({
                text: `Invoking [${functionName}]... {count}s`,
              });
            }
          },
        ).catch((err) => {
          console.error("[LLM] Stream failed:", err);
          if (currentAnswerId === ctx.answerId) {
            partial("I had a temporary model connection issue. Please try again.");
            endPartial();
          }
        });
      });
    getPlayEndPromise().then(() => {
      if (ctx.currentFlowName === "answer") {
        clearPendingCapturedImgForChat();
        display({ image_icon_visible: false });
        if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
          if (ctx.endAfterAnswer) {
            ctx.endWakeSession();
            ctx.transitionTo("sleep");
          } else {
            ctx.transitionTo("wake_listening");
          }
          return;
        }
        const img = getLatestDisplayImg();
        if (img) {
          ctx.transitionTo("image");
        } else {
          ctx.transitionTo("sleep");
        }
      }
    });
    onButtonPressed(() => {
      stopPlaying();
      clearPendingCapturedImgForChat();
      display({ image_icon_visible: false });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
  },
  image: (ctx: ChatFlowContext) => {
    onButtonPressed(() => {
      display({ image: "" });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
  },
  external_answer: (ctx: ChatFlowContext) => {
    if (!ctx.pendingExternalReply) {
      ctx.transitionTo("sleep");
      return;
    }
    display({
      status: "answering...",
      RGB: "#00c8a3",
      ...(ctx.pendingExternalEmoji ? { emoji: ctx.pendingExternalEmoji } : {}),
    });
    onButtonPressed(() => {
      ctx.streamResponser.stop();
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    const replyText = ctx.pendingExternalReply;
    const replyEmoji = ctx.pendingExternalEmoji;
    ctx.currentExternalEmoji = replyEmoji;
    ctx.pendingExternalReply = "";
    ctx.pendingExternalEmoji = "";
    void ctx.streamExternalReply(replyText, replyEmoji);
    ctx.streamResponser.getPlayEndPromise().then(() => {
      if (ctx.currentFlowName !== "external_answer") return;
      if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
        if (ctx.endAfterAnswer) {
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        } else {
          ctx.transitionTo("wake_listening");
        }
      } else {
        ctx.transitionTo("sleep");
      }
    });
  },
};