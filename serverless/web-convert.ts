/**
 * The website's "Convert here" section on Vercel.
 *
 * A Vercel function can't accept an upload bigger than 4.5 MB, and it keeps no
 * jobs in memory between requests, so the flow differs from the long-running
 * server's (bot/src/web.ts):
 *
 *   1. GET  /api/config   presets and limits, with mode "blob" so the site knows.
 *   2. POST /api/upload   hands the browser a short-lived Vercel Blob upload token;
 *                         the browser uploads the video straight to Blob.
 *   3. POST /api/convert  {url, name, preset | width+height}. One request does the
 *                         whole job and streams progress as JSON lines:
 *                           {"type":"source", ...}  {"type":"progress", ...}
 *                           {"type":"done","job":{...}} or {"type":"error", ...}
 *                         The result is stored in Blob; the upload is deleted.
 *   4. GET  /api/cleanup  (daily cron) deletes anything older than the TTL.
 *
 * The same ffmpeg settings, size rules and file names as the bot are used.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { del, list, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { CancelledError, probeVideo, resizeVideo, type ProbeResult } from "../bot/src/ffmpeg.js";
import { outputFileName } from "../bot/src/paths.js";
import { PRESETS } from "../bot/src/sizes.js";
import { isSupportedUpload, resolveChoice, type PublicJob } from "../bot/src/web.js";
import { BLOB_PREFIX, OUTPUT_PREFIX, UPLOAD_PREFIX, blobStoreId, workBudgetMs, type VercelEnv } from "./env.js";

export type WebConvertEnv = Pick<
  VercelEnv,
  | "webConvert"
  | "blobToken"
  | "webMaxUploadMB"
  | "webJobTtlMinutes"
  | "webApiKey"
  | "allowCustom"
  | "maxDimension"
  | "maxSeconds"
>;

export type ConvertEvent =
  | { type: "status"; state: "downloading" | "converting" | "saving" }
  | { type: "source"; source: PublicJob["source"] }
  | { type: "progress"; progress: number }
  | { type: "done"; job: PublicJob & { output: NonNullable<PublicJob["output"]> & { downloadUrl: string } } }
  | { type: "error"; error: { code: string; message: string } };

/** Folder + file name the browser must upload to: sendable/uploads/<random>/<name>. */
const UPLOAD_PATH = new RegExp(`^${UPLOAD_PREFIX}/[A-Za-z0-9_-]{8,64}/[^/\\\\]{1,200}$`);

const MB = 1024 * 1024;

/** Why the converter can't run, or null when it can. */
export function unavailableReason(env: WebConvertEnv): { code: string; message: string } | null {
  if (!env.webConvert) {
    return { code: "disabled", message: "The website converter is turned off on this server (WEB_CONVERT=false)." };
  }
  if (!env.blobToken) {
    return {
      code: "blobMissing",
      message:
        "The converter needs a Vercel Blob store for uploads. In your Vercel project, open Storage → Create → Blob, " +
        "connect it to this project, and redeploy.",
    };
  }
  return null;
}

export function configBody(env: WebConvertEnv) {
  return {
    ok: true as const,
    mode: "blob" as const,
    limits: {
      maxUploadMB: env.webMaxUploadMB,
      allowCustom: env.allowCustom,
      maxDimension: env.maxDimension,
      maxConcurrentJobs: 1,
      jobTtlMinutes: env.webJobTtlMinutes,
      maxSeconds: env.maxSeconds,
    },
    presets: PRESETS.map(({ key, label, detail, shortSide }) => ({ key, label, detail, shortSide })),
    accepts: ["video/mp4", "video/quicktime", "video/x-m4v", ".mov", ".mp4", ".m4v"],
    upload: { handleUploadUrl: "/api/upload", access: "public" as const, prefix: UPLOAD_PREFIX },
  };
}

/* ---------- 2. upload tokens ---------- */

/** Thrown inside onBeforeGenerateToken; turned into a 400 by the route. */
export class UploadRejected extends Error {}

export function checkUploadPath(pathname: string): void {
  if (!UPLOAD_PATH.test(pathname)) throw new UploadRejected("Uploads must go to sendable/uploads/<id>/<file name>.");
  const name = pathname.split("/").pop() ?? "";
  if (!isSupportedUpload(name, "")) throw new UploadRejected("Please pick a MOV or MP4 video.");
}

export async function handleUploadToken(request: Request, env: WebConvertEnv, body: HandleUploadBody) {
  return handleUpload({
    body,
    request,
    token: env.blobToken,
    onBeforeGenerateToken: async (pathname) => {
      checkUploadPath(pathname);
      return {
        allowedContentTypes: ["video/*", "application/octet-stream"],
        maximumSizeInBytes: Math.round(env.webMaxUploadMB * MB),
        addRandomSuffix: true,
        validUntil: Date.now() + 60 * 60 * 1000,
      };
    },
    // No onUploadCompleted: the browser calls /api/convert itself when the upload finishes,
    // so Blob doesn't need to call this deployment back.
  });
}

