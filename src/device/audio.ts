// import { spawn, ChildProcess } from "child_process";
// import { isEmpty, noop, set } from "lodash";
// import dotenv from "dotenv";
// import { ttsServer, asrServer } from "../cloud-api/server";
// import { pluginRegistry } from "../plugin";
// import type { ASRPlugin, TTSPlugin, AudioFormat } from "../plugin";
// import { ASRServer, TTSResult, TTSServer } from "../type";
// import { webAudioBridge } from "./web-audio-bridge";

// export { getDynamicVoiceDetectLevel } from "./voice-detect";

// dotenv.config();

// const soundCardIndex = process.env.SOUND_CARD_INDEX || "1";
// const alsaOutputDevice = `hw:${soundCardIndex},0`;
// const soxQuiet = (process.env.SOX_QUIET || "true").toLowerCase() === "true";
// const normalizeAudioFormat = (value: string | undefined, fallback: AudioFormat): AudioFormat => {
//   const normalized = (value || "").toLowerCase();
//   return normalized === "wav" || normalized === "mp3" ? normalized : fallback;
// };

// const defaultTtsAudioFormat: AudioFormat = [TTSServer.gemini, TTSServer.piper].includes(ttsServer)
//   ? "wav"
//   : "mp3";

// const selectedTtsPlugin = pluginRegistry.getPlugin("tts", ttsServer) as TTSPlugin | undefined;
// const ttsAudioFormat: AudioFormat = normalizeAudioFormat(
//   selectedTtsPlugin?.audioFormat,
//   defaultTtsAudioFormat,
// );

// const useWavPlayer = ttsAudioFormat === "wav";

// const defaultAsrAudioFormat: AudioFormat = [
//   ASRServer.vosk,
//   ASRServer.whisper,
//   ASRServer.whisperhttp,
//   ASRServer.fasterwhisper,
//   ASRServer.llm8850whisper,
// ].includes(asrServer)
//   ? "wav"
//   : "mp3";

// const selectedAsrPlugin = pluginRegistry.getPlugin("asr", asrServer) as ASRPlugin | undefined;

// export const recordFileFormat: AudioFormat = normalizeAudioFormat(
//   selectedAsrPlugin?.audioFormat,
//   defaultAsrAudioFormat,
// );

// function startPlayerProcess() {
//   if (useWavPlayer) {
//     return null;
//   } else {
//     // use mpg123 for mp3 files
//     return spawn("mpg123", [
//       "-",
//       "--scale",
//       "2",
//       "-o",
//       "alsa",
//       "-a",
//       alsaOutputDevice,
//     ]);
//   }
// }

// let recordingProcessList: ChildProcess[] = [];
// let currentRecordingReject: (reason?: any) => void = noop;

// const killAllRecordingProcesses = (): void => {
//   recordingProcessList.forEach((child) => {
//     console.log("Killing recording process", child.pid);
//     try {
//       child.kill("SIGINT");
//     } catch (e) { }
//   });
//   recordingProcessList.length = 0;
// };

// export const playWakeupChime = (): Promise<void> => {
//   return new Promise((resolve) => {
//     let finished = false;
//     const done = () => {
//       if (finished) {
//         return;
//       }
//       finished = true;
//       resolve();
//     };

//     //     play -n \
//     // synth 0.10 sine 720 vol 0.4 : \
//     // synth 0.12 sine 980 vol 0.35 : \
//     // synth 0.14 sine 1320 vol 0.3 \
//     // fade q 0.02 0.30 0.08 gain -30

//     const chimeProcess = spawn("sox", [
//       "-n",
//       "-t",
//       "alsa",
//       alsaOutputDevice,
//       "synth",
//       "0.10",
//       "sine",
//       "720",
//       "vol",
//       "0.4",
//       ":",
//       "synth",
//       "0.12",
//       "sine",
//       "980",
//       "vol",
//       "0.35",
//       ":",
//       "synth",
//       "0.14",
//       "sine",
//       "1320",
//       "vol",
//       "0.3",
//       "fade",
//       "q",
//       "0.02",
//       "0.30",
//       "0.08",
//       "gain",
//       "-30",
//     ]);

//     chimeProcess.on("error", done);
//     chimeProcess.on("exit", done);

//     setTimeout(done, 1500);
//   });
// };

