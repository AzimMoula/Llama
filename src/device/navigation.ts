import { spawn } from "child_process";
import { resolve } from "path";

export type NavigationIntent = {
  verb: "find" | "go_to";
  target: string;
  raw: string;
};

const pythonBinary = process.env.NAVIGATION_PYTHON_PATH || "python3";
const navigationScriptPath = resolve(__dirname, "../../whisplay_brain.py");

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeTarget = (raw: string): string => {
  let target = normalizeText(raw)
    .replace(/^(the|a|an|my|that|this)\s+/, "")
    .replace(/\b(please|now|quickly|slowly|towards|toward|to|for|near|at|on)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!target) return "";

  const aliases: Record<string, string> = {
    people: "person",
    human: "person",
    humans: "person",
    person: "person",
    bottle: "bottle",
    bottles: "bottle",
    cup: "cup",
    cups: "cup",
    chair: "chair",
    chairs: "chair",
    seat: "chair",
    seats: "chair",
    stool: "chair",
    stools: "chair",
    table: "dining table",
    tables: "dining table",
    diningtable: "dining table",
    tv: "tv",
    television: "tv",
    televisions: "tv",
    monitor: "tv",
    monitors: "tv",
    screen: "tv",
    screens: "tv",
    phone: "cell phone",
    mobile: "cell phone",
    smartphone: "cell phone",
    laptop: "laptop",
    ball: "sports ball",
    sportsball: "sports ball",
    bottom: "bottle",
  };

  const compact = target.replace(/\s+/g, "");
  if (aliases[compact]) return aliases[compact];
  if (aliases[target]) return aliases[target];

  // For "go to red bottle", keep likely class-bearing suffix.
  const parts = target.split(" ").filter(Boolean);
  if (parts.length > 1) {
    const suffix = parts.slice(-2).join(" ");
    if (aliases[suffix]) return aliases[suffix];
    const last = parts[parts.length - 1];
    if (aliases[last]) return aliases[last];
  }

  return target;
};

export const parseNavigationIntent = (transcript: string): NavigationIntent | null => {
  const text = (transcript || "").trim();
  if (!text) return null;

  const normalizedText = normalizeText(text);
  const directMatch =
    /\b(?:move|more|go)?\s*(forward|backward|back)\b/.test(normalizedText) ||
    /\b(?:turn|rotate)\s+(left|right)\b/.test(normalizedText) ||
    /\bmove\s+(left|right)\b/.test(normalizedText);
  if (directMatch) {
    return {
      verb: "go_to",
      target: "direct_motor_command",
      raw: text,
    };
  }

  const match = text.match(
    /^\s*(find|go\s+to|move\s+towards|move\s+to|approach|head\s+to|take\s+me\s+to)\s+(.+)$/i,
  );
  if (!match) return null;

  const rawVerb = match[1].toLowerCase();
  const verb =
    rawVerb.startsWith("go") ||
    rawVerb.startsWith("move") ||
    rawVerb.startsWith("head") ||
    rawVerb.startsWith("take")
      ? "go_to"
      : "find";
  let targetRaw = (match[2] || "").trim();

  // Stop parsing at conversational conjunctions.
  const split = targetRaw.split(/\b(?:and then|and|then)\b/i)[0];
  targetRaw = split.trim();

  const normalizedTarget = normalizeTarget(targetRaw);
  if (!normalizedTarget) return null;

  return {
    verb,
    target: normalizedTarget,
    raw: text,
  };
};

const parseNavResult = (output: string): string | null => {
  const match = output.match(/NAV_RESULT\s+([a-z_]+)/i);
  if (!match) return null;
  return match[1].toLowerCase();
};

