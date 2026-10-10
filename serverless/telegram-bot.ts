/**
 * Sendable's Telegram bot, rebuilt for Vercel's webhook functions.
 *
 * A Vercel function keeps nothing in memory between requests, so the
 * long-running bot's per-chat sessions (bot/src/bot.ts) can't work here. This
 * version is stateless: the conversation lives in the Telegram chat itself.
 *
 *  - Every message the bot sends during a conversion replies to the video, so a
 *    button press arrives with the video attached (callback message →
 *    reply_to_message), including its file_id.
 *  - The chosen size travels in the button's callback data ("g:balanced",
 *    "g:720x1280"), well under Telegram's 64-byte limit.
 *  - Custom dimensions: the bot re-posts the video (copyMessage, no upload) and
 *    asks for a reply to it, so the typed "720 x 1280" arrives attached to the
 *    video too. Replying with a size to your own video works as well.
 *  - "Download" copies the preview message itself (or the archived copy).
 *
 * What's different from the long-running bot: a conversion can't be cancelled
 * once it starts (it runs in another invocation), and each one must finish
 * within the function time limit (FUNCTION_MAX_SECONDS, 300 s on Hobby).
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import { formatArchiveCaption } from "../bot/src/archive.js";
import { CancelledError, resizeVideo } from "../bot/src/ffmpeg.js";
import { buttons, messages } from "../bot/src/messages.js";
import { outputFileName } from "../bot/src/paths.js";
import { downloadTelegramFile } from "../bot/src/telegram-download.js";
import {
  PRESETS,
  findPreset,
  formatDuration,
  formatMB,
  isConvertOnly,
  parseCustomSize,
  presetChoice,
  type SizeChoice,
} from "../bot/src/sizes.js";
import { workBudgetMs, type VercelEnv } from "./env.js";

export type SourceVideo = {
  /** The message that holds the video; every later step replies to it. */
  messageId: number;
  fileId: string;
  fileName: string;
  sizeBytes?: number;
  duration?: number;
};

export type WebhookBotEnv = Pick<
  VercelEnv,
  | "token"
  | "apiRoot"
  | "localApi"
  | "maxUploadMB"
  | "maxOutputMB"
  | "allowCustom"
  | "maxDimension"
  | "archiveChatId"
  | "maxSeconds"
>;

const SUPPORTED_MIME = new Set(["video/mp4", "video/quicktime", "video/x-m4v"]);
const SUPPORTED_EXT = /\.(mov|mp4|m4v)$/i;
const PROGRESS_EDIT_MS = 4000;
const MB = 1024 * 1024;

/** Copy that only the stateless (Vercel) bot needs. */
export const vercelMessages = {
  help: (limitMB: number, allowCustom: boolean, archiveEnabled: boolean) =>
    messages
      .help(limitMB, allowCustom, archiveEnabled)
      .replace(/\n\nCommands:[\s\S]*$/, "") +
    (allowCustom
      ? "\n\nCustom dimensions: tap Custom dimensions, then reply to the video I post with a width and height, like 720 x 1280."
      : "") +
    "\n\nCommands:\n/help: show this message",

  customPrompt:
    "Custom dimensions: reply to this video with a width and height in pixels, like 720 x 1280. " +
    "I'll fit the video inside those dimensions so it keeps its shape.",

  customPromptFallback:
    "Custom dimensions: reply to your video with a width and height in pixels, like 720 x 1280. " +
    "I'll fit the video inside those dimensions so it keeps its shape.",

  customHowTo:
    "Send me a video to get started, or tap /help. " +
    "For custom dimensions, reply to your video with a width and height, like 720 x 1280.",

  noCancel:
    "A conversion can't be stopped once it has started here, but it finishes within a few minutes. Your original is unchanged.",

  tooSlow: (minutes: number) =>
    `This video takes longer to convert than this server allows (about ${minutes} min). ` +
    "Try Smaller (480p) or a shorter video. Your original is unchanged.",
} as const;