// const recordAudio = async (
//   outputPath: string,
//   duration: number = 10,
//   voiceDetectLevel: number = 30,
// ): Promise<string> => {
//   // Delegate to browser microphone when web audio is enabled and a client is connected.
//   if (webAudioBridge.isAvailable()) {
//     console.log(`[WebAudio] Starting browser recording, max ${duration} seconds...`);
//     return webAudioBridge.startRecording(outputPath, duration);
//   }

//   return new Promise((resolve, reject) => {
//     const args = [
//       ...(soxQuiet ? ["-q"] : []),
//       "-t",
//       "alsa",
//       "default",
//       "-t",
//       recordFileFormat,
//       "-c",
//       "1",
//       "-r",
//       "16000",
//       outputPath,
//       "silence",
//       "1",
//       "0.1",
//       `${voiceDetectLevel}%`,
//       "1",
//       "0.7",
//       `${voiceDetectLevel}%`,
//     ];
//     console.log(`Starting recording, maximum ${duration} seconds...`);
//     currentRecordingReject = reject;
//     const recordingProcess = spawn("sox", args);

//     recordingProcess.on("error", (err) => {
//       killAllRecordingProcesses();
//       reject(err);
//     });

//     recordingProcess.stdout?.on("data", (data) => {
//       console.log(data.toString());
//     });
//     recordingProcess.stderr?.on("data", (data) => {
//       console.error(data.toString());
//     });

//     recordingProcess.on("exit", (code) => {
//       if (code && code !== 0) {
//         killAllRecordingProcesses();
//         reject(code);
//         return;
//       }
//       resolve(outputPath);
//       killAllRecordingProcesses();
//     });
//     recordingProcessList.push(recordingProcess);

//     // Set a timeout to kill the recording process after the specified duration
//     setTimeout(() => {
//       if (recordingProcessList.includes(recordingProcess)) {
//         killAllRecordingProcesses();
//         resolve(outputPath);
//       }
//     }, duration * 1000);
//   });
// };

// const recordAudioManually = (
//   outputPath: string
// ): { result: Promise<string>; stop: () => void } => {
//   // Delegate to browser microphone when web audio is enabled and a client is connected.
//   if (webAudioBridge.isAvailable()) {
//     console.log(`[WebAudio] Starting manual browser recording...`);
//     return webAudioBridge.startManualRecording(outputPath);
//   }

//   let stopFunc: () => void = noop;
//   const result = new Promise<string>((resolve, reject) => {
//     currentRecordingReject = reject;
//     const recordingProcess = spawn("sox", [
//       ...(soxQuiet ? ["-q"] : []),
//       "-t",
//       "alsa",
//       "default",
//       "-t",
//       recordFileFormat,
//       "-c",
//       "1",
//       "-r",
//       "16000",
//       outputPath,
//     ]);

//     recordingProcess.on("error", (err) => {
//       killAllRecordingProcesses();
//       reject(err);
//     });

//     recordingProcess.stderr?.on("data", (data) => {
//       console.error(data.toString());
//     });
//     recordingProcessList.push(recordingProcess);
//     stopFunc = () => {
//       killAllRecordingProcesses();
//     };
//     recordingProcess.on("exit", () => {
//       resolve(outputPath);
//     });
//   });
//   return {
//     result,
//     stop: stopFunc,
//   };
// };

// const stopRecording = (): void => {
//   // Also stop any in-progress web recording.
//   webAudioBridge.stopRecording();

//   if (!isEmpty(recordingProcessList)) {
//     killAllRecordingProcesses();
//     try {
//       currentRecordingReject();
//     } catch (e) { }
//     console.log("Recording stopped");
//   } else {
//     console.log("No recording process running");
//   }
// };

// interface Player {
//   isPlaying: boolean;
//   process: ChildProcess | null;
// }

// const player: Player = {
//   isPlaying: false,
//   process: null,
// };

// setTimeout(() => {
//   player.process = startPlayerProcess();
// }, 5000);

// const playAudioData = (params: TTSResult): Promise<void> => {
//   // Delegate to browser speaker when web audio is enabled and a client is connected.
//   if (webAudioBridge.isAvailable()) {
//     console.log("[WebAudio] Sending audio to browser for playback.");
//     return webAudioBridge.playAudioData(params, ttsAudioFormat);
//   }

