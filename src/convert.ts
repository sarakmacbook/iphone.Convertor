/**
 * Client for the bot server's conversion API (bot/src/web.ts).
 *
 * The site never needs a secret: it points at a bot server address (see
 * telegram.ts) or calls the same origin, which the dev server proxies to the
 * bot. Uploads use XMLHttpRequest because fetch cannot report upload progress
 * in browsers; everything else is plain fetch.
 */

export type Preset = {
  key: string;
  label: string;
  detail: string;
  /** Target length of the shorter side, or null to keep the original size. */
  shortSide: number | null;
};

export type ConvertLimits = {
  maxUploadMB: number;
  allowCustom: boolean;
  maxDimension: number;
  maxConcurrentJobs: number;
  jobTtlMinutes: number;
  /** Vercel: the function time limit, which caps how long a video can be. */
  maxSeconds?: number;
};

export type ServerConfig = {
  ok: true;
  /**
   * "jobs" (or missing): the long-running bot server — multipart upload, then poll.
   * "blob": the Vercel deployment — upload to Vercel Blob, then one streamed convert call.
   */
  mode?: "jobs" | "blob";
  limits: ConvertLimits;
  presets: Preset[];
  accepts: string[];
  upload?: { handleUploadUrl: string; access: "public"; prefix: string };
};

export type JobState = "queued" | "converting" | "done" | "error" | "cancelled";

export type JobMedia = {
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
};

export type JobOutput = JobMedia & {
  smaller: boolean;
  /** Relative to the bot server, e.g. "/api/jobs/<id>/download", or an absolute Blob URL on Vercel. */
  url: string;
  /** Vercel Blob only: the same file with a "save as" Content-Disposition. */
  downloadUrl?: string;
};

export type Job = {
  id: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  createdAt: number;
  updatedAt: number;
  source: JobMedia;
  choice: { kind: "preset" | "custom"; key?: string; label: string; width?: number; height?: number };
  output?: JobOutput;
  error?: { code: string; message: string };
};

export type SizeRequest = { preset: string } | { width: number; height: number };

/** Used when the server can't be reached, so the UI still renders. */
export const FALLBACK_PRESETS: Preset[] = [
  { key: "convert", label: "Convert to MP4 (same dimensions)", detail: "Standard MP4 at the original resolution.", shortSide: null },
  { key: "keep", label: "High quality (same dimensions)", detail: "Keeps the original resolution; savings vary.", shortSide: null },
  { key: "balanced", label: "Recommended (720p)", detail: "A good place to start for everyday sharing.", shortSide: 720 },
  { key: "smaller", label: "Smaller (480p)", detail: "More reduction; fine details may look softer.", shortSide: 480 },
];

/** Set at build time only; it is visible in the bundle, so it deters abuse rather than hiding anything. */
const API_KEY = (import.meta.env?.VITE_BOT_API_KEY as string | undefined)?.trim() || "";

export class ConvertError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ConvertError";
    this.code = code;
    this.status = status;
  }
}

/** Joins a (possibly empty) base URL with an API path. */
export function apiUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = new URLSearchParams(params ?? {});
  if (API_KEY) query.set("key", API_KEY);
  const suffix = query.toString();
  return `${base}${path}${suffix ? `?${suffix}` : ""}`;
}

function headers(): Record<string, string> {
  return API_KEY ? { "x-api-key": API_KEY } : {};
}

async function parseError(response: Response, fallback: string): Promise<ConvertError> {
  let code = "requestFailed";
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // A non-JSON response (proxy error page, for example): keep the fallback.
  }
  return new ConvertError(code, message, response.status);
}

export async function fetchServerConfig(baseUrl: string, signal?: AbortSignal): Promise<ServerConfig> {
  let response: Response;
  try {
    response = await fetch(apiUrl(baseUrl, "/api/config"), { signal, headers: headers() });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ConvertError("offline", "Couldn't reach the bot server.", 0);
  }
  if (!response.ok) throw await parseError(response, "Couldn't read the server's settings.");
  return (await response.json()) as ServerConfig;
}

