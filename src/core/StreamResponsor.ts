import { purifyTextForTTS, splitSentences } from "../utils";
import dotenv from "dotenv";
import { playAudioData, stopPlaying } from "../device/audio";
import { TTSResult } from "../type";

dotenv.config();

type TTSFunc = (text: string) => Promise<TTSResult>;
type SentencesCallback = (sentences: string[]) => void;
type TextCallback = (text: string) => void;
type SentencePlayCallback = (payload: {
  charEnd: number;
  durationMs: number;
  sentenceIndex: number;
  sentence: string;
}) => void;

export class StreamResponser {
  private ttsFunc: TTSFunc;
  private sentencesCallback?: SentencesCallback;
  private textCallback?: TextCallback;
  private sentencePlayCallback?: SentencePlayCallback;
  private partialContent: string = "";
  private playEndResolve: () => void = () => {};
  private speakQueue: {
    sentenceIndex: number;
    sentence: string;
    ttsPromise: Promise<TTSResult>;
  }[] = [];
  private parsedSentences: string[] = [];
  private displaySentences: string[] = [];
  private isPlaying: boolean = false;
  private ttsChain: Promise<void> = Promise.resolve();
  private hasStartedTTS: boolean = false;
  private stopAfterCurrentAudio: boolean = false;
  private outputWindowClosed: boolean = false;
  private ttsReqId: number = 0;
  private chunkMaxChars: number = parseInt(process.env.TTS_CHUNK_MAX_CHARS || "48", 10);
  private chunkMaxWaitMs: number = parseInt(process.env.TTS_CHUNK_MAX_WAIT_MS || "650", 10);
  private chunkMinChars: number = Math.max(12, Math.floor(this.chunkMaxChars * 0.6));
  private chunkLookaheadChars: number = Math.max(16, Math.floor(this.chunkMaxChars * 0.4));
  private lastChunkTs: number = Date.now();

  private findSafeChunkCut = (text: string): number => {
    if (!text || text.length < this.chunkMinChars) {
      return -1;
    }

    const leftWindow = text.slice(0, this.chunkMaxChars);
    const leftCut = Math.max(
      leftWindow.lastIndexOf(" "),
      leftWindow.lastIndexOf(","),
      leftWindow.lastIndexOf(";"),
      leftWindow.lastIndexOf(":"),
      leftWindow.lastIndexOf("."),
      leftWindow.lastIndexOf("!"),
      leftWindow.lastIndexOf("?")
    );
    if (leftCut >= this.chunkMinChars) {
      return leftCut + 1;
    }

    const rightLimit = Math.min(text.length, this.chunkMaxChars + this.chunkLookaheadChars);
    const rightWindow = text.slice(this.chunkMaxChars, rightLimit);
    const rightMatch = rightWindow.search(/[\s,;:.!?]/);
    if (rightMatch >= 0) {
      return this.chunkMaxChars + rightMatch + 1;
    }

    return -1;
  };

  constructor(
    ttsFunc: TTSFunc,
    sentencesCallback?: SentencesCallback,
    textCallback?: TextCallback,
    sentencePlayCallback?: SentencePlayCallback
  ) {
    this.ttsFunc = async (text) => {
      const label = `[TTS time #${++this.ttsReqId}]`;
      console.time(label);
      const result = await ttsFunc(text);
      console.timeEnd(label);
      return result;
    };
    this.sentencesCallback = sentencesCallback;
    this.textCallback = textCallback;
    this.sentencePlayCallback = sentencePlayCallback;
  }

  private getCharEndForSentence(sentenceIndex: number): number {
    if (sentenceIndex < 0 || sentenceIndex >= this.displaySentences.length) {
      return 0;
    }
    return this.displaySentences.slice(0, sentenceIndex + 1).join(" ").length;
  }