//   const { duration: audioDuration, filePath, base64, buffer } = params;
//   if (audioDuration <= 0 || (!filePath && !base64 && !buffer)) {
//     console.log("No audio data to play, skipping playback.");
//     return Promise.resolve();
//   }
//   // play wav file using aplay
//   if (filePath) {
//     return Promise.race([
//       new Promise<void>((resolve) => {
//         setTimeout(() => {
//           resolve();
//         }, audioDuration + 1000);
//       }),
//       new Promise<void>((resolve, reject) => {
//         console.log("Playback duration:", audioDuration);
//         player.isPlaying = true;
//         const process = spawn("sox", [filePath, "-t", "alsa", alsaOutputDevice]);
//         process.on("close", (code: number) => {
//           player.isPlaying = false;
//           if (code !== 0) {
//             console.error(`Audio playback error: ${code}`);
//             reject(code);
//           } else {
//             console.log("Audio playback completed");
//             resolve();
//           }
//         });
//       }),
//     ]).catch((error) => {
//       console.error("Audio playback error:", error);
//     });
//   }

//   // play wav/mp3 buffer based on configured TTS format
//   return new Promise((resolve, reject) => {
//     const audioBuffer = base64 ? Buffer.from(base64, "base64") : buffer;
//     console.log("Playback duration:", audioDuration);
//     player.isPlaying = true;
//     setTimeout(() => {
//       resolve();
//       player.isPlaying = false;
//       console.log("Audio playback completed");
//     }, audioDuration); // Add 1 second buffer

//     if (ttsAudioFormat === "wav") {
//       const process = spawn("sox", [
//         "-t",
//         "wav",
//         "-",
//         "-t",
//         "alsa",
//         alsaOutputDevice,
//       ]);
//       process.stdout?.on("data", (data) => console.log(data.toString()));
//       process.stderr?.on("data", (data) => console.error(data.toString()));
//       process.on("exit", (code) => {
//         player.isPlaying = false;
//         if (code !== 0) {
//           console.error(`Audio playback error: ${code}`);
//           reject(code);
//         } else {
//           console.log("Audio playback completed");
//           resolve();
//         }
//       });
//       process.stdin?.end(audioBuffer);
//       return;
//     }

//     const process = player.process;
//     if (!process) {
//       return reject(new Error("Audio player is not initialized."));
//     }

//     try {
//       process.stdin?.write(audioBuffer);
//     } catch (e) { }
//     process.stdout?.on("data", (data) => console.log(data.toString()));
//     process.stderr?.on("data", (data) => console.error(data.toString()));
//     process.on("exit", (code) => {
//       player.isPlaying = false;
//       if (code !== 0) {
//         console.error(`Audio playback error: ${code}`);
//         reject(code);
//       } else {
//         console.log("Audio playback completed");
//         resolve();
//       }
//     });
//   });
// };

// const stopPlaying = (): void => {
//   // Also stop any in-progress web playback.
//   webAudioBridge.stopPlayback();

//   if (player.isPlaying) {
//     try {
//       console.log("Stopping audio playback");
//       const process = player.process;
//       if (process) {
//         process.stdin?.end();
//         process.kill();
//       }
//     } catch { }
//     player.isPlaying = false;
//     // Recreate process
//     setTimeout(() => {
//       player.process = startPlayerProcess();
//     }, 500);
//   } else {
//     console.log("No audio currently playing");
//   }
// };

// // Close audio player when exiting program
// process.on("SIGINT", () => {
//   try {
//     if (player.process) {
//       player.process.stdin?.end();
//       player.process.kill();
//     }
//   } catch { }
//   process.exit();
// });

// export {
//   recordAudio,
//   recordAudioManually,
//   stopRecording,
//   playAudioData,
//   stopPlaying,
// };

//the changes are from here

import { spawn, ChildProcess } from "child_process";
import { isEmpty, noop } from "lodash";
import dotenv from "dotenv";
import { ttsServer, asrServer } from "../cloud-api/server";
import { pluginRegistry } from "../plugin";
import type { ASRPlugin, TTSPlugin, AudioFormat } from "../plugin";
import { ASRServer, TTSResult, TTSServer } from "../type";
import { webAudioBridge } from "./web-audio-bridge";

