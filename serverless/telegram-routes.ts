/**
 * Logic behind /api/telegram/* on Vercel: the webhook, website sign-in and the
 * one-time webhook registration. Kept out of the route files so it can be tested.
 */

import { Api, type Bot } from "grammy";
import type { Update } from "grammy/types";
import { validateArchiveTarget } from "../bot/src/archive.js";
import { sanitizeAuthData, verifyTelegramAuth } from "../bot/src/auth.js";
import { messages } from "../bot/src/messages.js";
import type { VercelEnv } from "./env.js";
import { corsHeaders, json, jsonError } from "./http.js";
import { WEBHOOK_COMMANDS, createWebhookBot } from "./telegram-bot.js";

export const WEBHOOK_PATH = "/api/telegram/webhook";
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

/* ---------- webhook ---------- */

let botPromise: Promise<Bot> | undefined;

/** One initialized bot per warm instance (bot.init() costs a getMe call). */
export function getWebhookBot(env: VercelEnv, ffmpeg: () => Promise<string>): Promise<Bot> {
  botPromise ??= (async () => {
    const bot = createWebhookBot(env, ffmpeg);
    await bot.init();
    return bot;
  })().catch((error: unknown) => {
    botPromise = undefined;
    throw error;
  });
  return botPromise;
}

/**
 * Checks and accepts one webhook call. Returns the response to send right away
 * and the work to finish afterwards; the route hands that to waitUntil() so a
 * long conversion never makes Telegram wait (or retry).
 */
export async function acceptWebhook(
  request: Request,
  env: VercelEnv,
  getBot: () => Promise<Bot>,
): Promise<{ response: Response; work?: Promise<void> }> {
  if (!env.token) return { response: jsonError(404, "noBot", "TELEGRAM_BOT_TOKEN is not set.") };
  if (request.method !== "POST") return { response: jsonError(405, "method", "Telegram sends POST requests.") };
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.webhookSecret) {
    return { response: jsonError(401, "unauthorized", "Wrong or missing secret token.") };
  }
  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return { response: jsonError(400, "badRequest", "Expected a Telegram update.") };
  }
  if (typeof update?.update_id !== "number") {
    return { response: jsonError(400, "badRequest", "Expected a Telegram update.") };
  }
  const work = getBot()
    .then((bot) => bot.handleUpdate(update))
    .catch((error: unknown) => console.error(`Update ${update.update_id} failed:`, error));
  return { response: json({ ok: true }), work };
}

/* ---------- website sign-in ---------- */

const LOGIN_METHODS = "POST, OPTIONS";
const MAX_LOGIN_BODY = 16 * 1024;

/** POST /telegram/login: verifies a Telegram Login Widget payload (same contract as bot/src/auth.ts). */
export async function handleLogin(
  request: Request,
  env: VercelEnv,
  defer: (work: Promise<unknown>) => void,
): Promise<Response> {
  const cors = corsHeaders(request, env.corsOrigin, LOGIN_METHODS);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  if (!env.token) {
    return json({ ok: false, error: "This server has no TELEGRAM_BOT_TOKEN, so it can't verify sign-ins." }, 503, cors);
  }

  let payload: Record<string, string> | null = null;
  try {
    const text = await request.text();
    if (text.length <= MAX_LOGIN_BODY) payload = sanitizeAuthData(JSON.parse(text));
  } catch {
    payload = null;
  }
  if (!payload) {
    return json({ ok: false, error: "Expected the JSON object from the Telegram Login Widget." }, 400, cors);
  }

  const result = verifyTelegramAuth(env.token, payload, env.loginMaxAgeSeconds);
  if (!result.ok) return json({ ok: false, error: result.reason }, 403, cors);

  if (env.loginGreeting) {
    const api = new Api(env.token, { apiRoot: env.apiRoot });
    defer(
      api.sendMessage(result.user.id, messages.siteLoginGreeting(result.user.firstName)).catch(() => undefined),
    );
  }

  const user = result.user;
  return json(
    {
      ok: true,
      user: {
        id: user.id,
        first_name: user.firstName,
        ...(user.lastName !== undefined ? { last_name: user.lastName } : {}),
        ...(user.username !== undefined ? { username: user.username } : {}),
        ...(user.photoUrl !== undefined ? { photo_url: user.photoUrl } : {}),
        auth_date: user.authDate,
      },
    },
    200,
    cors,
  );
}

/* ---------- webhook registration ---------- */

export type SetupReport = {
  ok: boolean;
  bot?: string;
  link?: string;
  webhook: { expected?: string; current?: string; registered: boolean; pendingUpdates?: number; lastError?: string };
  archive?: string;
  problems: string[];
};

/**
 * GET /api/telegram/setup: shows whether Telegram is pointed at this deployment.
 * With ?register=1 (or POST) it points the webhook here, sets the command menu
 * and checks the archive channel. Safe to repeat; it only ever registers the
 * production URL (or PUBLIC_URL), never a preview deployment's.
 */
export async function runSetup(env: VercelEnv, register: boolean, api = new Api(env.token, { apiRoot: env.apiRoot })) {
  const report: SetupReport = { ok: true, webhook: { registered: false }, problems: [] };
  if (!env.token) {
    report.ok = false;
    report.problems.push("TELEGRAM_BOT_TOKEN is not set in this Vercel project's environment variables.");
    return report;
  }

  const me = await api.getMe();
  report.bot = `@${me.username}`;
  report.link = `https://t.me/${me.username}`;

  const expected = env.publicUrl ? `${env.publicUrl}${WEBHOOK_PATH}` : undefined;
  report.webhook.expected = expected;
  if (!expected) {
    report.ok = false;
    report.problems.push(
      "Couldn't work out this site's public address. Set PUBLIC_URL (for example https://my-app.vercel.app) and redeploy.",
    );
  }

  if (register && expected) {
    await api.setWebhook(expected, {
      secret_token: env.webhookSecret,
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: false,
    });
    await api.setMyCommands(WEBHOOK_COMMANDS).catch(() => undefined);
    await api
      .setMyShortDescription(
        "Try a high-quality iPhone video resize. Preview the size before downloading; original stays unchanged.",
      )
      .catch(() => undefined);
  }

  const info = await api.getWebhookInfo();
  report.webhook.current = info.url || undefined;
  report.webhook.registered = Boolean(expected) && info.url === expected;
  report.webhook.pendingUpdates = info.pending_update_count;
  if (info.last_error_message) report.webhook.lastError = info.last_error_message;
  if (!report.webhook.registered) {
    report.ok = false;
    report.problems.push(
      info.url
        ? `Telegram sends updates to ${info.url}, not this deployment. Open /api/telegram/setup?register=1 to fix it.`
        : "No webhook is registered yet. Open /api/telegram/setup?register=1 to register it.",
    );
  }

  if (env.archiveChatId) {
    try {
      const chat = await api.getChat(env.archiveChatId);
      const member = await api.getChatMember(env.archiveChatId, me.id);
      validateArchiveTarget(chat as never, member as never, env.archiveAllowPublic);
      report.archive = "ok";
    } catch (error) {
      report.ok = false;
      report.archive = (error as Error).message;
      report.problems.push(`Archive channel: ${(error as Error).message}`);
    }
  }
  return report;
}