/* ---------- 3. converting ---------- */

/**
 * Only blobs this app uploaded, in this project's own store, may be converted.
 * That keeps /api/convert from being used to fetch arbitrary URLs.
 */
export function checkSourceUrl(raw: unknown, blobToken: string | undefined): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new UploadRejected("Missing the uploaded video's URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UploadRejected("That isn't a valid upload URL.");
  }
  const storeId = blobStoreId(blobToken);
  const expectedHost = storeId ? `${storeId}.public.blob.vercel-storage.com` : undefined;
  const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (
    url.protocol !== "https:" ||
    !expectedHost ||
    url.hostname.toLowerCase() !== expectedHost ||
    !pathname.startsWith(`${UPLOAD_PREFIX}/`) ||
    pathname.includes("..")
  ) {
    throw new UploadRejected("That video wasn't uploaded through this site.");
  }
  return url;
}

async function downloadTo(url: URL, destination: string, maxBytes: number, signal: AbortSignal): Promise<number> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Downloading the upload failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new TooLargeError(declared);

  let received = 0;
  const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxBytes) source.destroy(new TooLargeError(received));
  });
  await pipeline(source, createWriteStream(destination));
  return received;
}

class TooLargeError extends Error {
  constructor(readonly bytes: number) {
    super("Upload too large");
  }
}

function sourceInfo(name: string, bytes: number, probe: ProbeResult): PublicJob["source"] {
  return {
    name,
    bytes,
    ...(probe.width !== undefined ? { width: probe.width } : {}),
    ...(probe.height !== undefined ? { height: probe.height } : {}),
    ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
  };
}

export type ConvertRequest = {
  url: string;
  name?: string;
  preset?: string;
  width?: string | number;
  height?: string | number;
};

export type ConvertDeps = {
  ffmpeg: () => Promise<string>;
  /** Stores the finished file; @vercel/blob's put() in production. */
  save?: (pathname: string, file: string, bytes: number) => Promise<{ url: string; downloadUrl: string }>;
  /** Deletes the original upload; @vercel/blob's del() in production. */
  remove?: (url: string) => Promise<void>;
  /** Overrides the store check, for tests that serve uploads from a local server. */
  checkUrl?: (raw: unknown) => URL;
  now?: () => number;
};

/**
 * Runs one conversion and yields progress events. Never throws: failures become
 * an {type:"error"} event, and the uploaded original is always deleted.
 */
