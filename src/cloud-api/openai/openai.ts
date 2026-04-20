import { OpenAI, ClientOptions } from "openai";
import { proxyFetch } from "../proxy-fetch";
import dotenv from "dotenv";

dotenv.config();

const openAiAPIKey = process.env.OPENAI_API_KEY;
const openAiBaseURL = process.env.OPENAI_API_BASE_URL;
const offlineOnly = (process.env.OFFLINE_ONLY || "true").toLowerCase() === "true";

const isLocalHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "llm-engine" ||
    host.endsWith(".local")
  );
};

const isLocalBaseUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};
// OpenAI LLM
export const openaiLLMModel = process.env.OPENAI_LLM_MODEL || "gpt-4o"; // Default model
export const openaiVisionModel =
  process.env.OPENAI_VISION_MODEL || process.env.OPENAI_LLM_MODEL || "gpt-4o";

// OpenAI Image Generation
export const openaiImageModel = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";

const openAiOptions: ClientOptions = {
  apiKey: openAiAPIKey,
  fetch: proxyFetch as any,
};

if (openAiBaseURL && (!offlineOnly || isLocalBaseUrl(openAiBaseURL))) {
  Object.assign(openAiOptions, { baseURL: openAiBaseURL });
}

const shouldDisableOpenAIClient =
  !openAiAPIKey ||
  (offlineOnly && (!openAiBaseURL || !isLocalBaseUrl(openAiBaseURL)));

if (offlineOnly && !openAiBaseURL) {
  console.error("OFFLINE_ONLY is enabled and OPENAI_API_BASE_URL is not set. OpenAI client is disabled.");
}
if (offlineOnly && openAiBaseURL && !isLocalBaseUrl(openAiBaseURL)) {
  console.error(`OFFLINE_ONLY is enabled and OPENAI_API_BASE_URL is not local: ${openAiBaseURL}. OpenAI client is disabled.`);
}

export const openai = shouldDisableOpenAIClient ? null : new OpenAI(openAiOptions);
