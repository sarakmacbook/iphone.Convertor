import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg } from "../bot/src/ffmpeg.js";
import { messages } from "../bot/src/messages.js";
import { loadVercelEnv, type VercelEnv } from "./env.js";
import { createWebhookBot, decodeChoice, encodeChoice, vercelMessages } from "./telegram-bot.js";
import { acceptWebhook, handleLogin, runSetup } from "./telegram-routes.js";
import { Api } from "grammy";

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
const skipReason = hasFfmpeg ? false : ("ffmpeg not found" as const);

const TOKEN = `123456:${"A".repeat(35)}`;
const CHAT_ID = 4242;
const chat = { id: CHAT_ID, type: "private" as const, first_name: "Tester" };
const user = { id: CHAT_ID, is_bot: false, first_name: "Tester" };
const botUser = { id: 123456, is_bot: true, first_name: "Sendable" };

type Call = { method: string; body: Buffer; contentType: string; json: Record<string, unknown> };

/** A local stand-in for api.telegram.org that records every call. */
function fakeTelegram(fileBytes: Buffer) {
  const calls: Call[] = [];
  let nextId = 100;
  let webhookUrl = "";
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(fileBytes);
      return;
    }
    const method = url.pathname.match(/^\/bot[^/]+\/(\w+)$/)?.[1] ?? "unknown";
    const contentType = req.headers["content-type"] ?? "";
    let json: Record<string, unknown> = {};
    if (contentType.includes("json") && body.length) json = JSON.parse(body.toString("utf8"));
    calls.push({ method, body, contentType, json });

    let result: unknown = true;
    if (method === "getMe") {
      result = { ...botUser, username: "sendable_fake_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    } else if (method === "getFile") {
      result = { file_id: "VID", file_unique_id: "U", file_size: fileBytes.length, file_path: "videos/file_1.mov" };
    } else if (method === "sendMessage" || method === "editMessageText") {
      result = { message_id: nextId++, date: 1, chat, text: "" };
    } else if (method === "copyMessage") {
      result = { message_id: nextId++ };
    } else if (method === "sendVideo") {
      result = { message_id: nextId++, date: 1, chat, video: { file_id: "OUT", file_unique_id: "OU", width: 640, height: 360, duration: 2 } };
    } else if (method === "setWebhook") {
      webhookUrl = String(json.url ?? "");
    } else if (method === "getWebhookInfo") {
      result = { url: webhookUrl, has_custom_certificate: false, pending_update_count: 0 };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  });
  return { server, calls };
}

const servers: Server[] = [];
let workDir: string;
let clip: { path: string; bytes: number };

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sendable-vercel-test-"));
  if (hasFfmpeg) {
    // A 2 s 1280x720 clip at a high bitrate, so 480p is clearly smaller.
    const file = path.join(workDir, "IMG_0001.MOV");
    const made = spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-c:a", "aac", "-shortest", file,
    ]);
    assert.equal(made.status, 0, made.stderr.toString());
    clip = { path: file, bytes: statSync(file).size };
  }
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function start(fileBytes = Buffer.from("unused")) {
  const fake = fakeTelegram(fileBytes);
  servers.push(fake.server);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const apiRoot = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const env: VercelEnv = { ...loadVercelEnv({ TELEGRAM_BOT_TOKEN: TOKEN, PUBLIC_URL: "https://sendable.example" }), apiRoot };
  const bot = createWebhookBot(env, async () => ffmpeg);
  await bot.init();
  return { ...fake, bot, env, apiRoot };
}

function videoMessage(bytes = 1000) {
  return {
    message_id: 7,
    date: 1,
    chat,
    from: user,
    video: {
      file_id: "VID", file_unique_id: "U", width: 1280, height: 720, duration: 2,
      file_name: "IMG_0001.MOV", mime_type: "video/quicktime", file_size: bytes,
    },
  };
}

let updateId = 1;
const messageUpdate = (message: Record<string, unknown>) => ({ update_id: updateId++, message });
function buttonUpdate(data: string, message: Record<string, unknown>) {
  return { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: user, chat_instance: "ci", data, message } };
}
/** A bot message (with buttons) that replies to the user's video, as the bot sends them. */
const botReply = (id: number, replyTo: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  message_id: id, date: 1, chat, from: botUser, text: "…", ...(replyTo ? { reply_to_message: replyTo } : {}), ...extra,
});

const buttonData = (call: Call | undefined): string[] =>
  ((call?.json.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> })?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data);

test("choices round-trip through callback data", () => {
  for (const code of ["convert", "keep", "balanced", "smaller", "720x1280"]) {
    const choice = decodeChoice(code, 3840);
    assert.ok(choice, code);
    assert.equal(encodeChoice(choice), code);
    assert.ok(Buffer.byteLength(`g:${code}`) <= 64);
  }
  assert.equal(decodeChoice("9000x9000", 3840), undefined);
  assert.equal(decodeChoice("huge", 3840), undefined);
});

