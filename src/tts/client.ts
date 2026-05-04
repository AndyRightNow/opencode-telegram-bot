import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import textToSpeech from "@google-cloud/text-to-speech";

const TTS_REQUEST_TIMEOUT_MS = 60_000;

export interface TtsResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export function isTtsConfigured(): boolean {
  if (config.tts.provider === "google") {
    return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  if (config.tts.provider === "volcengine") {
    return Boolean(config.tts.byteDanceApiKey);
  }
  return Boolean(config.tts.apiUrl && config.tts.apiKey);
}

/**
 * Removes markdown syntax that TTS engines would read aloud
 * (asterisks, backticks, heading markers, etc.).
 */
export function stripMarkdownForSpeech(text: string): string {
  let clean = text;

  // fenced code blocks → inline content
  clean = clean.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    return inner.replace(/\n/g, " ");
  });

  clean = clean.replace(/`([^`]+)`/g, "$1");
  clean = clean.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  clean = clean.replace(/\*\*(.+?)\*\*/g, "$1");
  clean = clean.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  clean = clean.replace(/~~(.+?)~~/g, "$1");
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  clean = clean.replace(/^#{1,6}\s+/gm, "");
  clean = clean.replace(/^>\s?/gm, "");
  clean = clean.replace(/^[-*]\s+/gm, "");
  clean = clean.replace(/^\d+\.\s+/gm, "");
  clean = clean.replace(/^[-*_]{3,}\s*$/gm, "");
  clean = clean.replace(/<\/?[A-Za-z][^>]*>/g, "");
  clean = clean.replace(/[ \t]+/g, " ");
  clean = clean.replace(/\n{3,}/g, "\n\n");

  return clean.trim();
}

/** Extracts "ll-CC" from Google voice names like "de-DE-Neural2-B". */
export function extractLanguageCode(voiceName: string): string {
  const match = voiceName.match(/^([a-z]{2,3}-[A-Z]{2})/);
  return match ? match[1] : "en-US";
}

// --- Provider implementations ---

let googleClient: textToSpeech.TextToSpeechClient | null = null;

function getGoogleClient(): textToSpeech.TextToSpeechClient {
  if (!googleClient) {
    googleClient = new textToSpeech.TextToSpeechClient();
  }
  return googleClient;
}

/** @internal Reset Google client singleton (for tests only). */
export function _resetGoogleClient(): void {
  googleClient = null;
}

async function synthesizeWithGoogle(text: string): Promise<TtsResult> {
  const client = getGoogleClient();
  const voiceName = config.tts.voice || "en-US-Studio-O";
  const languageCode = extractLanguageCode(voiceName);

  logger.debug(
    `[TTS] Google Cloud TTS: voice=${voiceName}, languageCode=${languageCode}, chars=${text.length}`,
  );

  const [response] = await client.synthesizeSpeech(
    {
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3" },
    },
    { timeout: TTS_REQUEST_TIMEOUT_MS },
  );

  const raw = response.audioContent;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
  if (buffer.length === 0) {
    throw new Error("Google TTS API returned an empty audio response");
  }

  return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
}

async function synthesizeWithOpenAi(text: string): Promise<TtsResult> {
  const url = `${config.tts.apiUrl}/audio/speech`;

  logger.debug(
    `[TTS] OpenAI-compatible: url=${url}, model=${config.tts.model}, voice=${config.tts.voice}, chars=${text.length}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.tts.model,
        voice: config.tts.voice,
        input: text,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `TTS API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("TTS API returned an empty audio response");
    }

    logger.debug(`[TTS] Generated speech audio: ${buffer.length} bytes`);
    return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeWithVolcengine(text: string): Promise<TtsResult> {
  const VOLCENGINE_TTS_URL =
    "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";

  logger.debug(
    `[TTS] Volcengine: speaker=${config.tts.voice}, chars=${text.length}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(VOLCENGINE_TTS_URL, {
      method: "POST",
      headers: {
        "X-Api-Key": config.tts.byteDanceApiKey,
        "X-Api-Resource-Id": config.tts.byteDanceResourceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: "opencode-telegram-bot" },
        req_params: {
          text,
          speaker: config.tts.voice,
          audio_params: { format: "mp3", sample_rate: 24000 },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Volcengine TTS HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
      );
    }

    const textBody = await response.text();
    const chunks: Buffer[] = [];

    for (const block of textBody.split("\n\n")) {
      const dataMatch = block.match(/^data:\s*(.+)$/m);
      if (!dataMatch) continue;

      let payload: { code: number; data?: string; message?: string };
      try {
        payload = JSON.parse(dataMatch[1]);
      } catch {
        continue;
      }

      if (payload.code > 0 && payload.code !== 20000000) {
        throw new Error(
          `Volcengine TTS error ${payload.code}: ${payload.message || "unknown"}`,
        );
      }
      if (payload.data) {
        chunks.push(Buffer.from(payload.data, "base64"));
      }
    }

    if (chunks.length === 0) {
      throw new Error("Volcengine TTS returned no audio data");
    }

    const buffer = Buffer.concat(chunks);
    logger.debug(`[TTS] Volcengine generated speech: ${buffer.length} bytes`);
    return { buffer, filename: "assistant-reply.mp3", mimeType: "audio/mpeg" };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Public API ---

function getNotConfiguredMessage(): string {
  if (config.tts.provider === "google") {
    return "TTS is not configured: set GOOGLE_APPLICATION_CREDENTIALS for Google Cloud TTS";
  }
  if (config.tts.provider === "volcengine") {
    return "TTS is not configured: set BYTEDANCE_TTS_API_KEY for Volcengine TTS";
  }
  return "TTS is not configured: set TTS_API_URL and TTS_API_KEY";
}

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  if (!isTtsConfigured()) {
    throw new Error(getNotConfiguredMessage());
  }

  const raw = text.trim();
  if (!raw) {
    throw new Error("TTS input text is empty");
  }

  const input = stripMarkdownForSpeech(raw);

  try {
    if (config.tts.provider === "google") {
      return await synthesizeWithGoogle(input);
    }
    if (config.tts.provider === "volcengine") {
      return await synthesizeWithVolcengine(input);
    }
    return await synthesizeWithOpenAi(input);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`TTS request timed out after ${TTS_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}
