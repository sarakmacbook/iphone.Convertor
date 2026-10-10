/**
 * Finds a runnable ffmpeg inside a Vercel function.
 *
 * The binary comes from the ffmpeg-static package, which vercel.json bundles into
 * the functions that need it (includeFiles). Some deploy paths drop the executable
 * bit, so when the bundled file can't be executed it is copied to /tmp and made
 * executable there, once per warm instance.
 */

import { constants } from "node:fs";
import { access, chmod, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFfmpeg } from "../bot/src/ffmpeg.js";

let cached: Promise<string> | undefined;

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function prepare(configured?: string): Promise<string> {
  const candidate = resolveFfmpeg(configured);
  // A bare "ffmpeg" means "look on the PATH": nothing to prepare.
  if (!path.isAbsolute(candidate)) return candidate;
  if (await isExecutable(candidate)) return candidate;

  const copy = path.join(tmpdir(), "sendable-ffmpeg");
  const exists = await stat(copy).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) await copyFile(candidate, copy);
  await chmod(copy, 0o755);
  return copy;
}

export function serverlessFfmpeg(configured?: string): Promise<string> {
  cached ??= prepare(configured).catch((error: unknown) => {
    cached = undefined; // Let the next request try again.
    throw error;
  });
  return cached;
}