test("a video gets the size menu, as a reply to the video", async () => {
  const { bot, calls } = await start();
  await bot.handleUpdate(messageUpdate(videoMessage()) as never);
  const reply = calls.find((c) => c.method === "sendMessage");
  assert.ok(reply);
  assert.match(String(reply.json.text), /^Got it: IMG_0001\.MOV/);
  assert.deepEqual(reply.json.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
  assert.deepEqual(buttonData(reply), ["s:convert", "s:keep", "s:balanced", "s:smaller", "s:custom", "n"]);
});

test("too-large videos and non-videos are refused without downloading", async () => {
  const { bot, calls } = await start();
  await bot.handleUpdate(messageUpdate(videoMessage(25 * 1024 * 1024)) as never);
  await bot.handleUpdate(
    messageUpdate({ message_id: 8, date: 1, chat, from: user, document: { file_id: "D", file_unique_id: "DU", file_name: "notes.pdf", mime_type: "application/pdf" } }) as never,
  );
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.json.text));
  assert.match(texts[0]!, /over this bot's current 20 MB limit/);
  assert.equal(texts[1], messages.notSupported);
  assert.equal(calls.some((c) => c.method === "getFile"), false);
});

test("picking a size asks to confirm, carrying the choice in the button", async () => {
  const { bot, calls } = await start();
  await bot.handleUpdate(buttonUpdate("s:smaller", botReply(50, videoMessage())) as never);
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery"));
  assert.ok(calls.some((c) => c.method === "editMessageReplyMarkup"), "old buttons are removed");
  const confirm = calls.find((c) => c.method === "sendMessage");
  assert.equal(confirm?.json.text, messages.confirm("Smaller (480p)"));
  assert.deepEqual(buttonData(confirm), ["g:smaller", "c"]);
  assert.equal((confirm?.json.reply_parameters as { message_id: number }).message_id, 7);
});

test("a button whose video is gone says it expired", async () => {
  const { bot, calls } = await start();
  await bot.handleUpdate(buttonUpdate("g:smaller", botReply(50, undefined)) as never);
  assert.equal(calls.find((c) => c.method === "sendMessage")?.json.text, messages.expired);
  // Messages older than 48 hours arrive as "inaccessible" (date 0).
  await bot.handleUpdate(buttonUpdate("c", { message_id: 51, date: 0, chat }) as never);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 2);
  assert.equal(calls.some((c) => c.method === "getFile"), false);
});

test("custom dimensions: the video is re-posted, and a typed reply to it is confirmed", async () => {
  const { bot, calls } = await start();
  await bot.handleUpdate(buttonUpdate("s:custom", botReply(50, videoMessage())) as never);
  const copy = calls.find((c) => c.method === "copyMessage");
  assert.ok(copy, "the video is copied, not re-uploaded");
  assert.equal(copy.json.message_id, 7);
  assert.equal(copy.json.caption, vercelMessages.customPrompt);
  assert.equal((copy.json.reply_markup as { force_reply: boolean }).force_reply, true);

  // The typed reply arrives attached to the re-posted copy, which holds the video.
  const repost = { ...videoMessage(), message_id: 101, from: botUser };
  await bot.handleUpdate(messageUpdate({ message_id: 9, date: 1, chat, from: user, text: "640 x 360", reply_to_message: repost }) as never);
  const confirm = calls.find((c) => c.method === "sendMessage");
  assert.deepEqual(buttonData(confirm), ["g:640x360", "c"]);
  assert.equal((confirm?.json.reply_parameters as { message_id: number }).message_id, 101);

  await bot.handleUpdate(messageUpdate({ message_id: 10, date: 1, chat, from: user, text: "big please", reply_to_message: repost }) as never);
  assert.equal(calls.filter((c) => c.method === "sendMessage")[1]?.json.text, messages.customFormat);

  // Text that isn't a reply to a video explains how custom sizes work.
  await bot.handleUpdate(messageUpdate({ message_id: 11, date: 1, chat, from: user, text: "720x1280" }) as never);
  assert.equal(calls.filter((c) => c.method === "sendMessage")[2]?.json.text, vercelMessages.customHowTo);
});

test("Create preview converts the video and sends the smaller copy back", { skip: skipReason }, async () => {
  const { bot, calls } = await start(readFileSync(clip.path));
  await bot.handleUpdate(buttonUpdate("g:smaller", botReply(60, videoMessage(clip.bytes))) as never);

  const status = calls.find((c) => c.method === "sendMessage");
  assert.equal(status?.json.text, messages.processing());
  const sent = calls.find((c) => c.method === "sendVideo");
  assert.ok(sent, "the converted video was sent");
  assert.match(sent.contentType, /multipart\/form-data/);
  const body = sent.body.toString("latin1");
  assert.match(body, /filename="?IMG_0001_480p\.mp4"?/);
  assert.match(body, /Your preview is ready\./);
  assert.match(body, /"callback_data":"d"/);
  assert.match(body, /"message_id":7/, "the preview replies to the video");
  assert.ok(calls.some((c) => c.method === "deleteMessage"), "the status message is removed");
});

