import { useCallback, useEffect, useState } from "react";

/**
 * Which Telegram bot the site links to.
 *
 * Priority: ?bot=Name in the URL → the bot a visitor picked in the Connect
 * section (saved in this browser) → VITE_TELEGRAM_BOT_USERNAME at build time
 * → "SendableBot".
 */

const STORAGE_KEY = "sendable.botUsername";

const envUsername = normalizeBotUsername(import.meta.env?.VITE_TELEGRAM_BOT_USERNAME ?? "");
export const DEFAULT_BOT_USERNAME =
  envUsername && isValidBotUsername(envUsername) ? envUsername : "SendableBot";

/** Accepts "@name", "name", "t.me/name" or "https://t.me/name?start=x". */
export function normalizeBotUsername(input: string): string {
  return input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
}

/** Telegram bot usernames: 5–32 letters, digits or underscores, starting with a letter, ending in "bot". */
export function isValidBotUsername(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i.test(name);
}

export function botUsernameError(input: string): string | null {
  const name = normalizeBotUsername(input);
  if (!name) return "Enter your bot's username, like @MyVideoBot.";
  if (!/^[A-Za-z0-9_]+$/.test(name)) return "Usernames can only use letters, numbers, and underscores.";
  if (!/^[A-Za-z]/.test(name)) return "Usernames start with a letter.";
  if (name.length < 5 || name.length > 32) return "Usernames are 5 to 32 characters long.";
  if (!/bot$/i.test(name)) return "Telegram bot usernames always end in \"bot\", like @MyVideoBot.";
  return null;
}

export function botUrl(username: string, start = "web"): string {
  return `https://t.me/${username}${start ? `?start=${encodeURIComponent(start)}` : ""}`;
}

export function botShareUrl(username: string): string {
  const url = encodeURIComponent(`https://t.me/${username}`);
  const text = encodeURIComponent("Sendable: smaller iPhone videos in Telegram");
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

function readStored(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && isValidBotUsername(value) ? value : null;
  } catch {
    return null;
  }
}

function readFromUrl(): string | null {
  const value = normalizeBotUsername(new URLSearchParams(window.location.search).get("bot") ?? "");
  return value && isValidBotUsername(value) ? value : null;
}

export function useBotUsername() {
  const [username, setUsernameState] = useState<string>(
    () => readFromUrl() ?? readStored() ?? DEFAULT_BOT_USERNAME,
  );

  const setUsername = useCallback((name: string) => {
    const clean = normalizeBotUsername(name);
    if (!isValidBotUsername(clean)) return false;
    setUsernameState(clean);
    try {
      if (clean === DEFAULT_BOT_USERNAME) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, clean);
    } catch {
      // Private mode: the choice still applies until the page is closed.
    }
    return true;
  }, []);

  const resetUsername = useCallback(() => setUsername(DEFAULT_BOT_USERNAME), [setUsername]);

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setUsernameState(readStored() ?? DEFAULT_BOT_USERNAME);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    username,
    setUsername,
    resetUsername,
    isDefault: username === DEFAULT_BOT_USERNAME,
  };
}
