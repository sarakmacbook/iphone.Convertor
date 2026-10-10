import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg } from "../bot/src/ffmpeg.js";
import { loadVercelEnv } from "./env.js";
import { convertUpload, ndjsonResponse, type ConvertEvent, type WebConvertEnv } from "./web-convert.js";

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
const skipReason = hasFfmpeg ? false : ("ffmpeg not found" as const);

let workDir: string;
let server: Server;
let base: string;
const files = new Map<string, Buffer>();

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sendable-webconvert-test-"));
  if (hasFfmpeg) {
    const file = path.join(workDir, "holiday.mov");
    const made = spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-c:a", "aac", "-shortest", file,
    ]);
    assert.equal(made.status, 0, made.stderr.toString());
    files.set("/sendable/uploads/0123456789ab/holiday.mov", readFileSync(file));
  }
  files.set("/sendable/uploads/0123456789ab/broken.mov", Buffer.from("not a video"));
  // Stands in for the public Blob URL of the browser's upload.
  server = createServer((req, res) => {
    const body = files.get(new URL(req.url ?? "/", "http://x").pathname);
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "video/quicktime", "content-length": body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
});

function harness(overrides: Partial<WebConvertEnv> = {}) {
  const env: WebConvertEnv = { ...loadVercelEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store1_x" }), ...overrides };
  const saved: Array<{ pathname: string; bytes: number }> = [];
  const removed: string[] = [];
  const deps = {
    ffmpeg: async () => ffmpeg,
    checkUrl: (raw: unknown) => new URL(String(raw)),
    save: async (pathname: string, file: string, bytes: number) => {
      const kept = path.join(workDir, path.basename(pathname));
      copyFileSync(file, kept);
      saved.push({ pathname, bytes });
      return { url: `https://store1.public.blob.vercel-storage.com/${pathname}`, downloadUrl: `https://store1.public.blob.vercel-storage.com/${pathname}?download=1` };
    },
    remove: async (url: string) => void removed.push(url),
  };
  return { env, deps, saved, removed };
}

async function collect(events: AsyncGenerator<ConvertEvent>) {
  const all: ConvertEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

test("converts an uploaded video, stores the result, and deletes the upload", { skip: skipReason }, async () => {
  const { env, deps, saved, removed } = harness();
  const url = `${base}/sendable/uploads/0123456789ab/holiday.mov`;
  const events = await collect(convertUpload({ url, name: "holiday.mov", preset: "smaller" }, env, deps, new AbortController().signal));

  const source = events.find((e) => e.type === "source");
  assert.ok(source?.type === "source");
  assert.equal(source.source.width, 1280);
  assert.equal(source.source.height, 720);

  const done = events.at(-1);
  assert.ok(done?.type === "done", JSON.stringify(done));
  const output = done.job.output;
  assert.equal(output.name, "holiday_480p.mp4");
  assert.equal(output.width, 854);
  assert.equal(output.height, 480);
  assert.equal(output.smaller, true);
  assert.ok(output.bytes < done.job.source.bytes);
  assert.match(output.url, /^https:\/\/store1\.public\.blob\.vercel-storage\.com\/sendable\/outputs\/[0-9a-f-]{36}\/holiday_480p\.mp4$/);
  assert.match(output.downloadUrl, /\?download=1$/);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.bytes, output.bytes);
  const kept = path.join(workDir, "holiday_480p.mp4");
  assert.equal(readFileSync(kept).subarray(4, 8).toString("latin1"), "ftyp", "the stored file is an MP4");
  assert.equal(statSync(kept).size, output.bytes);
  assert.ok(removed.includes(url), "the original upload was deleted");
});

test("custom dimensions are checked before any work starts", async () => {
  const { env, deps, removed } = harness({ maxDimension: 1000 });
  const url = `${base}/sendable/uploads/0123456789ab/holiday.mov`;
  const events = await collect(convertUpload({ url, width: 4000, height: 4000 }, env, deps, new AbortController().signal));
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  assert.ok(events[0]?.type === "error" && events[0].error.code === "badDimensions");
  assert.ok(removed.includes(url), "a rejected upload is still deleted");
});

test("a file that isn't a video gets a clear error and is deleted", { skip: skipReason }, async () => {
  const { env, deps, removed, saved } = harness();
  const url = `${base}/sendable/uploads/0123456789ab/broken.mov`;
  const events = await collect(convertUpload({ url, preset: "balanced" }, env, deps, new AbortController().signal));
  const last = events.at(-1);
  assert.ok(last?.type === "error");
  assert.equal(last.error.code, "unreadable");
  assert.equal(saved.length, 0);
  assert.ok(removed.includes(url));
});

test("uploads over the limit are refused while downloading", { skip: skipReason }, async () => {
  const { env, deps } = harness({ webMaxUploadMB: 0.001 });
  const events = await collect(
    convertUpload({ url: `${base}/sendable/uploads/0123456789ab/holiday.mov`, preset: "smaller" }, env, deps, new AbortController().signal),
  );
  const last = events.at(-1);
  assert.ok(last?.type === "error");
  assert.equal(last.error.code, "tooLarge");
});

test("closing the request cancels the conversion", { skip: skipReason }, async () => {
  const { env, deps, saved } = harness();
  const controller = new AbortController();
  const events: ConvertEvent[] = [];
  for await (const event of convertUpload(
    { url: `${base}/sendable/uploads/0123456789ab/holiday.mov`, preset: "keep" },
    env,
    deps,
    controller.signal,
  )) {
    events.push(event);
    if (event.type === "status" && event.state === "converting") controller.abort();
  }
  const last = events.at(-1);
  assert.ok(last?.type === "error");
  assert.equal(last.error.code, "cancelled");
  assert.equal(saved.length, 0);
});

test("a URL outside this project's Blob store is refused without fetching it", async () => {
  const { env, deps } = harness();
  const { checkUrl: _ignored, ...strict } = deps;
  const events = await collect(convertUpload({ url: `${base}/secret`, preset: "smaller" }, env, strict, new AbortController().signal));
  assert.ok(events[0]?.type === "error" && events[0].error.code === "badUpload");
});

test("events stream to the browser as JSON lines", async () => {
  async function* events(): AsyncGenerator<ConvertEvent> {
    yield { type: "status", state: "downloading" };
    yield { type: "progress", progress: 0.5 };
  }
  const response = ndjsonResponse(events(), { "access-control-allow-origin": "*" });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ type: "status", state: "downloading" }, { type: "progress", progress: 0.5 }]);
});