export { getDynamicVoiceDetectLevel } from "./voice-detect";

dotenv.config();

const soundCardIndex = process.env.SOUND_CARD_INDEX || "1";
const alsaOutputDevice = `hw:${soundCardIndex},0`;
const alsaInputDevice =
  process.env.AUDIODEV || process.env.WAKE_WORD_AUDIO_DEVICE || "default";
const audioInputChannel =
  (process.env.AUDIO_INPUT_CHANNEL || process.env.WAKE_WORD_AUDIO_CHANNEL || "1").trim();
const getAudioInputChannelCount = (spec: string): number => {
  const numbers = (spec.match(/\d+/g) || []).map((item) => parseInt(item, 10));
  if (numbers.length === 0) {
    return 1;
  }
  return Math.max(1, ...numbers);
};
const audioInputChannelCount = getAudioInputChannelCount(audioInputChannel);
const audioInputHighpassHz = Math.max(
  0,
  parseInt(process.env.AUDIO_INPUT_HIGHPASS_HZ || "70", 10),
);
const audioInputLowpassHz = Math.max(
  0,
  parseInt(process.env.AUDIO_INPUT_LOWPASS_HZ || "7000", 10),
);
const normalizeAudioFormat = (value: string | undefined, fallback: AudioFormat): AudioFormat => {
  const normalized = (value || "").toLowerCase();
  return normalized === "wav" || normalized === "mp3" ? normalized : fallback;
};

const defaultTtsAudioFormat: AudioFormat = [TTSServer.gemini, TTSServer.piper].includes(ttsServer)
  ? "wav"
  : "mp3";

const selectedTtsPlugin = pluginRegistry.getPlugin("tts", ttsServer) as TTSPlugin | undefined;
const ttsAudioFormat: AudioFormat = normalizeAudioFormat(
  selectedTtsPlugin?.audioFormat,
  defaultTtsAudioFormat,
);

const useWavPlayer = ttsAudioFormat === "wav";

const defaultAsrAudioFormat: AudioFormat = [
  ASRServer.vosk,
  ASRServer.whisper,
  ASRServer.whisperhttp,
  ASRServer.fasterwhisper,
  ASRServer.llm8850whisper,
].includes(asrServer)
  ? "wav"
  : "mp3";

const selectedAsrPlugin = pluginRegistry.getPlugin("asr", asrServer) as ASRPlugin | undefined;

export const recordFileFormat: AudioFormat = normalizeAudioFormat(
  selectedAsrPlugin?.audioFormat,
  defaultAsrAudioFormat,
);

function startPlayerProcess() {
  if (useWavPlayer) {
    return null;
  } else {
    // use mpg123 for mp3 files
    return spawn("mpg123", [
      "-",
      "--scale",
      "2",
      "-o",
      "alsa",
      "-a",
      alsaOutputDevice,
    ]);
  }
}

let recordingProcessList: ChildProcess[] = [];
let currentRecordingReject: (reason?: any) => void = noop;

const killAllRecordingProcesses = (): void => {
  recordingProcessList.forEach((child) => {
    console.log("Killing recording process", child.pid);
    try {
      child.kill("SIGINT");
    } catch (e) { }
  });
  recordingProcessList.length = 0;
};

export const playWakeupChime = (): Promise<void> => {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    };

    //     play -n \
    // synth 0.10 sine 720 vol 0.4 : \
    // synth 0.12 sine 980 vol 0.35 : \
    // synth 0.14 sine 1320 vol 0.3 \
    // fade q 0.02 0.30 0.08 gain -30

    const chimeProcess = spawn("sox", [
      "-n",
      "-t",
      "alsa",
      alsaOutputDevice,
      "synth",
      "0.10",
      "sine",
      "720",
      "vol",
      "0.4",
      ":",
      "synth",
      "0.12",
      "sine",
      "980",
      "vol",
      "0.35",
      ":",
      "synth",
      "0.14",
      "sine",
      "1320",
      "vol",
      "0.3",
      "fade",
      "q",
      "0.02",
      "0.30",
      "0.08",
      "gain",
      "-30",
    ]);

    chimeProcess.on("error", done);
    chimeProcess.on("exit", done);

    setTimeout(done, 1500);
  });
};

