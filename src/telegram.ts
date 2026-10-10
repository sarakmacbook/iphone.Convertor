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

/* -------------------------------------------------------------------------
   Bot server URL: where the site sends Telegram Login Widget payloads to be
   verified (the bot's POST /telegram/login endpoint). Same pattern as the
   username: VITE_BOT_API_URL at build time, overridable per browser in the
   Connect section. The bot's token never comes to the website.
   ------------------------------------------------------------------------- */

const API_STORAGE_KEY = "sendable.botApiUrl";

/** Login endpoint served by the bot (see bot/src/auth.ts). */
export const TELEGRAM_LOGIN_PATH = "/telegram/login";

/**
 * VITE_BOT_API_URL=same-origin (set automatically on Vercel, where the bot and
 * converter run as this site's own /api functions) means "this site itself".
 */
function defaultApiUrl(raw: string): string {
  const value = raw.trim();
  if (value === "/" || value.toLowerCase() === "same-origin") {
    return typeof window !== "undefined" ? window.location.origin : "";
  }
  return normalizeApiUrl(value);
}

export const DEFAULT_BOT_API_URL = defaultApiUrl(import.meta.env?.VITE_BOT_API_URL ?? "");

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/**
 * Accepts "https://host", "http://localhost:8080" or a full URL with a path,
 * and returns a normalized base (no trailing slash). "" when unusable:
 * only https is allowed, plus http for localhost while developing.
 */
export function normalizeApiUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const isLocal = LOCAL_HOSTS.includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

export function apiUrlError(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "Enter the address your bot runs on, like https://my-bot.example.com";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That doesn't look like a web address. Try https://my-bot.example.com";
  }
  const isLocal = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    return "The address must start with https:// (http:// is only allowed for localhost).";
  }
  return null;
}

export function apiHost(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}

function readStoredApiUrl(): string | null {
  try {
    const value = window.localStorage.getItem(API_STORAGE_KEY);
    return value ? normalizeApiUrl(value) || null : null;
  } catch {
    return null;
  }
}

export function useBotApiUrl() {
  const [apiUrl, setApiUrlState] = useState<string>(
    () => readStoredApiUrl() ?? DEFAULT_BOT_API_URL,
  );

  const setApiUrl = useCallback((value: string) => {
    const clean = normalizeApiUrl(value);
    if (!clean) return false;
    setApiUrlState(clean);
    try {
      if (clean === DEFAULT_BOT_API_URL) window.localStorage.removeItem(API_STORAGE_KEY);
      else window.localStorage.setItem(API_STORAGE_KEY, clean);
    } catch {
      // Private mode: the choice still applies until the page is closed.
    }
    return true;
  }, []);

  const resetApiUrl = useCallback(() => {
    setApiUrlState(DEFAULT_BOT_API_URL);
    try {
      window.localStorage.removeItem(API_STORAGE_KEY);
    } catch {
      // Ignored, same as above.
    }
  }, []);

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === API_STORAGE_KEY) setApiUrlState(readStoredApiUrl() ?? DEFAULT_BOT_API_URL);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    apiUrl,
    setApiUrl,
    resetApiUrl,
    isDefault: apiUrl === DEFAULT_BOT_API_URL,
  };
}
