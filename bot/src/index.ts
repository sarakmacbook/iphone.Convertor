import { createServer } from "node:http";
import { webhookCallback } from "grammy";
import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { checkFfmpeg, resolveFfmpeg } from "./ffmpeg.js";

async function main() {
  const config = loadConfig();
  const ffmpeg = resolveFfmpeg(config.ffmpegPath);
  console.log(`Using ${await checkFfmpeg(ffmpeg)}`);

  const { bot, stop } = createBot(config, ffmpeg);
  await bot.init();
  const username = bot.botInfo.username;
  console.log(`Connected to Telegram as @${username} (https://t.me/${username})`);
  console.log(
    `Limits: ${config.maxUploadMB} MB in, ${config.maxOutputMB} MB out, ${config.maxDimension}px custom, ` +
      `${config.maxConcurrentJobs} job(s) at once`,
  );

  await registerCommands(bot).catch((error) =>
    console.warn("Could not register bot commands:", error instanceof Error ? error.message : error),
  );

  const handleWebhook = config.webhookUrl
    ? webhookCallback(bot, "http", { secretToken: config.webhookSecret })
    : undefined;

  // A small HTTP server: health checks for your host, plus the webhook in webhook mode.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          bot: username,
          link: `https://t.me/${username}`,
          mode: handleWebhook ? "webhook" : "polling",
        }),
      );
      return;
    }
    if (handleWebhook && req.method === "POST" && url.pathname === config.webhookPath) {
      void handleWebhook(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.port, "0.0.0.0", () => console.log(`Health check on port ${config.port}`));

  if (config.webhookUrl) {
    const webhook = `${config.webhookUrl}${config.webhookPath}`;
    await bot.api.setWebhook(webhook, {
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log(`Webhook mode: Telegram will send updates to ${webhook}`);
  } else {
    // bot.start() removes any old webhook first, so switching modes just works.
    void bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => console.log("Polling mode: listening for messages. Press Ctrl+C to stop."),
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    server.close();
    if (!config.webhookUrl) await bot.stop();
    await stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