const recordAudio = async (
  outputPath: string,
  duration: number = 10,
  voiceDetectLevel: number = 30,
): Promise<string> => {
  // Delegate to browser microphone when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log(`[WebAudio] Starting browser recording, max ${duration} seconds...`);
    return webAudioBridge.startRecording(outputPath, duration);
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-t",
      "alsa",
      alsaInputDevice,
      "-t",
      recordFileFormat,
      "-c",
      `${audioInputChannelCount}`,
      "-r",
      "16000",
      outputPath,
      "remix",
      "-m",
      audioInputChannel,
      "highpass",
      `${audioInputHighpassHz}`,
      "lowpass",
      `${audioInputLowpassHz}`,
      "silence",
      "1",
      "0.1",
      `${voiceDetectLevel}%`,
      "1",
      "0.7",
      `${voiceDetectLevel}%`,
    ];
    console.log(`Starting recording, maximum ${duration} seconds...`);
    console.log(`[Audio] Recording input device: ${alsaInputDevice}`);
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", args);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stdout?.on("data", (data) => {
      console.log(data.toString());
    });
    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });

    recordingProcess.on("exit", (code) => {
      if (code && code !== 0) {
        killAllRecordingProcesses();
        reject(code);
        return;
      }
      resolve(outputPath);
      killAllRecordingProcesses();
    });
    recordingProcessList.push(recordingProcess);

    // Set a timeout to kill the recording process after the specified duration
    setTimeout(() => {
      if (recordingProcessList.includes(recordingProcess)) {
        killAllRecordingProcesses();
        resolve(outputPath);
      }
    }, duration * 1000);
  });
};

const recordAudioForDuration = async (
  outputPath: string,
  duration: number = 10,
): Promise<string> => {
  // Delegate to browser microphone when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log(`[WebAudio] Starting browser fixed recording, max ${duration} seconds...`);
    return webAudioBridge.startRecording(outputPath, duration);
  }

  return new Promise((resolve, reject) => {
    const earlyStopOnSilenceRequested =
      String(process.env.WAKE_WORD_EARLY_STOP_ON_SILENCE || "false").toLowerCase() === "true";
    const earlyStopMinDurationSec = Math.max(
      0,
      parseFloat(process.env.WAKE_WORD_EARLY_STOP_MIN_DURATION_SEC || "9"),
    );
    const earlyStopOnSilence =
      earlyStopOnSilenceRequested && duration >= earlyStopMinDurationSec;
    const wakeRecordGainDb = (
      process.env.WAKE_WORD_RECORD_GAIN_DB ||
      process.env.WAKE_WORD_ASR_GAIN_DB ||
      "0"
    ).trim();
    const silenceSec = Math.max(
      0.3,
      parseFloat(process.env.WAKE_WORD_EARLY_STOP_SILENCE_SEC || "0.7"),
    );
    const silenceLevelPercent = Math.max(
      0.2,
      parseFloat(process.env.WAKE_WORD_EARLY_STOP_LEVEL_PERCENT || "1.2"),
    );

    const args = [
      "-t",
      "alsa",
      alsaInputDevice,
      "-t",
      recordFileFormat,
      "-c",
      `${audioInputChannelCount}`,
      "-r",
      "16000",
      outputPath,
      "remix",
      "-m",
      audioInputChannel,
      "highpass",
      `${audioInputHighpassHz}`,
      "lowpass",
      `${audioInputLowpassHz}`,
    ];

    if (wakeRecordGainDb && !["0", "0.0"].includes(wakeRecordGainDb)) {
      args.push("gain", wakeRecordGainDb);
    }

    if (earlyStopOnSilence) {
      // Hybrid capture: start when voice appears, stop shortly after silence,
      // but still keep the outer max-duration timeout as a hard limit.
      args.push(
        "silence",
        "1",
        "0.12",
        `${silenceLevelPercent}%`,
        "1",
        `${silenceSec}`,
        `${silenceLevelPercent}%`,
      );
    }

    console.log(`Starting fixed recording, maximum ${duration} seconds...`);
    console.log(`[Audio] Recording input device: ${alsaInputDevice}`);
    if (wakeRecordGainDb && !["0", "0.0"].includes(wakeRecordGainDb)) {
      console.log(`[Audio] Wake capture gain enabled (${wakeRecordGainDb}dB)`);
    }
    if (earlyStopOnSilence) {
      console.log(
        `[Audio] Wake early-stop enabled (silenceSec=${silenceSec}, level=${silenceLevelPercent}%)`,
      );
    } else if (earlyStopOnSilenceRequested) {
      console.log(
        `[Audio] Wake early-stop request ignored for short capture (${duration}s < ${earlyStopMinDurationSec}s).`,
      );
    }
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", args);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stdout?.on("data", (data) => {
      console.log(data.toString());
    });
    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });

    recordingProcess.on("exit", (code) => {
      if (code && code !== 0) {
        killAllRecordingProcesses();
        reject(code);
        return;
      }
      resolve(outputPath);
      killAllRecordingProcesses();
    });
    recordingProcessList.push(recordingProcess);

    // Stop recording after fixed duration and continue with ASR.
    setTimeout(() => {
      if (recordingProcessList.includes(recordingProcess)) {
        killAllRecordingProcesses();
        resolve(outputPath);
      }
    }, duration * 1000);
  });
};

