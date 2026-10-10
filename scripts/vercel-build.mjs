#!/usr/bin/env node
/**
 * Build command for Vercel (see vercel.json). Works locally too: `node scripts/vercel-build.mjs`.
 *
 *  1. If TELEGRAM_BOT_TOKEN is set but VITE_TELEGRAM_BOT_USERNAME isn't, asks
 *     Telegram for the bot's username so the site's "Open in Telegram" buttons and
 *     the sign-in widget point at the right bot with no extra setup.
 *  2. Makes the site call its own /api routes (VITE_BOT_API_URL=same-origin)
 *     unless VITE_BOT_API_URL already points somewhere else.
 *  3. Builds the site with Vite.
 *  4. On production deployments, points the bot's webhook at
 *     https://<production domain>/api/telegram/webhook and sets the command menu.
 *     Set AUTO_REGISTER_WEBHOOK=false to skip this and use /api/telegram/setup.
 *
 * Telegram problems never fail the build; they're printed as warnings.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const apiRoot = (env.TELEGRAM_API_ROOT?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
const onVercel = env.VERCEL === "1";

const log = (message) => console.log(`[sendable] ${message}`);
const warn = (message) => console.warn(`[sendable] warning: ${message}`);

/** Same derivation as serverless/env.ts deriveWebhookSecret(); keep them in sync. */
export function deriveWebhookSecret(value) {
  return createHash("sha256").update(`sendable-webhook:${value}`).digest("hex").slice(0, 48);
}

function toOrigin(value) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return undefined;
  }
}

async function telegram(method, body) {
  const response = await fetch(`${apiRoot}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${response.status}`);
  return data.result;
}

async function main() {
  const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (!isMain) return;

  // 1. The bot's username for the website.
  if (token && !env.VITE_TELEGRAM_BOT_USERNAME) {
    try {
      const me = await telegram("getMe");
      env.VITE_TELEGRAM_BOT_USERNAME = me.username;
      log(`Website will open @${me.username} (from TELEGRAM_BOT_TOKEN).`);
    } catch (error) {
      warn(`couldn't look up the bot's username (${error.message}). Set VITE_TELEGRAM_BOT_USERNAME to choose it.`);
    }
  }

  // 2. Same-origin API on Vercel.
  if (onVercel && !env.VITE_BOT_API_URL) {
    env.VITE_BOT_API_URL = "same-origin";
    log("Website will use this deployment's own /api routes.");
  }

  if (onVercel && !existsSync(path.join(root, "node_modules/ffmpeg-static/ffmpeg"))) {
    warn(
      "node_modules/ffmpeg-static/ffmpeg is missing, so conversions will fail. " +
        "Redeploy without the build cache, or check the install log for ffmpeg-static errors.",
    );
  }

  // 3. The site.
  const vite = spawnSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  if (vite.status !== 0) process.exit(vite.status ?? 1);

  // 4. The webhook, on production deployments only.
  const production = env.VERCEL_ENV === "production";
  const auto = !["0", "false", "no", "off"].includes((env.AUTO_REGISTER_WEBHOOK ?? "").trim().toLowerCase());
  if (!token) {
    log("No TELEGRAM_BOT_TOKEN: deploying the website and converter without the Telegram bot.");
    return;
  }
  if (!production || !auto) {
    log(
      production
        ? "AUTO_REGISTER_WEBHOOK=false: open /api/telegram/setup?register=1 after deploying."
        : "Not a production deployment: leaving the bot's webhook alone.",
    );
    return;
  }
  const publicUrl = toOrigin(env.PUBLIC_URL) ?? toOrigin(env.WEBHOOK_URL) ?? toOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (!publicUrl) {
    warn("couldn't work out the production URL. Set PUBLIC_URL, then open /api/telegram/setup?register=1.");
    return;
  }
  const webhook = `${publicUrl}/api/telegram/webhook`;
  try {
    await telegram("setWebhook", {
      url: webhook,
      secret_token: env.WEBHOOK_SECRET?.trim() || deriveWebhookSecret(token),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    await telegram("setMyCommands", {
      commands: [
        { command: "start", description: "Start over" },
        { command: "help", description: "How it works and the limits" },
      ],
    }).catch(() => undefined);
    log(`Telegram webhook → ${webhook}`);
  } catch (error) {
    warn(`couldn't register the webhook (${error.message}). Open ${publicUrl}/api/telegram/setup?register=1 after deploying.`);
  }
}

await main();