export type UploadOptions = {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

/**
 * Uploads the file and starts a conversion job. Resolves with the new job
 * (state "queued"); use `pollJob` to follow it to completion.
 */
export function startConvert(
  baseUrl: string,
  file: File,
  request: SizeRequest,
  options: UploadOptions = {},
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("video", file, file.name);
    if ("preset" in request) form.append("preset", request.preset);
    else {
      form.append("width", String(request.width));
      form.append("height", String(request.height));
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(baseUrl, "/api/convert"));
    for (const [key, value] of Object.entries(headers())) xhr.setRequestHeader(key, value);
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: { ok?: boolean; job?: Job; error?: { code?: string; message?: string } } = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        // Fall through with an empty body.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.job) {
        resolve(body.job);
        return;
      }
      reject(
        new ConvertError(
          body.error?.code ?? "uploadFailed",
          body.error?.message ?? "The upload didn't finish. Check the connection and try again.",
          xhr.status,
        ),
      );
    };
    xhr.onerror = () => reject(new ConvertError("offline", "Couldn't reach the bot server.", 0));
    xhr.ontimeout = () => reject(new ConvertError("timeout", "The upload took too long.", 0));
    xhr.onabort = () => reject(new ConvertError("cancelled", "Upload cancelled.", 0));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(form);
  });
}

export async function fetchJob(baseUrl: string, id: string, signal?: AbortSignal): Promise<Job> {
  const response = await fetch(apiUrl(baseUrl, `/api/jobs/${id}`), { signal, headers: headers() });
  if (!response.ok) throw await parseError(response, "That conversion has expired.");
  const body = (await response.json()) as { ok: boolean; job: Job };
  return body.job;
}

export async function cancelJob(baseUrl: string, id: string): Promise<void> {
  await fetch(apiUrl(baseUrl, `/api/jobs/${id}`), {
    method: "DELETE",
    headers: headers(),
  }).catch(() => undefined);
}