const recordAudioManually = (
  outputPath: string
): { result: Promise<string>; stop: () => void } => {
  // Delegate to browser microphone when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log(`[WebAudio] Starting manual browser recording...`);
    return webAudioBridge.startManualRecording(outputPath);
  }

  let stopFunc: () => void = noop;
  const result = new Promise<string>((resolve, reject) => {
    const manualRecordGainDb = (
      process.env.WHISPLAY_MANUAL_RECORD_GAIN_DB ||
      process.env.WAKE_WORD_RECORD_GAIN_DB ||
      process.env.WAKE_WORD_ASR_GAIN_DB ||
      "0"
    ).trim();
    const args = [
      "-t",
      "alsa",
      alsaInputDevice,
      "-t",
      recordFileFormat,
      "-c",
      `${audioInputChannelCount}`,
      "-r",
      "16000",
      outputPath,
      "remix",
      "-m",
      audioInputChannel,
      "highpass",
      `${audioInputHighpassHz}`,
      "lowpass",
      `${audioInputLowpassHz}`,
    ];
    if (manualRecordGainDb && !["0", "0.0"].includes(manualRecordGainDb)) {
      args.push("gain", manualRecordGainDb);
    }

    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", args);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    console.log(`[Audio] Manual recording input device: ${alsaInputDevice}`);
    if (manualRecordGainDb && !["0", "0.0"].includes(manualRecordGainDb)) {
      console.log(`[Audio] Manual capture gain enabled (${manualRecordGainDb}dB)`);
    }

    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });
    recordingProcessList.push(recordingProcess);
    stopFunc = () => {
      killAllRecordingProcesses();
    };
    recordingProcess.on("exit", () => {
      resolve(outputPath);
    });
  });
  return {
    result,
    stop: stopFunc,
  };
};

const stopRecording = (): void => {
  // Also stop any in-progress web recording.
  webAudioBridge.stopRecording();

  if (!isEmpty(recordingProcessList)) {
    killAllRecordingProcesses();
    try {
      currentRecordingReject();
    } catch (e) { }
    console.log("Recording stopped");
  } else {
    console.log("No recording process running");
  }
};

interface Player {
  isPlaying: boolean;
  process: ChildProcess | null;
}

const player: Player = {
  isPlaying: false,
  process: null,
};

