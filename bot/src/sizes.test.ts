import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CancelledError, resizeVideo, resolveFfmpeg } from "./ffmpeg.js";
import { findPreset, formatDuration, formatMB, parseCustomSize, presetChoice } from "./sizes.js";

test("parseCustomSize accepts common formats", () => {
  for (const input of ["720 x 1280", "720x1280", "720 X 1280", "720*1280", "720, 1280", "720 1280", "720×1280px"]) {
    const result = parseCustomSize(input, 3840);
    assert.ok(result.ok, input);
    if (result.ok && result.choice.kind === "custom") {
      assert.equal(result.choice.width, 720);
      assert.equal(result.choice.height, 1280);
    }
  }
});

test("parseCustomSize rejects bad and oversized input", () => {
  assert.deepEqual(parseCustomSize("big please", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("0 x 100", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("720.5 x 1280", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("5000 x 1280", 3840), { ok: false, reason: "tooLarge" });
});

test("formatting helpers", () => {
  assert.equal(formatMB(86 * 1024 * 1024), "86 MB");
  assert.equal(formatMB(2.25 * 1024 * 1024), "2.3 MB");
  assert.equal(formatDuration(47), "0:47");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(undefined), undefined);
});

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

function makeVideo(dir: string, width: number, height: number) {
  const file = path.join(dir, `in_${width}x${height}.mov`);
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=2`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", file,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return file;
}

test("resizes portrait and landscape videos without stretching", { skip: !hasFfmpeg && "ffmpeg not found" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-test-"));
  try {
    const portrait = makeVideo(dir, 1080, 1920);
    const landscape = makeVideo(dir, 1920, 1080);

    const cases = [
      { input: portrait, choice: presetChoice(findPreset("balanced")!), expect: [720, 1280] },
      { input: landscape, choice: presetChoice(findPreset("balanced")!), expect: [1280, 720] },
      { input: portrait, choice: presetChoice(findPreset("smaller")!), expect: [480, 854] },
      { input: portrait, choice: presetChoice(findPreset("keep")!), expect: [1080, 1920] },
      // Fit inside a box, keeping the shape.
      { input: landscape, choice: (parseCustomSize("720 x 1280", 3840) as any).choice, expect: [720, 406] },
      // Never upscale.
      { input: landscape, choice: (parseCustomSize("3840 x 3840", 3840) as any).choice, expect: [1920, 1080] },
    ];

    for (const [i, c] of cases.entries()) {
      const output = path.join(dir, `out_${i}.mp4`);
      let progressCalls = 0;
      const result = await resizeVideo({
        binary: ffmpeg,
        input: c.input,
        output,
        choice: c.choice,
        onProgress: () => progressCalls++,
      });
      assert.deepEqual([result.width, result.height], c.expect, `case ${i}: ${c.choice.label}`);
      assert.ok(statSync(output).size > 0);
      assert.ok(result.duration && Math.abs(result.duration - 2) < 0.2, `duration ${result.duration}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling stops ffmpeg", { skip: !hasFfmpeg && "ffmpeg not found" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-test-"));
  try {
    const input = makeVideo(dir, 1920, 1080);
    const controller = new AbortController();
    const job = resizeVideo({
      binary: ffmpeg,
      input,
      output: path.join(dir, "out.mp4"),
      choice: presetChoice(findPreset("keep")!),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(job, CancelledError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
