import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWebhookSecret as deriveInBuildScript } from "../scripts/vercel-build.mjs";
import {
  EnvError,
  blobStoreId,
  deriveWebhookSecret,
  loadVercelEnv,
  resolvePublicUrl,
  toOrigin,
  workBudgetMs,
} from "./env.js";
import { checkSourceUrl, checkUploadPath, configBody, unavailableReason, UploadRejected } from "./web-convert.js";

const TOKEN = `123456:${"A".repeat(35)}`;
const BLOB_TOKEN = "vercel_blob_rw_AbC123xyz_secretsecretsecret";

test("the build script and the functions derive the same webhook secret", () => {
  const secret = deriveWebhookSecret(TOKEN);
  assert.equal(secret, deriveInBuildScript(TOKEN));
  assert.match(secret, /^[a-f0-9]{48}$/);
  assert.notEqual(secret, deriveWebhookSecret(`${TOKEN}B`), "a new token gives a new secret");
});

test("defaults: no bot token still loads, for a converter-only deployment", () => {
  const env = loadVercelEnv({});
  assert.equal(env.token, "");
  assert.equal(env.webhookSecret, "");
  assert.equal(env.maxUploadMB, 20);
  assert.equal(env.maxOutputMB, 50);
  assert.equal(env.maxSeconds, 300);
  assert.equal(env.webMaxUploadMB, 100);
  assert.equal(env.corsOrigin, "*");
  assert.equal(env.publicUrl, undefined);
});

test("a token gets a derived webhook secret unless WEBHOOK_SECRET is set", () => {
  assert.equal(loadVercelEnv({ TELEGRAM_BOT_TOKEN: TOKEN }).webhookSecret, deriveWebhookSecret(TOKEN));
  assert.equal(loadVercelEnv({ TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET: "my_secret-1" }).webhookSecret, "my_secret-1");
  assert.throws(() => loadVercelEnv({ TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET: "has spaces" }), EnvError);
});

test("bad settings explain themselves", () => {
  assert.throws(() => loadVercelEnv({ TELEGRAM_BOT_TOKEN: "nope" }), /doesn't look like a token/);
  assert.throws(() => loadVercelEnv({ MAX_UPLOAD_MB: "50" }), /only lets bots download files up to 20 MB/);
  assert.throws(() => loadVercelEnv({ CORS_ORIGIN: "example.com/path" }), /CORS_ORIGIN/);
  assert.throws(() => loadVercelEnv({ TELEGRAM_ARCHIVE_CHAT_ID: "not a chat" }), EnvError);
  assert.throws(() => loadVercelEnv({ ALLOW_CUSTOM: "maybe" }), /true or false/);
});

test("the webhook goes to PUBLIC_URL, else the production domain, never a preview URL", () => {
  assert.equal(toOrigin("my-app.vercel.app"), "https://my-app.vercel.app");
  assert.equal(toOrigin("https://my-app.vercel.app/some/path"), "https://my-app.vercel.app");
  assert.equal(resolvePublicUrl({ VERCEL_PROJECT_PRODUCTION_URL: "sendable.vercel.app" }), "https://sendable.vercel.app");
  assert.equal(
    resolvePublicUrl({ PUBLIC_URL: "https://videos.example.com", VERCEL_PROJECT_PRODUCTION_URL: "sendable.vercel.app" }),
    "https://videos.example.com",
  );
  assert.equal(resolvePublicUrl({ VERCEL_URL: "sendable-git-feature.vercel.app" }), undefined);
});

test("work stops before the function time limit", () => {
  assert.equal(workBudgetMs({ maxSeconds: 300 }), 255_000);
  assert.equal(workBudgetMs({ maxSeconds: 800 }), 755_000);
  assert.ok(workBudgetMs({ maxSeconds: 30 }) >= 10_000);
});

test("the Blob store id comes from the read-write token", () => {
  assert.equal(blobStoreId(BLOB_TOKEN), "abc123xyz");
  assert.equal(blobStoreId("something-else"), undefined);
  assert.equal(blobStoreId(undefined), undefined);
});

test("only uploads in this project's own Blob store can be converted", () => {
  const ok = checkSourceUrl(
    "https://abc123xyz.public.blob.vercel-storage.com/sendable/uploads/0123456789ab/IMG_0001-x8Kd.MOV",
    BLOB_TOKEN,
  );
  assert.equal(ok.hostname, "abc123xyz.public.blob.vercel-storage.com");

  const rejected = [
    "https://otherstore.public.blob.vercel-storage.com/sendable/uploads/0123456789ab/a.mov",
    "https://abc123xyz.public.blob.vercel-storage.com/sendable/outputs/0123456789ab/a.mp4",
    "http://abc123xyz.public.blob.vercel-storage.com/sendable/uploads/0123456789ab/a.mov",
    "https://abc123xyz.public.blob.vercel-storage.com/sendable/uploads/../outputs/a.mov",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
    42,
  ];
  for (const url of rejected) assert.throws(() => checkSourceUrl(url, BLOB_TOKEN), UploadRejected, String(url));
  assert.throws(() => checkSourceUrl("https://x.public.blob.vercel-storage.com/sendable/uploads/a/b.mov", undefined));
});

test("browsers may only upload videos into sendable/uploads/<id>/", () => {
  checkUploadPath("sendable/uploads/0123456789abcdef/IMG_0001.MOV");
  checkUploadPath("sendable/uploads/0123456789abcdef/holiday clip.mp4");
  for (const bad of [
    "sendable/uploads/short/IMG.MOV",
    "sendable/outputs/0123456789abcdef/IMG.MOV",
    "sendable/uploads/0123456789abcdef/notes.pdf",
    "sendable/uploads/0123456789abcdef/nested/IMG.MOV",
    "elsewhere/IMG.MOV",
  ]) {
    assert.throws(() => checkUploadPath(bad), UploadRejected, bad);
  }
});

test("the converter explains what's missing, and reports blob mode to the site", () => {
  const env = loadVercelEnv({});
  assert.equal(unavailableReason(env)?.code, "blobMissing");
  assert.equal(unavailableReason({ ...env, webConvert: false })?.code, "disabled");
  const ready = { ...env, blobToken: BLOB_TOKEN };
  assert.equal(unavailableReason(ready), null);
  const body = configBody(ready);
  assert.equal(body.mode, "blob");
  assert.equal(body.upload.handleUploadUrl, "/api/upload");
  assert.equal(body.limits.maxSeconds, 300);
  assert.deepEqual(
    body.presets.map((p) => p.key),
    ["convert", "keep", "balanced", "smaller"],
  );
});