const getAlsaPlaybackTargets = (): string[] => {
  const candidates = [
    process.env.WHISPLAY_ALSA_OUTPUT_DEVICE || "",
    alsaOutputDevice,
    "default",
  ]
    .map((item) => (item || "").trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
};

const playWavWithFallback = async (
  sourceArgs: string[],
  timeoutMs: number,
): Promise<void> => {
  const devices = getAlsaPlaybackTargets();
  let lastError: unknown = null;

  for (const device of devices) {
    try {
      await new Promise<void>((resolve, reject) => {
        const process = spawn("sox", [...sourceArgs, "-t", "alsa", device]);
        let finished = false;
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try {
            process.kill("SIGKILL");
          } catch {
            // ignore kill errors
          }
          reject(new Error(`playback timeout on device=${device}`));
        }, Math.max(1200, timeoutMs));

        process.stdout?.on("data", (data) => console.log(data.toString()));
        process.stderr?.on("data", (data) => console.error(data.toString()));

        process.on("error", (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(error);
        });

        process.on("close", (code: number) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Audio playback error: ${code} on device=${device}`));
          } else {
            resolve();
          }
        });
      });
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[Audio] Playback failed on device=${device}, trying fallback...`);
    }
  }

  throw lastError || new Error("Audio playback failed on all ALSA devices");
};

setTimeout(() => {
  player.process = startPlayerProcess();
}, 5000);

const playAudioData = (params: TTSResult): Promise<void> => {
  // Delegate to browser speaker when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log("[WebAudio] Sending audio to browser for playback.");
    return webAudioBridge.playAudioData(params, ttsAudioFormat);
  }

  const { duration: audioDuration, filePath, base64, buffer } = params;
  if (audioDuration <= 0 || (!filePath && !base64 && !buffer)) {
    console.log("No audio data to play, skipping playback.");
    return Promise.resolve();
  }
  // play wav file using aplay
  if (filePath) {
    console.log("Playback duration:", audioDuration);
    player.isPlaying = true;
    return playWavWithFallback([filePath], Math.round(audioDuration + 1200))
      .then(() => {
        console.log("Audio playback completed");
      })
      .catch((error) => {
      console.error("Audio playback error:", error);
      })
      .finally(() => {
        player.isPlaying = false;
      });
  }

  // play wav/mp3 buffer based on configured TTS format
  return new Promise((resolve, reject) => {
    const audioBuffer = base64 ? Buffer.from(base64, "base64") : buffer;
    console.log("Playback duration:", audioDuration);
    player.isPlaying = true;
    setTimeout(() => {
      resolve();
      player.isPlaying = false;
      console.log("Audio playback completed");
    }, audioDuration); // Add 1 second buffer

    if (ttsAudioFormat === "wav") {
      const devices = getAlsaPlaybackTargets();
      let chain = Promise.resolve<void>(undefined);
      let done = false;

      devices.forEach((device) => {
        chain = chain.catch(() => undefined).then(() => {
          if (done) return;
          return new Promise<void>((innerResolve, innerReject) => {
            const process = spawn("sox", ["-t", "wav", "-", "-t", "alsa", device]);
            process.stdout?.on("data", (data) => console.log(data.toString()));
            process.stderr?.on("data", (data) => console.error(data.toString()));
            process.on("error", innerReject);
            process.on("exit", (code) => {
              if (code !== 0) {
                innerReject(new Error(`Audio playback error: ${code} on device=${device}`));
              } else {
                done = true;
                innerResolve();
              }
            });
            process.stdin?.end(audioBuffer);
          });
        });
      });

      chain
        .then(() => {
          player.isPlaying = false;
          console.log("Audio playback completed");
          resolve();
        })
        .catch((error) => {
          player.isPlaying = false;
          reject(error);
        });
      return;
    }

    const process = player.process;
    if (!process) {
      return reject(new Error("Audio player is not initialized."));
    }

    try {
      process.stdin?.write(audioBuffer);
    } catch (e) { }
    process.stdout?.on("data", (data) => console.log(data.toString()));
    process.stderr?.on("data", (data) => console.error(data.toString()));
    process.on("exit", (code) => {
      player.isPlaying = false;
      if (code !== 0) {
        console.error(`Audio playback error: ${code}`);
        reject(code);
      } else {
        console.log("Audio playback completed");
        resolve();
      }
    });
  });
};

const stopPlaying = (): void => {
  // Also stop any in-progress web playback.
  webAudioBridge.stopPlayback();

  if (player.isPlaying) {
    try {
      console.log("Stopping audio playback");
      const process = player.process;
      if (process) {
        process.stdin?.end();
        process.kill();
      }
    } catch { }
    player.isPlaying = false;
    // Recreate process
    setTimeout(() => {
      player.process = startPlayerProcess();
    }, 500);
  } else {
    console.log("No audio currently playing");
  }
};

// Close audio player when exiting program
process.on("SIGINT", () => {
  try {
    if (player.process) {
      player.process.stdin?.end();
      player.process.kill();
    }
  } catch { }
  process.exit();
});

export {
  recordAudio,
  recordAudioForDuration,
  recordAudioManually,
  stopRecording,
  playAudioData,
  stopPlaying,
}; 