export async function* convertUpload(
  body: ConvertRequest,
  env: WebConvertEnv,
  deps: ConvertDeps,
  signal: AbortSignal,
): AsyncGenerator<ConvertEvent> {
  const now = deps.now ?? (() => Date.now());
  const remove = deps.remove ?? ((url: string) => del(url, { token: env.blobToken }));
  const save =
    deps.save ??
    (async (pathname: string, file: string, bytes: number) => {
      const blob = await put(pathname, createReadStream(file), {
        access: "public",
        token: env.blobToken,
        contentType: "video/mp4",
        addRandomSuffix: false,
        multipart: bytes > 50 * MB,
      });
      return { url: blob.url, downloadUrl: blob.downloadUrl };
    });

  let sourceUrl: URL;
  try {
    sourceUrl = (deps.checkUrl ?? ((raw) => checkSourceUrl(raw, env.blobToken)))(body.url);
  } catch (error) {
    yield { type: "error", error: { code: "badUpload", message: (error as Error).message } };
    return;
  }

  const fields: Record<string, string> = {};
  if (body.preset !== undefined) fields.preset = String(body.preset);
  if (body.width !== undefined) fields.width = String(body.width);
  if (body.height !== undefined) fields.height = String(body.height);
  const resolved = resolveChoice(fields, { allowCustom: env.allowCustom, maxDimension: env.maxDimension });
  if (!resolved.ok) {
    await remove(sourceUrl.toString()).catch(() => undefined);
    yield { type: "error", error: { code: resolved.code, message: resolved.message } };
    return;
  }
  const choice = resolved.choice;

  // Work stops a little before the function's time limit, so the user always hears back.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, workBudgetMs(env));
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const startedAt = now();
  const sourceName = (body.name || decodeURIComponent(sourceUrl.pathname.split("/").pop() ?? "video.mov")).slice(0, 200);
  const workDir = await mkdtemp(path.join(tmpdir(), "sendable-web-"));
  const id = randomUUID();

  try {
    yield { type: "status", state: "downloading" };
    const input = path.join(workDir, "input");
    const bytes = await downloadTo(sourceUrl, input, Math.round(env.webMaxUploadMB * MB), controller.signal);
    // The upload has served its purpose; don't keep the original around.
    await remove(sourceUrl.toString()).catch(() => undefined);

    const ffmpeg = await deps.ffmpeg();
    const probe = await probeVideo(ffmpeg, input, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) throw new CancelledError();
      throw new UnreadableError(String(error));
    });
    const source = sourceInfo(sourceName, bytes, probe);
    yield { type: "source", source };
    yield { type: "status", state: "converting" };

    // Bridge ffmpeg's callback-style progress into this generator, at most a few lines per second.
    const outputName = outputFileName(sourceName, choice);
    const output = path.join(workDir, outputName);
    let latest = 0;
    let wake: (() => void) | undefined;
    let finished = false;
    const job = resizeVideo({
      binary: ffmpeg,
      input,
      output,
      choice,
      duration: probe.duration,
      signal: controller.signal,
      onProgress: (fraction) => {
        latest = Math.max(latest, Math.min(1, fraction));
        wake?.();
      },
    }).finally(() => {
      finished = true;
      wake?.();
    });
    job.catch(() => undefined); // Handled below; avoid an unhandled rejection while we wait.

    let reported = -1;
    while (!finished) {
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)), // Keep-alive while ffmpeg is quiet.
      ]);
      wake = undefined;
      const rounded = Math.floor(latest * 100) / 100;
      if (!finished && rounded !== reported) {
        reported = rounded;
        yield { type: "progress", progress: rounded };
      }
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const info = await job;

    yield { type: "status", state: "saving" };
    const outBytes = (await stat(output)).size;
    const saved = await save(`${OUTPUT_PREFIX}/${id}/${outputName}`, output, outBytes);

    yield {
      type: "done",
      job: {
        id,
        state: "done",
        progress: 1,
        createdAt: startedAt,
        updatedAt: now(),
        source,
        choice:
          choice.kind === "custom"
            ? { kind: "custom", label: choice.label, width: choice.width, height: choice.height }
            : { kind: "preset", key: choice.key, label: choice.label },
        output: {
          name: outputName,
          bytes: outBytes,
          ...(info.width !== undefined ? { width: info.width } : {}),
          ...(info.height !== undefined ? { height: info.height } : {}),
          smaller: outBytes < bytes,
          url: saved.url,
          downloadUrl: saved.downloadUrl,
        },
      },
    };
  } catch (error) {
    await remove(sourceUrl.toString()).catch(() => undefined);
    if (timedOut) {
      yield {
        type: "error",
        error: {
          code: "tooLong",
          message:
            `This video takes longer to convert than the server allows (about ${Math.round(env.maxSeconds / 60)} min). ` +
            "Try Smaller (480p) or a shorter clip. Your original is unchanged.",
        },
      };
    } else if (signal.aborted || error instanceof CancelledError) {
      yield { type: "error", error: { code: "cancelled", message: "Cancelled. Your original is unchanged." } };
    } else if (error instanceof TooLargeError) {
      yield {
        type: "error",
        error: { code: "tooLarge", message: `That video is over the ${env.webMaxUploadMB} MB limit. Try a shorter clip.` },
      };
    } else if (error instanceof UnreadableError) {
      yield {
        type: "error",
        error: { code: "unreadable", message: "That file doesn't look like a video we can read. Please pick a MOV or MP4." },
      };
    } else {
      console.error(`Web conversion ${id} failed:`, error);
      yield {
        type: "error",
        error: { code: "convertFailed", message: "The conversion failed. Your original is unchanged; please try again." },
      };
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

class UnreadableError extends Error {}

/** Turns the event stream into a streamed `application/x-ndjson` response. */
export function ndjsonResponse(events: AsyncGenerator<ConvertEvent>, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...headers,
    },
  });
}

/* ---------- 4. cleanup ---------- */

/** Deletes Sendable blobs older than the TTL. Returns how many were removed. */
export async function cleanupBlobs(
  env: Pick<VercelEnv, "blobToken" | "webJobTtlMinutes">,
  now = Date.now(),
): Promise<number> {
  if (!env.blobToken) return 0;
  const cutoff = now - env.webJobTtlMinutes * 60 * 1000;
  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await list({ prefix: `${BLOB_PREFIX}/`, cursor, limit: 1000, token: env.blobToken });
    const stale = page.blobs.filter((blob) => new Date(blob.uploadedAt).getTime() < cutoff).map((blob) => blob.url);
    if (stale.length) {
      await del(stale, { token: env.blobToken });
      removed += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