/* ---------- reading the conversation back out of the chat ---------- */

/** The video (or supported video file) inside a message, if there is one. */
export function videoFromMessage(message: Message | undefined): SourceVideo | undefined {
  if (!message) return undefined;
  if (message.video) {
    return {
      messageId: message.message_id,
      fileId: message.video.file_id,
      fileName: message.video.file_name ?? "video.mp4",
      sizeBytes: message.video.file_size,
      duration: message.video.duration,
    };
  }
  const doc = message.document;
  if (doc) {
    const name = doc.file_name ?? "video";
    const supported = (doc.mime_type && SUPPORTED_MIME.has(doc.mime_type)) || SUPPORTED_EXT.test(name);
    if (!supported) return undefined;
    return { messageId: message.message_id, fileId: doc.file_id, fileName: name, sizeBytes: doc.file_size };
  }
  return undefined;
}

/** The video a tapped button belongs to: the message the button's message replies to. */
export function videoForCallback(ctx: Context): SourceVideo | undefined {
  const message = ctx.callbackQuery?.message;
  // Messages older than 48 hours come back "inaccessible" (date 0) with no content.
  if (!message || message.date === 0 || !("reply_to_message" in message)) return undefined;
  return videoFromMessage(message.reply_to_message);
}

/** "balanced" → preset; "720x1280" → custom dimensions. */
export function encodeChoice(choice: SizeChoice): string {
  return choice.kind === "custom" ? `${choice.width}x${choice.height}` : choice.key;
}

export function decodeChoice(code: string, maxDimension: number): SizeChoice | undefined {
  const custom = /^(\d{1,5})x(\d{1,5})$/.exec(code);
  if (custom) {
    const parsed = parseCustomSize(`${custom[1]} x ${custom[2]}`, maxDimension);
    return parsed.ok ? parsed.choice : undefined;
  }
  const preset = findPreset(code);
  return preset ? presetChoice(preset) : undefined;
}

/* ---------- keyboards ---------- */

function sizeKeyboard(allowCustom: boolean) {
  const keyboard = new InlineKeyboard();
  for (const preset of PRESETS) keyboard.text(preset.label, `s:${preset.key}`).row();
  if (allowCustom) keyboard.text(buttons.custom, "s:custom").row();
  return keyboard.text(buttons.differentVideo, "n");
}

function sizeDetails(allowCustom: boolean) {
  const lines = PRESETS.map((preset) => `• ${preset.label}: ${preset.detail}`);
  if (allowCustom) lines.push(`• ${buttons.custom}: Enter a width and height in pixels.`);
  return lines.join("\n");
}

const confirmKeyboard = (choice: SizeChoice) =>
  new InlineKeyboard().text(buttons.createPreview, `g:${encodeChoice(choice)}`).row().text(buttons.changeSize, "c");

const retryKeyboard = (choice: SizeChoice) =>
  new InlineKeyboard().text(buttons.tryAgain, `g:${encodeChoice(choice)}`).row().text(buttons.changeSize, "c");

const previewKeyboard = (archiveMessageId?: number) =>
  new InlineKeyboard()
    .text(buttons.download, archiveMessageId ? `d:${archiveMessageId}` : "d")
    .row()
    .text(buttons.tryAnother, "c")
    .row()
    .text(buttons.differentVideo, "n");

const replyTo = (messageId: number) => ({
  reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
});

/* ---------- the bot ---------- */