  private playAudioInOrder = async (): Promise<void> => {
    // Prevent multiple concurrent calls
    if (this.isPlaying) {
      console.log(
        "Audio playback already in progress, skipping duplicate call"
      );
      return;
    }
    let currentIndex = 0;
    const playNext = async () => {
      if (currentIndex < this.speakQueue.length) {
        this.isPlaying = true;
        try {
          const item = this.speakQueue[currentIndex];
          const playParams = await item.ttsPromise;
          console.log(
            `Playing audio ${currentIndex + 1}/${this.speakQueue.length}`
          );
          this.sentencePlayCallback?.({
            charEnd: this.getCharEndForSentence(item.sentenceIndex),
            durationMs: playParams.duration,
            sentenceIndex: item.sentenceIndex,
            sentence: item.sentence,
          });
          await playAudioData(playParams);
        } catch (error) {
          console.error("Audio playback error:", error);
        }
        if (this.stopAfterCurrentAudio) {
          currentIndex = this.speakQueue.length;
        } else {
          currentIndex++;
        }
        playNext();
      } else if (this.partialContent) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        playNext();
      } else {
        console.log(
          `Play all audio completed. Total: ${this.speakQueue.length}`
        );
        this.isPlaying = false;
        this.playEndResolve();
        this.speakQueue.length = 0;
        this.speakQueue = [];
        this.displaySentences.length = 0;
        this.hasStartedTTS = false;
        this.stopAfterCurrentAudio = false;
        this.outputWindowClosed = false;
      }
    };
    playNext();
  };

  private enqueueTTS = (text: string): Promise<TTSResult> => {
    if (!this.hasStartedTTS) {
      this.hasStartedTTS = true;
      const task = this.ttsChain.then(() => this.ttsFunc(text));
      this.ttsChain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    }
    return this.ttsFunc(text);
  };

  partial = (text: string): void => {
    if (this.outputWindowClosed) return;
    this.partialContent += text;
    // replace newlines with spaces
    this.partialContent = this.partialContent.replace(/\n/g, " ");
    const { sentences, remaining } = splitSentences(this.partialContent);
    this.partialContent = remaining;

    let readySentences = sentences;
    const now = Date.now();
    const shouldForceChunk =
      this.partialContent.length >= this.chunkMaxChars &&
      now - this.lastChunkTs >= this.chunkMaxWaitMs;

    if (shouldForceChunk) {
      // Low-latency fallback: emit only when we can cut at a safe boundary.
      const cut = this.findSafeChunkCut(this.partialContent);
      const forced = cut > 0 ? this.partialContent.slice(0, cut).trim() : "";
      if (cut > 0) {
        this.partialContent = this.partialContent.slice(cut).trim();
      }
      if (forced) {
        readySentences = [...readySentences, forced];
      }
    }

    if (readySentences.length > 0) {
      this.parsedSentences.push(...readySentences);
      const startIndex = this.displaySentences.length;
      this.displaySentences.push(...readySentences);
      this.sentencesCallback?.(this.displaySentences);
      const length = this.speakQueue.length;
      const queueItems: {
        sentenceIndex: number;
        sentence: string;
        ttsPromise: Promise<TTSResult>;
      }[] = [];
      readySentences.forEach((sentence, index) => {
        const purified = purifyTextForTTS(sentence);
        if (!purified) return;
        const ttsPromise = this.enqueueTTS(purified);
        queueItems.push({
          sentenceIndex: startIndex + index,
          sentence,
          ttsPromise,
        });
      });
      if (queueItems.length > 0) {
        this.speakQueue.push(...queueItems);
        this.lastChunkTs = now;
        if (length === 0 && !this.isPlaying) {
          this.playAudioInOrder();
        }
      }
    }
  };

  endPartial = (): void => {
    if (this.outputWindowClosed) {
      this.partialContent = "";
      this.parsedSentences.length = 0;
      return;
    }
    if (this.partialContent) {
      this.parsedSentences.push(this.partialContent);
      this.displaySentences.push(this.partialContent);
      this.sentencesCallback?.(this.displaySentences);
      // remove emoji
      this.partialContent = this.partialContent.replace(
        /[\u{1F600}-\u{1F64F}]/gu,
        ""
      );
      if (this.partialContent.trim() !== "") {
        const text = purifyTextForTTS(this.partialContent);
        const length = this.speakQueue.length;
        this.speakQueue.push({
          sentenceIndex: this.displaySentences.length - 1,
          sentence: this.displaySentences[this.displaySentences.length - 1],
          ttsPromise: this.enqueueTTS(text),
        });
        if (length === 0 && !this.isPlaying) {
          this.playAudioInOrder();
        }
      }
      this.partialContent = "";
    }
    this.textCallback?.(this.displaySentences.join(" "));
    this.parsedSentences.length = 0;
  };

  getPlayEndPromise = (): Promise<void> => {
    return new Promise((resolve) => {
      this.playEndResolve = resolve;
    });
  };

  stop = (): void => {
    this.speakQueue = [];
    this.speakQueue.length = 0;
    this.partialContent = "";
    this.parsedSentences.length = 0;
    this.displaySentences.length = 0;
    this.isPlaying = false;
    this.ttsChain = Promise.resolve();
    this.hasStartedTTS = false;
    this.stopAfterCurrentAudio = false;
    this.outputWindowClosed = false;
    this.lastChunkTs = Date.now();
    this.playEndResolve();
    stopPlaying();
  };

  stopAfterCurrentChunk = (): void => {
    // Soft stop: freeze new output while allowing current audio chunk to finish.
    this.outputWindowClosed = true;
    this.stopAfterCurrentAudio = true;
    this.partialContent = "";
    this.parsedSentences.length = 0;
  };
}
