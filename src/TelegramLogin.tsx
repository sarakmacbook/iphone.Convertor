import { useEffect, useRef, useState } from "react";
import { CheckIcon, TelegramIcon } from "./icons";
import { botUrl } from "./telegram";
import {
  WIDGET_REQUEST_ACCESS,
  mountLoginWidget,
  useTelegramLogin,
  type SignedInUser,
} from "./telegramLogin";

/**
 * "Sign in with Telegram" for the Connect section: the official Login Widget
 * for the currently connected bot, verified by that bot's own server, and a
 * signed-in card with a deep link back into the chat.
 */

type Props = {
  botUsername: string;
  /** Base URL of the bot server ("" when nobody has set one yet). */
  apiUrl: string;
  onSignedIn?: (user: SignedInUser) => void;
  onSignedOut?: () => void;
};

function timeAgo(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function Avatar({ user }: { user: SignedInUser }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const initials = `${user.firstName.charAt(0)}${user.lastName?.charAt(0) ?? ""}`.toUpperCase();

  if (user.photoUrl && !photoFailed) {
    return (
      <img
        className="tg-avatar"
        src={user.photoUrl}
        alt=""
        width={52}
        height={52}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setPhotoFailed(true)}
      />
    );
  }
  return (
    <span className="tg-avatar tg-avatar-fallback" aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

function TelegramLogin({ botUsername, apiUrl, onSignedIn, onSignedOut }: Props) {
  const { user, status, error, signIn, signOut } = useTelegramLogin(apiUrl, botUsername);
  const widgetRef = useRef<HTMLDivElement>(null);

  // Keep the latest callbacks without making the widget effect re-run (which
  // would reload the button and flicker).
  const handlers = useRef({ signIn, onSignedIn });
  handlers.current = { signIn, onSignedIn };

  useEffect(() => {
    const container = widgetRef.current;
    if (!container || !apiUrl || user) return;
    return mountLoginWidget(container, {
      botUsername,
      requestAccess: WIDGET_REQUEST_ACCESS,
      onAuth: (payload) => {
        void handlers.current.signIn(payload).then((verified) => {
          if (verified) handlers.current.onSignedIn?.(verified);
        });
      },
    });
  }, [apiUrl, botUsername, user]);

  const handleSignOut = () => {
    signOut();
    onSignedOut?.();
  };

  if (user) {
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return (
      <div className="tg-login" aria-label="Telegram sign-in">
        <span className="connect-label">SIGN IN WITH TELEGRAM</span>
        <h3 className="tg-login-title">You're connected.</h3>
        <div className="tg-signed">
          <Avatar user={user} />
          <div className="tg-signed-info">
            <strong className="tg-name">{displayName}</strong>
            <span className="tg-handle">
              {user.username ? `@${user.username}` : `Telegram ID ${user.id}`}
            </span>
            <span className="connect-badge">
              <span aria-hidden="true" />
              Verified by @{user.botUsername}
            </span>
            <div className="connect-actions">
              <a
                className="button-primary"
                href={botUrl(botUsername, `web-${user.id}`)}
                target="_blank"
                rel="noreferrer"
              >
                <TelegramIcon />
                Open @{botUsername}
              </a>
              <button className="text-button tg-signout" type="button" onClick={handleSignOut}>
                Sign out
              </button>
            </div>
            <p className="tg-signed-note">
              <CheckIcon /> Signed in {timeAgo(user.verifiedAt)} · checked by {user.apiHost}.
              Stored only in this browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tg-login" aria-labelledby="tg-login-title">
      <span className="connect-label">SIGN IN WITH TELEGRAM</span>
      <h3 className="tg-login-title" id="tg-login-title">
        Link your Telegram account.
      </h3>
      <p className="tg-login-copy">
        Use Telegram's official button to sign in with the account you already use. Your bot's own
        server checks the sign-in is genuine — this page never sees the bot's token. You share only
        your name, username, and photo.
      </p>

      {apiUrl ? (
        <div className="tg-widget" ref={widgetRef} />
      ) : (
        <div className="tg-need-server">
          <strong>One step away.</strong> Sign-ins are verified by the bot you connected, so the
          site needs its server address (the <code>/telegram/login</code> endpoint). Add it just
          above, or build the site with <code>VITE_BOT_API_URL</code>. In @BotFather, send{" "}
          <code>/setdomain</code> for your bot and enter this site's domain — Telegram requires
          that before the button will work here.
        </div>
      )}

      <p className="tg-status" role="status">
        {status === "verifying" ? "Checking the sign-in with your bot server…" : ""}
      </p>
      {error && (
        <p className="form-error tg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default TelegramLogin;