/** Polls until the job finishes. Resolves with the final job. */
export async function pollJob(
  baseUrl: string,
  id: string,
  options: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (job: Job) => void } = {},
): Promise<Job> {
  const interval = options.intervalMs ?? 800;
  for (;;) {
    const job = await fetchJob(baseUrl, id, options.signal);
    options.onUpdate?.(job);
    if (job.state !== "queued" && job.state !== "converting") return job;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Full URL for the converted file; `inline` plays it in the page instead of downloading. */
export function downloadUrl(baseUrl: string, job: Job, inline = false): string {
  if (!job.output) return "";
  // Vercel Blob: the file is already at a public URL.
  if (/^https?:\/\//i.test(job.output.url)) {
    return inline ? job.output.url : (job.output.downloadUrl ?? job.output.url);
  }
  return apiUrl(baseUrl, job.output.url, inline ? { inline: "1" } : undefined);
}

/* ---------- Vercel mode: upload to Vercel Blob, then one streamed convert call ---------- */

type BlobEvent =
  | { type: "status"; state: "downloading" | "converting" | "saving" }
  | { type: "source"; source: JobMedia }
  | { type: "progress"; progress: number }
  | { type: "done"; job: Job }
  | { type: "error"; error: { code: string; message: string } };

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keeps the name readable but safe for a Blob path. */
function blobFileName(name: string): string {
  const clean = name.replace(/[\\/?#%\u0000-\u001f\u007f]/g, "_").slice(-120);
  return clean || "video.mov";
}

function guessContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.mov$/i.test(file.name)) return "video/quicktime";
  if (/\.m4v$/i.test(file.name)) return "video/x-m4v";
  return "video/mp4";
}

export type BlobConvertOptions = {
  signal?: AbortSignal;
  /** 0..1 while the video uploads to Vercel Blob. */
  onUploadProgress?: (fraction: number) => void;
  /** Called with a job snapshot as the server reports progress. */
  onUpdate?: (job: Job) => void;
};

/**
 * Uploads straight from the browser to Vercel Blob (no 4.5 MB function limit),
 * then asks /api/convert to convert it and reads the streamed progress.
 */
export async function convertWithBlob(
  baseUrl: string,
  config: ServerConfig,
  file: File,
  request: SizeRequest,
  options: BlobConvertOptions = {},
): Promise<Job> {
  const upload = config.upload ?? { handleUploadUrl: "/api/upload", access: "public" as const, prefix: "sendable/uploads" };
  const { upload: uploadToBlob } = await import("@vercel/blob/client");

  let blobUrl: string;
  try {
    const blob = await uploadToBlob(`${upload.prefix}/${randomId()}/${blobFileName(file.name)}`, file, {
      access: upload.access,
      handleUploadUrl: apiUrl(baseUrl, upload.handleUploadUrl),
      headers: headers(),
      contentType: guessContentType(file),
      multipart: file.size > 20 * 1024 * 1024,
      abortSignal: options.signal,
      onUploadProgress: ({ loaded, total }) => {
        if (total > 0) options.onUploadProgress?.(loaded / total);
      },
    });
    blobUrl = blob.url;
  } catch (error) {
    if (options.signal?.aborted) throw new ConvertError("cancelled", "Upload cancelled.", 0);
    const message = (error as Error)?.message ?? "";
    throw new ConvertError(
      "uploadFailed",
      /too large|maximum size/i.test(message)
        ? `That video is over the ${config.limits.maxUploadMB} MB limit. Try a shorter clip.`
        : /content type/i.test(message)
          ? "That doesn't look like a video. Please pick a MOV or MP4 from your gallery."
          : "The upload didn't finish. Check your connection and try again.",
      0,
    );
  }
  options.onUploadProgress?.(1);

  const body: Record<string, string | number> = { url: blobUrl, name: file.name };
  if ("preset" in request) body.preset = request.preset;
  else {
    body.width = request.width;
    body.height = request.height;
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(baseUrl, "/api/convert"), {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new ConvertError("cancelled", "Cancelled.", 0);
    throw new ConvertError("offline", "Couldn't reach the server to convert the video.", 0);
  }
  if (!response.ok || !response.body) throw await parseError(response, "The conversion couldn't start.");

  const now = Date.now();
  const label =
    "preset" in request
      ? (config.presets.find((p) => p.key === request.preset)?.label ?? request.preset)
      : `${request.width} × ${request.height}`;
  let job: Job = {
    id: "pending",
    state: "converting",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    source: { name: file.name, bytes: file.size },
    choice:
      "preset" in request
        ? { kind: "preset", key: request.preset, label }
        : { kind: "custom", label, width: request.width, height: request.height },
  };
  options.onUpdate?.(job);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: BlobEvent;
        try {
          event = JSON.parse(line) as BlobEvent;
        } catch {
          continue;
        }
        if (event.type === "source") job = { ...job, source: event.source, updatedAt: Date.now() };
        else if (event.type === "progress") job = { ...job, progress: event.progress, updatedAt: Date.now() };
        else if (event.type === "status" && event.state === "saving") job = { ...job, progress: 1, updatedAt: Date.now() };
        else if (event.type === "done") {
          options.onUpdate?.(event.job);
          return event.job;
        } else if (event.type === "error") {
          if (event.error.code === "cancelled") throw new ConvertError("cancelled", event.error.message, 0);
          return { ...job, state: "error", progress: 0, error: event.error, updatedAt: Date.now() };
        }
        options.onUpdate?.(job);
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof ConvertError) throw error;
    if ((error as Error)?.name === "AbortError" || options.signal?.aborted) {
      throw new ConvertError("cancelled", "Cancelled.", 0);
    }
    throw new ConvertError("offline", "The connection dropped while converting. Please try again.", 0);
  }
  // The stream ended without a result: most likely the function hit its time limit.
  const minutes = config.limits.maxSeconds ? Math.round(config.limits.maxSeconds / 60) : 5;
  return {
    ...job,
    state: "error",
    progress: 0,
    error: {
      code: "tooLong",
      message: `The server stopped before finishing (it allows about ${minutes} min). Try Smaller (480p) or a shorter clip.`,
    },
  };
}

/* ---------- small formatting helpers shared with the bot's own copy ---------- */

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatDimensions(width?: number, height?: number): string {
  return width && height ? `${width} × ${height}` : "—";
}

/** "−72%" style saving, or null when the copy isn't smaller. */
export function savingPercent(sourceBytes: number, outputBytes: number): number | null {
  if (sourceBytes <= 0 || outputBytes >= sourceBytes) return null;
  return Math.round((1 - outputBytes / sourceBytes) * 100);
}

export const SUPPORTED_EXT = /\.(mov|mp4|m4v)$/i;

/** A friendly reason not to accept a file, or null when it looks fine. */
export function fileProblem(file: File, maxUploadMB: number): string | null {
  if (file.size === 0) return "That file is empty. Please pick another video.";
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const looksLikeVideo = type.startsWith("video/") || SUPPORTED_EXT.test(file.name);
  if (!looksLikeVideo) return "That doesn't look like a video. Please pick a MOV or MP4 from your gallery.";
  const maxBytes = maxUploadMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return `${file.name} is ${formatBytes(file.size)}, which is over the ${maxUploadMB} MB limit. Try a shorter clip.`;
  }
  return null;
}