export const executeNavigationIntent = async (
  intent: NavigationIntent,
): Promise<{ ok: boolean; reply: string; detail: string }> => {
  const navigationEnabled = parseBool(process.env.NAVIGATION_ENABLED, true);
  if (!navigationEnabled) {
    return {
      ok: false,
      reply: "Navigation is disabled in configuration.",
      detail: "disabled",
    };
  }

  const fillRatio = Math.max(
    0.25,
    Math.min(0.95, parseFloat(process.env.NAVIGATION_TARGET_FILL_RATIO || "0.7")),
  );
  const maxSteps = Math.max(1, parseInt(process.env.NAVIGATION_MAX_STEPS || "28", 10));
  const timeoutSec = Math.max(
    5,
    parseFloat(process.env.NAVIGATION_TIMEOUT_SEC || "70"),
  );
  const visionUrl =
    process.env.NAVIGATION_VISION_API_URL ||
    process.env.VISION_API_URL ||
    "http://yolo-vision:5000/scene";

  const args = [
    "-u",
    navigationScriptPath,
    "--mode",
    "vision",
    "--target",
    intent.target,
    "--fill",
    String(fillRatio),
    "--max-steps",
    String(maxSteps),
    "--vision-url",
    visionUrl,
  ];

  console.log(
    `[Navigation] Running intent=${intent.verb} target=${intent.target} fill=${fillRatio} maxSteps=${maxSteps}`,
  );

  // Quick path: if user explicitly said move/turn with a numeric value,
  // bypass vision and directly send motor commands.
  const directCommands: Array<{
    action: "FWD" | "REV" | "TRN_L" | "TRN_R";
    value: number;
    label: string;
    index: number;
  }> = [];

  const moveRegex = /\b(?:move|more|go)?\s*(forward|backward|back)\b(?:\s+for)?\s*(?:around|about)?\s*(\d+(?:\.\d+)?)?/gi;
  let match: RegExpExecArray | null;
  while ((match = moveRegex.exec(intent.raw)) !== null) {
    const dir = (match[1] || "").toLowerCase();
    const parsed = match[2] ? parseFloat(match[2]) : NaN;
    const value = Number.isFinite(parsed) ? parsed : 20.0;
    const action = dir.startsWith("back") ? "REV" : "FWD";
    const label = `${dir} ${value}`;
    directCommands.push({ action, value, label, index: match.index });
  }

  const turnRegex = /\b(?:turn|rotate|move)\s+(left|right)\b(?:\s+for)?\s*(?:around|about)?\s*(\d+(?:\.\d+)?)?/gi;
  while ((match = turnRegex.exec(intent.raw)) !== null) {
    const dir = (match[1] || "").toLowerCase();
    const parsed = match[2] ? parseFloat(match[2]) : NaN;
    const value = Number.isFinite(parsed) ? parsed : 30.0;
    const action = dir === "left" ? "TRN_L" : "TRN_R";
    const label = `turn ${dir} ${value}`;
    directCommands.push({ action, value, label, index: match.index });
  }

  if (directCommands.length > 0) {
    directCommands.sort((a, b) => a.index - b.index);
    console.log(
      `[Navigation] Direct motor commands detected: ${directCommands
        .map((cmd) => `${cmd.action}:${cmd.value}`)
        .join(", ")}`,
    );

    const runMotorCommand = async (
      action: "FWD" | "REV" | "TRN_L" | "TRN_R",
      value: number,
    ): Promise<{ ok: boolean; detail: string }> => {
      const motorArgs = [
        "-u",
        navigationScriptPath,
        "--mode",
        "motor",
        "--action",
        action,
        "--value",
        String(value),
      ];

      const child = spawn(pythonBinary, motorArgs, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const outChunks: string[] = [];
      const errChunks: string[] = [];
      child.stdout?.on("data", (c: Buffer) => outChunks.push(c.toString()));
      child.stderr?.on("data", (c: Buffer) => errChunks.push(c.toString()));
      const closed = await new Promise<number>((resolve) => child.on("close", resolve));
      const out = outChunks.join("") + errChunks.join("");
      const res = parseNavResult(out) || (closed === 0 ? "motor_command_sent" : "motor_error");
      return { ok: res === "motor_command_sent", detail: res };
    };

    try {
      const labels: string[] = [];
      for (const cmd of directCommands) {
        const { ok, detail } = await runMotorCommand(cmd.action, cmd.value);
        if (!ok) {
          return {
            ok: false,
            reply: `Motor command failed (${detail}).`,
            detail,
          };
        }
        labels.push(cmd.label);
      }
      return {
        ok: true,
        reply: `Okay — ${labels.join(" then ")}.`,
        detail: "motor_command_sent",
      };
    } catch (err: any) {
      console.error("[Navigation] Direct motor spawn failed:", err);
      return { ok: false, reply: "Failed to invoke motor controller.", detail: String(err) };
    }
  }

  const child = spawn(pythonBinary, args, {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString());
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

  const timeoutMs = timeoutSec * 1000;
  const timedOut = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
      resolve(true);
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      resolve(false);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (timedOut) {
    return {
      ok: false,
      reply: `I tried to move toward ${intent.target}, but navigation timed out.`,
      detail: "timeout",
    };
  }

  const stdoutText = stdoutChunks.join("");
  const stderrText = stderrChunks.join("");
  const navResult = parseNavResult(`${stdoutText}\n${stderrText}`) || "unknown";

  if (navResult === "target_reached") {
    return {
      ok: true,
      reply: `Okay, moving to ${intent.target}. Target reached.`,
      detail: navResult,
    };
  }

  if (navResult === "target_not_found") {
    return {
      ok: false,
      reply: `I started moving but could not find ${intent.target} in view.`,
      detail: navResult,
    };
  }

  if (navResult === "vision_unavailable") {
    return {
      ok: false,
      reply: "Navigation could not start because the vision feed is unavailable.",
      detail: navResult,
    };
  }

  if (navResult === "arduino_unavailable") {
    return {
      ok: false,
      reply: "Navigation could not start because the motor controller is not connected.",
      detail: navResult,
    };
  }

  const errorSummary = (stderrText || stdoutText).trim().slice(0, 240);
  return {
    ok: false,
    reply: `I could not complete navigation to ${intent.target}.`,
    detail: errorSummary || navResult,
  };
};