test("a conversion that fails says so and offers to retry the same choice", { skip: skipReason }, async () => {
  const { bot, calls } = await start(Buffer.from("definitely not a video"));
  await bot.handleUpdate(buttonUpdate("g:balanced", botReply(60, videoMessage(22))) as never);
  const retry = calls.filter((c) => c.method === "sendMessage").find((c) => c.json.text === messages.previewFailed);
  assert.ok(retry);
  assert.deepEqual(buttonData(retry), ["g:balanced", "c"]);
  assert.equal(calls.some((c) => c.method === "sendVideo"), false);
});

test("Download sends the preview itself as a copy", async () => {
  const { bot, calls } = await start();
  const preview = { message_id: 77, date: 1, chat, from: botUser, video: { file_id: "OUT", file_unique_id: "OU", width: 640, height: 360, duration: 2 }, reply_to_message: videoMessage() };
  await bot.handleUpdate(buttonUpdate("d", preview) as never);
  const copy = calls.find((c) => c.method === "copyMessage");
  assert.equal(copy?.json.message_id, 77);
  assert.equal(copy?.json.from_chat_id, CHAT_ID);
  assert.equal(copy?.json.caption, messages.saveHint);
});

test("/cancel and /help describe the Vercel bot honestly", async () => {
  const { bot, calls } = await start();
  const command = (text: string) =>
    messageUpdate({ message_id: 12, date: 1, chat, from: user, text, entities: [{ type: "bot_command", offset: 0, length: text.length }] });
  await bot.handleUpdate(command("/cancel") as never);
  await bot.handleUpdate(command("/help") as never);
  const [cancel, help] = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.json.text));
  assert.equal(cancel, vercelMessages.noCancel);
  assert.doesNotMatch(help!, /\/cancel/);
  assert.match(help!, /Custom dimensions: tap Custom dimensions/);
});

/* ---------- routes ---------- */

test("the webhook rejects calls without Telegram's secret and answers real ones at once", async () => {
  const { bot, env, calls } = await start();
  const post = (secret: string | undefined, body: unknown) =>
    new Request("https://sendable.example/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
      body: JSON.stringify(body),
    });

  const denied = await acceptWebhook(post("wrong", messageUpdate(videoMessage())), env, async () => bot);
  assert.equal(denied.response.status, 401);
  assert.equal(denied.work, undefined);
  assert.equal((await acceptWebhook(post(undefined, {}), env, async () => bot)).response.status, 401);
  assert.equal((await acceptWebhook(post(env.webhookSecret, { nope: true }), env, async () => bot)).response.status, 400);

  const accepted = await acceptWebhook(post(env.webhookSecret, messageUpdate(videoMessage())), env, async () => bot);
  assert.equal(accepted.response.status, 200);
  assert.ok(accepted.work, "the update is finished in the background");
  await accepted.work;
  assert.ok(calls.some((c) => c.method === "sendMessage"));
});

function signedLogin(fields: Record<string, string>) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHash("sha256").update(TOKEN).digest();
  return { ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") };
}

test("website sign-in is verified with the bot token and greets the user", async () => {
  const { env, calls } = await start();
  const deferred: Promise<unknown>[] = [];
  const login = (body: unknown, method = "POST") =>
    handleLogin(
      new Request("https://sendable.example/telegram/login", {
        method,
        headers: { "content-type": "application/json", origin: "https://sendable.example" },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      (work) => deferred.push(work),
    );

  const payload = signedLogin({ id: String(CHAT_ID), first_name: "Tester", auth_date: String(Math.floor(Date.now() / 1000)) });
  const ok = await login(payload);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  const body = (await ok.json()) as { ok: boolean; user: { id: number; first_name: string } };
  assert.equal(body.user.id, CHAT_ID);
  await Promise.all(deferred);
  assert.match(String(calls.find((c) => c.method === "sendMessage")?.json.text), /You just signed in on the Sendable website/);

  assert.equal((await login({ ...payload, first_name: "Mallory" })).status, 403);
  assert.equal((await login("nope")).status, 400);
  assert.equal((await login(undefined, "OPTIONS")).status, 204);
});

test("setup registers this deployment's webhook with the derived secret", async () => {
  const { env, calls, apiRoot } = await start();
  const api = new Api(TOKEN, { apiRoot });
  const before = await runSetup(env, false, api);
  assert.equal(before.ok, false);
  assert.equal(before.webhook.expected, "https://sendable.example/api/telegram/webhook");
  assert.match(before.problems.join(" "), /register=1/);

  const after = await runSetup(env, true, api);
  assert.equal(after.ok, true, after.problems.join(" "));
  assert.equal(after.bot, "@sendable_fake_bot");
  const set = calls.find((c) => c.method === "setWebhook");
  assert.equal(set?.json.secret_token, env.webhookSecret);
  assert.deepEqual(set?.json.allowed_updates, ["message", "callback_query"]);
  assert.ok(calls.some((c) => c.method === "setMyCommands"));
});
