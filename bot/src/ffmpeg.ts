import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { crfFor, scaleFilter, type SizeChoice } from "./sizes.js";

/**
 * Finds an ffmpeg binary: FFMPEG_PATH first, then the optional ffmpeg-static
 * npm package, then whatever "ffmpeg" is on the PATH.
 */
export function resolveFfmpeg(configured?: string): string {
  if (configured) return configured;
  try {
    const require = createRequire(import.meta.url);
    const bundled = require("ffmpeg-static") as string | null;
    // The package can install without its binary if the download was blocked.
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // ffmpeg-static is optional; fall through to the system binary.
  }
  return "ffmpeg";
}

export function checkFfmpeg(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", (error) =>
      reject(new Error(`Could not run ffmpeg at "${binary}". Install ffmpeg or set FFMPEG_PATH. (${error.message})`)),
    );
    child.on("close", (code) =>
      code === 0 ? resolve(out.split("\n")[0] ?? "ffmpeg") : reject(new Error(`ffmpeg exited with code ${code}`)),
    );
  });
}

export type ResizeResult = {
  width?: number;
  height?: number;
  duration?: number;
};

export class CancelledError extends Error {
  constructor() {
    super("Resize cancelled");
    this.name = "CancelledError";
  }
}

export function buildArgs(input: string, output: string, choice: SizeChoice): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", scaleFilter(choice),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(crfFor(choice)),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    // Drop metadata such as GPS location from the copy; the original is untouched.
    "-map_metadata", "-1",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    output,
  ];
}

function parseClock(value: string): number {
  const [h, m, s] = value.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/** Pulls the output video's dimensions out of ffmpeg's log. */
export function parseOutputInfo(log: string): ResizeResult {
  const result: ResizeResult = {};
  const outputSection = log.slice(log.indexOf("Output #0"));
  const dims = outputSection.match(/Video: [^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  if (dims) {
    result.width = Number(dims[1]);
    result.height = Number(dims[2]);
  }
  const duration = log.match(/Duration: (\d+:\d+:\d+(?:\.\d+)?)/);
  if (duration?.[1]) result.duration = parseClock(duration[1]);
  return result;
}

export function resizeVideo(options: {
  binary: string;
  input: string;
  output: string;
  choice: SizeChoice;
  /** Known duration in seconds, used for progress. ffmpeg's own value is used if missing. */
  duration?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<ResizeResult> {
  const { binary, input, output, choice, signal, onProgress } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());

    const child = spawn(binary, buildArgs(input, output, choice), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    let duration = options.duration;
    let pending = "";

    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (log.length > 200_000) log = log.slice(-200_000);
      if (!duration) {
        const match = log.match(/Duration: (\d+:\d+:\d+(?:\.\d+)?)/);
        if (match?.[1]) duration = parseClock(match[1]);
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.trim().split("=");
        if (key === "out_time_us" && duration && value && /^\d+$/.test(value)) {
          onProgress?.(Math.min(1, Number(value) / 1_000_000 / duration));
        }
      }
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new CancelledError());
      if (code !== 0) {
        const tail = log.trim().split("\n").slice(-8).join("\n");
        return reject(new Error(`ffmpeg exited with code ${code}\n${tail}`));
      }
      const info = parseOutputInfo(log);
      resolve({ ...info, duration: duration ?? info.duration });
    });
  });
}
