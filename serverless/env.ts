/**
 * Settings for the Vercel deployment (the functions in /api).
 *
 * Same environment variable names as the long-running bot server (bot/.env.example)
 * wherever the meaning is the same, so one set of variables works for both. Read
 * on every cold start; nothing here talks to the network.
 */

import { createHash } from "node:crypto";
import { normalizeArchiveChatId } from "../bot/src/archive.js";

export const DEFAULT_API_ROOT = "https://api.telegram.org";

/** Path prefix for everything this app stores in Vercel Blob. */
export const BLOB_PREFIX = "sendable";
export const UPLOAD_PREFIX = `${BLOB_PREFIX}/uploads`;
export const OUTPUT_PREFIX = `${BLOB_PREFIX}/outputs`;

export type VercelEnv = {
  /** Empty when no Telegram bot is configured (the website converter still works). */
  token: string;
  apiRoot: string;
  localApi: boolean;
  /** Largest video the bot downloads from Telegram, in MB. */
  maxUploadMB: number;
  /** Largest file the bot may send back, in MB. */
  maxOutputMB: number;
  allowCustom: boolean;
  maxDimension: number;
  archiveChatId?: string;
  archiveAllowPublic: boolean;
  /** Telegram sends this in X-Telegram-Bot-Api-Secret-Token with every webhook call. */
  webhookSecret: string;
  /** Public https origin of the production deployment, used to register the webhook. */
  publicUrl?: string;
  corsOrigin: string;
  loginMaxAgeSeconds: number;
  loginGreeting: boolean;
  /** The website converter (Vercel Blob upload, ffmpeg in a function). */
  webConvert: boolean;
  /** Vercel Blob read-write token; the converter is unavailable without it. */
  blobToken?: string;
  webMaxUploadMB: number;
  webJobTtlMinutes: number;
  webApiKey?: string;
  /** The function time limit (maxDuration in vercel.json). Work stops a little before it. */
  maxSeconds: number;
  ffmpegPath?: string;
  cronSecret?: string;
};

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

type Source = Record<string, string | undefined>;

function readNumber(env: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

function readBoolean(env: Source, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new EnvError(`${name} must be true or false (got "${raw}").`);
}

/**
 * The default webhook secret: derived from the bot token, so it needs no setup and
 * changes whenever the token is revoked. Telegram allows 1-256 of [A-Za-z0-9_-].
 * scripts/vercel-build.mjs derives the same value; keep the two in sync.
 */
export function deriveWebhookSecret(token: string): string {
  return createHash("sha256").update(`sendable-webhook:${token}`).digest("hex").slice(0, 48);
}

/** "my-app.vercel.app" or "https://my-app.vercel.app/" → "https://my-app.vercel.app". */
export function toOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Where Telegram should send updates. PUBLIC_URL wins; otherwise the project's
 * production domain, which Vercel provides to every deployment. Preview
 * deployments deliberately don't fall back to their own URL, so opening a preview
 * can never steal the production bot's webhook.
 */
export function resolvePublicUrl(env: Source): string | undefined {
  return toOrigin(env.PUBLIC_URL) ?? toOrigin(env.WEBHOOK_URL) ?? toOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
}

export function loadVercelEnv(env: Source = process.env): VercelEnv {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (token && !/^\d+:[\w-]{30,}$/.test(token)) {
    throw new EnvError("TELEGRAM_BOT_TOKEN doesn't look like a token from @BotFather (expected 123456:ABC...).");
  }

  const apiRoot = (env.TELEGRAM_API_ROOT?.trim() || DEFAULT_API_ROOT).replace(/\/+$/, "");
  const localApi = apiRoot !== DEFAULT_API_ROOT;
  const downloadCap = localApi ? 2000 : 20;
  const uploadCap = localApi ? 2000 : 50;
  const maxUploadMB = readNumber(env, "MAX_UPLOAD_MB", downloadCap, 1, 2000);
  if (maxUploadMB > downloadCap) {
    throw new EnvError(
      `MAX_UPLOAD_MB is ${maxUploadMB}, but Telegram's hosted Bot API only lets bots download files up to ${downloadCap} MB.`,
    );
  }

  const corsOrigin = env.CORS_ORIGIN?.trim() || "*";
  for (const origin of corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)) {
    if (origin !== "*" && !/^https?:\/\/[^/\s]+$/i.test(origin)) {
      throw new EnvError(`CORS_ORIGIN entries must be "*" or a plain origin like https://sendable.vercel.app (got "${origin}").`);
    }
  }

  let archiveChatId: string | undefined;
  try {
    archiveChatId = normalizeArchiveChatId(env.TELEGRAM_ARCHIVE_CHAT_ID);
  } catch (error) {
    throw new EnvError((error as Error).message);
  }

  const webhookSecret = env.WEBHOOK_SECRET?.trim() || (token ? deriveWebhookSecret(token) : "");
  if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new EnvError("WEBHOOK_SECRET may only contain letters, numbers, _ and - (up to 256 characters).");
  }

  return {
    token,
    apiRoot,
    localApi,
    maxUploadMB,
    maxOutputMB: uploadCap,
    allowCustom: readBoolean(env, "ALLOW_CUSTOM", true),
    maxDimension: readNumber(env, "MAX_DIMENSION", 3840, 16, 8192),
    archiveChatId,
    archiveAllowPublic: readBoolean(env, "TELEGRAM_ARCHIVE_ALLOW_PUBLIC", false),
    webhookSecret,
    publicUrl: resolvePublicUrl(env),
    corsOrigin,
    loginMaxAgeSeconds: readNumber(env, "LOGIN_MAX_AGE_SECONDS", 86400, 60, 604800),
    loginGreeting: readBoolean(env, "LOGIN_GREETING", true),
    webConvert: readBoolean(env, "WEB_CONVERT", true),
    blobToken: env.BLOB_READ_WRITE_TOKEN?.trim() || undefined,
    webMaxUploadMB: readNumber(env, "WEB_MAX_UPLOAD_MB", 100, 1, 2000),
    webJobTtlMinutes: readNumber(env, "WEB_JOB_TTL_MINUTES", 60, 1, 1440),
    webApiKey: env.WEB_API_KEY?.trim() || undefined,
    // Hobby allows 300 s; Pro can raise maxDuration in vercel.json and set this to match.
    maxSeconds: readNumber(env, "FUNCTION_MAX_SECONDS", 300, 30, 1800),
    ffmpegPath: env.FFMPEG_PATH?.trim() || undefined,
    cronSecret: env.CRON_SECRET?.trim() || undefined,
  };
}

/**
 * The Blob store id inside a read-write token ("vercel_blob_rw_<storeId>_<secret>").
 * Public blob URLs live on "<storeId>.public.blob.vercel-storage.com".
 */
export function blobStoreId(token: string | undefined): string | undefined {
  const match = token?.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  return match?.[1]?.toLowerCase();
}

/** Milliseconds of work a function may do before it should give up cleanly. */
export function workBudgetMs(env: Pick<VercelEnv, "maxSeconds">): number {
  // Leave room to upload the result and tell the user what happened.
  const reserve = Math.min(45, Math.max(15, env.maxSeconds * 0.15));
  return Math.max(10, env.maxSeconds - reserve) * 1000;
}
