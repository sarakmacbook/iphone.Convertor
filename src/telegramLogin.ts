import { useCallback, useEffect, useRef, useState } from "react";
import { TELEGRAM_LOGIN_PATH, apiHost } from "./telegram";

/**
 * "Sign in with Telegram" for the website, using Telegram's official Login
 * Widget (https://core.telegram.org/widgets/login).
 *
 * The widget hands the browser a signed payload (id, first_name, …, hash).
 * The browser POSTs it to the bot server's /telegram/login endpoint, which
 * proves the payload came from Telegram using the bot token. The token never
 * reaches the website, and nothing is trusted until the server says ok.
 */

export type TelegramAuthPayload = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

export type SignedInUser = {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  /** Unix seconds, from Telegram. */
  authDate: number;
  /** Epoch ms, when the bot server verified the payload. */
  verifiedAt: number;
  /** Which bot verified this sign-in. */
  botUsername: string;
  /** Host of the bot server that verified it. */
  apiHost: string;
};

const USER_STORAGE_KEY = "sendable.telegramUser";
/** After this long the local sign-in is dropped and the widget shows again. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const WIDGET_SCRIPT_URL = "https://telegram.org/js/telegram-widget.js?22";

/** "write" lets the bot send a hello after sign-in; VITE_TELEGRAM_REQUEST_ACCESS disables it. */
export const WIDGET_REQUEST_ACCESS =
  (import.meta.env?.VITE_TELEGRAM_REQUEST_ACCESS ?? "write").trim().toLowerCase() === "write"
    ? ("write" as const)
    : undefined;

type TelegramWindow = Window & { onTelegramAuth?: (user: TelegramAuthPayload) => void };

export type WidgetOptions = {
  botUsername: string;
  size?: "small" | "medium" | "large";
  radius?: number;
  requestAccess?: "write";
  onAuth: (user: TelegramAuthPayload) => void;
};

/**
 * Renders the official Telegram button inside `container` (the widget script
 * carries its configuration as data-* attributes and inserts itself there).
 * Returns a cleanup function; safe to re-run when the bot username changes.
 */
export function mountLoginWidget(container: HTMLElement, options: WidgetOptions): () => void {
  const target = container.ownerDocument.defaultView as TelegramWindow | null;
  if (!target) return () => undefined;
  target.onTelegramAuth = options.onAuth;

  container.replaceChildren();
  const script = container.ownerDocument.createElement("script");
  script.async = true;
  script.src = WIDGET_SCRIPT_URL;
  script.dataset.telegramLogin = options.botUsername;
  script.dataset.size = options.size ?? "medium";
  script.dataset.radius = String(options.radius ?? 5);
  script.dataset.userpic = "true";
  if (options.requestAccess) script.dataset.requestAccess = options.requestAccess;
  script.dataset.onauth = "onTelegramAuth(user)";
  container.appendChild(script);

  return () => {
    container.replaceChildren();
    if (target.onTelegramAuth === options.onAuth) delete target.onTelegramAuth;
  };
}

/** Sends the widget payload to the bot server for verification. */
export async function verifyTelegramLogin(
  apiUrl: string,
  payload: TelegramAuthPayload,
  botUsername: string,
): Promise<SignedInUser> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${TELEGRAM_LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      `Couldn't reach the bot server at ${apiHost(apiUrl)}. Is it running, and does its CORS_ORIGIN allow this site?`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;

  if (response.ok && record?.ok === true) {
    const user = record.user as Record<string, unknown> | undefined;
    if (user && typeof user.id === "number" && typeof user.first_name === "string") {
      return {
        id: user.id,
        firstName: user.first_name,
        lastName: typeof user.last_name === "string" ? user.last_name : undefined,
        username: typeof user.username === "string" ? user.username : undefined,
        photoUrl: typeof user.photo_url === "string" ? user.photo_url : undefined,
        authDate: Number(user.auth_date) || Math.floor(Date.now() / 1000),
        verifiedAt: Date.now(),
        botUsername,
        apiHost: apiHost(apiUrl),
      };
    }
  }

  if (typeof record?.error === "string" && record.error) throw new Error(record.error);
  throw new Error(`The bot server didn't accept this sign-in (HTTP ${response.status}).`);
}

function isStoredUser(value: unknown): value is SignedInUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "number" &&
    typeof user.firstName === "string" &&
    typeof user.verifiedAt === "number" &&
    typeof user.botUsername === "string"
  );
}

function readStoredUser(): SignedInUser | null {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const user: unknown = JSON.parse(raw);
    if (!isStoredUser(user)) return null;
    if (Date.now() - user.verifiedAt > SESSION_TTL_MS) {
      window.localStorage.removeItem(USER_STORAGE_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

function persistUser(user: SignedInUser | null) {
  try {
    if (user) window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // Private mode: the sign-in still applies until the page is closed.
  }
}

export type LoginStatus = "idle" | "verifying";

export function useTelegramLogin(apiUrl: string, botUsername: string) {
  const [user, setUser] = useState<SignedInUser | null>(readStoredUser);
  const [status, setStatus] = useState<LoginStatus>("idle");
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const signIn = useCallback(
    async (payload: TelegramAuthPayload): Promise<SignedInUser | null> => {
      if (!apiUrl) {
        setError("Add your bot's server address in the Connect section first, so this site can verify the sign-in.");
        return null;
      }
      const request = ++requestId.current;
      setStatus("verifying");
      setError("");
      try {
        const verified = await verifyTelegramLogin(apiUrl, payload, botUsername);
        if (request !== requestId.current) return null; // A newer attempt took over.
        persistUser(verified);
        setUser(verified);
        return verified;
      } catch (problem) {
        if (request !== requestId.current) return null;
        setError(problem instanceof Error ? problem.message : "The sign-in didn't go through. Please try again.");
        return null;
      } finally {
        if (request === requestId.current) setStatus("idle");
      }
    },
    [apiUrl, botUsername],
  );

  const signOut = useCallback(() => {
    requestId.current++;
    persistUser(null);
    setUser(null);
    setError("");
    setStatus("idle");
  }, []);

  const clearError = useCallback(() => setError(""), []);

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === USER_STORAGE_KEY) setUser(readStoredUser());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { user, status, error, signIn, signOut, clearError };
}