export function createWebhookBot(env: WebhookBotEnv, ffmpeg: () => Promise<string>) {
  const bot = new Bot(env.token, { client: { apiRoot: env.apiRoot } });
  const archiveEnabled = Boolean(env.archiveChatId);

  const dropButtons = async (ctx: Context) => {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  };

  const askForSize = (ctx: Context, video: SourceVideo, intro: string) =>
    ctx.reply(`${intro}\n\n${sizeDetails(env.allowCustom)}`, {
      reply_markup: sizeKeyboard(env.allowCustom),
      ...replyTo(video.messageId),
    });

  /** Downloads, converts and sends back one video. Runs after the webhook has answered. */
  const runJob = async (chatId: number, video: SourceVideo, choice: SizeChoice) => {
    const controller = new AbortController();
    let timedOut = false;
    const budget = workBudgetMs(env);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);

    const workDir = await mkdtemp(path.join(tmpdir(), "sendable-"));
    let statusId: number | undefined;
    const setStatus = async (text: string) => {
      if (!statusId) return;
      await bot.api.editMessageText(chatId, statusId, text).catch(() => undefined);
    };
    const say = (text: string, extra: Record<string, unknown> = {}) =>
      bot.api.sendMessage(chatId, text, { ...replyTo(video.messageId), ...extra }).catch(() => undefined);

    try {
      const status = await bot.api.sendMessage(chatId, messages.processing(), replyTo(video.messageId));
      statusId = status.message_id;

      let input: string;
      try {
        input = await downloadTelegramFile(
          { api: bot.api, apiRoot: env.apiRoot, token: env.token, localApi: env.localApi },
          video.fileId,
          path.join(workDir, "input"),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw new CancelledError();
        console.error("Download failed:", error);
        await setStatus(messages.uploadFailed);
        return;
      }

      const outputName = outputFileName(video.fileName, choice);
      const output = path.join(workDir, outputName);
      let lastEdit = Date.now();
      let lastPercent = -1;
      const ffmpegBinary = await ffmpeg();
      const result = await resizeVideo({
        binary: ffmpegBinary,
        input,
        output,
        choice,
        duration: video.duration,
        signal: controller.signal,
        onProgress: (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (Date.now() - lastEdit < PROGRESS_EDIT_MS || percent === lastPercent || percent >= 100) return;
          lastEdit = Date.now();
          lastPercent = percent;
          void setStatus(messages.processing(percent));
        },
      });

      const outBytes = (await stat(output)).size;
      if (outBytes > env.maxOutputMB * MB) {
        await setStatus(messages.outputTooLarge(formatMB(outBytes), env.maxOutputMB));
        await say(messages.pickAgain, { reply_markup: sizeKeyboard(env.allowCustom) });
        return;
      }

      const inputBytes = video.sizeBytes ?? (await stat(input)).size;
      // "Convert to MP4" is a format change, so it is always sent. Size options never send a larger copy.
      const convertOnly = isConvertOnly(choice);
      const smaller = outBytes < inputBytes;
      if (!convertOnly && !smaller) {
        await setStatus(messages.noSizeReduction);
        await say(messages.pickAgain, { reply_markup: sizeKeyboard(env.allowCustom) });
        return;
      }

      let archiveMessageId: number | undefined;
      let outgoing: InputFile | string = new InputFile(output, outputName);
      const duration = result.duration ? Math.round(result.duration) : undefined;
      if (env.archiveChatId && !convertOnly) {
        try {
          const archived = await bot.api.sendVideo(env.archiveChatId, new InputFile(output, outputName), {
            caption: formatArchiveCaption({
              sourceName: video.fileName,
              sourceBytes: inputBytes,
              outputBytes: outBytes,
              preset: choice.label,
              width: result.width,
              height: result.height,
            }),
            width: result.width,
            height: result.height,
            duration,
            supports_streaming: true,
          });
          archiveMessageId = archived.message_id;
          outgoing = archived.video.file_id;
        } catch (error) {
          console.error("Could not save converted video to the archive channel:", error);
          await setStatus(messages.archiveFailed);
          await say(messages.archiveFailed, { reply_markup: retryKeyboard(choice) });
          return;
        }
      }

      await bot.api.sendVideo(chatId, outgoing, {
        caption: convertOnly
          ? messages.convertReady(formatMB(inputBytes), formatMB(outBytes), choice.label)
          : messages.previewReady(formatMB(inputBytes), formatMB(outBytes), choice.label, smaller, Boolean(archiveMessageId)),
        width: result.width,
        height: result.height,
        duration,
        supports_streaming: true,
        reply_markup: previewKeyboard(archiveMessageId),
        ...replyTo(video.messageId),
      });
      if (statusId) await bot.api.deleteMessage(chatId, statusId).catch(() => undefined);
    } catch (error) {
      if (timedOut) {
        await setStatus(vercelMessages.tooSlow(Math.round(env.maxSeconds / 60)));
        await say(messages.pickAgain, { reply_markup: sizeKeyboard(env.allowCustom) });
        return;
      }
      console.error(`Preview failed for chat ${chatId}:`, error);
      await setStatus(messages.previewFailed);
      await say(messages.previewFailed, { reply_markup: retryKeyboard(choice) });
    } finally {
      clearTimeout(timer);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /* ---------- commands ---------- */

  bot.command("start", async (ctx) => {
    const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
    // The website links here with ?start=web-<telegram id> after someone signs in there.
    if (/^web-\d{1,18}$/.test(payload)) {
      await ctx.reply(messages.welcomeFromSite(env.maxUploadMB, archiveEnabled));
      return;
    }
    await ctx.reply(messages.welcome(env.maxUploadMB, archiveEnabled));
  });

  bot.command("help", (ctx) => ctx.reply(vercelMessages.help(env.maxUploadMB, env.allowCustom, archiveEnabled)));

  bot.command("cancel", (ctx) => ctx.reply(vercelMessages.noCancel));

  /* ---------- incoming videos ---------- */

  const acceptVideo = async (ctx: Context, video: SourceVideo) => {
    const size = video.sizeBytes !== undefined ? formatMB(video.sizeBytes) : "unknown size";
    if (video.sizeBytes !== undefined && video.sizeBytes > env.maxUploadMB * MB) {
      await ctx.reply(messages.tooLarge(video.fileName, size, env.maxUploadMB), replyTo(video.messageId));
      return;
    }
    await askForSize(ctx, video, messages.gotIt(video.fileName, size, formatDuration(video.duration), archiveEnabled));
  };

  bot.on("message:video", (ctx) => acceptVideo(ctx, videoFromMessage(ctx.message)!));

  bot.on("message:document", async (ctx) => {
    const video = videoFromMessage(ctx.message);
    if (!video) {
      await ctx.reply(messages.notSupported);
      return;
    }
    await acceptVideo(ctx, video);
  });

  bot.on(["message:animation", "message:video_note", "message:photo"], (ctx) => ctx.reply(messages.notSupported));

  /* ---------- custom dimensions, typed as a reply to the video ---------- */

  bot.on("message:text", async (ctx) => {
    const video = videoFromMessage(ctx.message.reply_to_message);
    if (!video || !env.allowCustom) {
      await ctx.reply(env.allowCustom ? vercelMessages.customHowTo : messages.idleText);
      return;
    }
    const parsed = parseCustomSize(ctx.message.text, env.maxDimension);
    if (!parsed.ok) {
      await ctx.reply(
        parsed.reason === "tooLarge" ? messages.customTooLarge(env.maxDimension) : messages.customFormat,
        replyTo(ctx.message.message_id),
      );
      return;
    }
    await ctx.reply(messages.confirm(parsed.choice.label), {
      reply_markup: confirmKeyboard(parsed.choice),
      ...replyTo(video.messageId),
    });
  });

  /* ---------- buttons ---------- */

  bot.callbackQuery(/^s:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const video = videoForCallback(ctx);
    if (!video) return void (await ctx.reply(messages.expired));
    await dropButtons(ctx);

    const key = ctx.match[1]!;
    if (key === "custom" && env.allowCustom) {
      // Re-post the video (no upload: Telegram copies it) so the typed size can reply to it.
      try {
        await ctx.api.copyMessage(ctx.chat!.id, ctx.chat!.id, video.messageId, {
          caption: vercelMessages.customPrompt,
          reply_markup: { force_reply: true, input_field_placeholder: "720 x 1280" },
        });
      } catch {
        await ctx.reply(vercelMessages.customPromptFallback, replyTo(video.messageId));
      }
      return;
    }
    const preset = findPreset(key);
    if (!preset) return;
    const choice = presetChoice(preset);
    const prompt = isConvertOnly(choice) ? messages.confirmConvert(preset.label) : messages.confirm(preset.label);
    await ctx.reply(prompt, { reply_markup: confirmKeyboard(choice), ...replyTo(video.messageId) });
  });

  bot.callbackQuery(/^g:([\w]+)$/, async (ctx) => {
    const video = videoForCallback(ctx);
    const choice = decodeChoice(ctx.match[1]!, env.maxDimension);
    if (!video || !choice) {
      await ctx.answerCallbackQuery();
      await ctx.reply(messages.expired);
      return;
    }
    if (video.sizeBytes !== undefined && video.sizeBytes > env.maxUploadMB * MB) {
      await ctx.answerCallbackQuery();
      await ctx.reply(messages.tooLarge(video.fileName, formatMB(video.sizeBytes), env.maxUploadMB));
      return;
    }
    await ctx.answerCallbackQuery({ text: "Starting…" });
    await dropButtons(ctx);
    // The webhook has already been answered (see api/telegram/webhook.ts), so the
    // conversion can take as long as the function is allowed to run.
    await runJob(ctx.chat!.id, video, choice);
  });

  bot.callbackQuery("c", async (ctx) => {
    await ctx.answerCallbackQuery();
    const video = videoForCallback(ctx);
    if (!video) return void (await ctx.reply(messages.expired));
    await dropButtons(ctx);
    await askForSize(ctx, video, messages.pickAgain);
  });

  bot.callbackQuery("n", async (ctx) => {
    await ctx.answerCallbackQuery();
    await dropButtons(ctx);
    await ctx.reply(messages.sendAnother);
  });

  bot.callbackQuery(/^d(?::(\d+))?$/, async (ctx) => {
    const archiveMessageId = ctx.match[1] ? Number(ctx.match[1]) : undefined;
    const chatId = ctx.chat!.id;
    let from: { chat: number | string; message: number } | undefined;
    if (archiveMessageId !== undefined) {
      if (env.archiveChatId && Number.isSafeInteger(archiveMessageId) && archiveMessageId > 0) {
        from = { chat: env.archiveChatId, message: archiveMessageId };
      }
    } else {
      // The button sits on the preview itself, so the preview is the file to send.
      const preview = ctx.callbackQuery.message;
      if (preview && preview.date !== 0) from = { chat: chatId, message: preview.message_id };
    }
    if (!from) {
      await ctx.answerCallbackQuery();
      await ctx.reply(messages.expired);
      return;
    }
    await ctx.answerCallbackQuery({ text: "Sending the file…" });
    try {
      await ctx.api.copyMessage(chatId, from.chat, from.message, { caption: messages.saveHint });
    } catch (error) {
      console.error("Copying the converted video to the user failed:", error);
      await ctx.reply(messages.previewFailed);
    }
  });

  // Buttons from the long-running bot (before switching to Vercel), or anything unexpected.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: "That button has expired." }));

  bot.on("message", (ctx) => ctx.reply(messages.idleText));

  bot.catch((err) => {
    const description = err.error instanceof GrammyError ? err.error.description : err.error;
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, description);
  });

  return bot;
}

/** Bot commands for the menu; the Vercel bot has no /cancel. */
export const WEBHOOK_COMMANDS = [
  { command: "start", description: "Start over" },
  { command: "help", description: "How it works and the limits" },
];
