/**
 * Every setting comes from an environment variable, so the same build can run
 * anywhere. See bot/.env.example for the full list.
 */

const DEFAULT_API_ROOT = "https://api.telegram.org";

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}").`);
}

export type Config = {
  token: string;
  apiRoot: string;
  /** True when TELEGRAM_API_ROOT points at a self-hosted Bot API server. */
  localApi: boolean;
  maxUploadMB: number;
  maxOutputMB: number;
  maxDimension: number;
  allowCustom: boolean;
  maxConcurrentJobs: number;
  ffmpegPath?: string;
  webhookUrl?: string;
  webhookPath: string;
  webhookSecret?: string;
  port: number;
};

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Create a bot with @BotFather, then set the token in bot/.env or your host's environment settings.",
    );
  }
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN doesn't look like a token from @BotFather (expected 123456:ABC...).");
  }

  const apiRoot = (process.env.TELEGRAM_API_ROOT?.trim() || DEFAULT_API_ROOT).replace(/\/+$/, "");
  const localApi = apiRoot !== DEFAULT_API_ROOT;

  // Telegram's hosted Bot API only lets bots download files up to 20 MB and
  // upload files up to 50 MB. A self-hosted Bot API server raises both to 2000 MB.
  const downloadCap = localApi ? 2000 : 20;
  const uploadCap = localApi ? 2000 : 50;

  const maxUploadMB = readNumber("MAX_UPLOAD_MB", downloadCap, 1, 2000);
  if (maxUploadMB > downloadCap) {
    throw new Error(
      `MAX_UPLOAD_MB is ${maxUploadMB}, but Telegram's hosted Bot API only lets bots download files up to ${downloadCap} MB. ` +
        "Lower MAX_UPLOAD_MB, or run your own Bot API server and set TELEGRAM_API_ROOT.",
    );
  }

  const webhookUrl = process.env.WEBHOOK_URL?.trim().replace(/\/+$/, "") || undefined;
  if (webhookUrl && !webhookUrl.startsWith("https://")) {
    throw new Error("WEBHOOK_URL must start with https:// (Telegram only sends webhooks over HTTPS).");
  }

  return {
    token,
    apiRoot,
    localApi,
    maxUploadMB,
    maxOutputMB: uploadCap,
    maxDimension: readNumber("MAX_DIMENSION", 3840, 16, 8192),
    allowCustom: readBoolean("ALLOW_CUSTOM", true),
    maxConcurrentJobs: readNumber("MAX_CONCURRENT_JOBS", 2, 1, 32),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
    webhookUrl,
    webhookPath: process.env.WEBHOOK_PATH?.trim() || "/telegram/webhook",
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || undefined,
    port: readNumber("PORT", 8080, 1, 65535),
  };
}
