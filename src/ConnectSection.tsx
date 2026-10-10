import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import TelegramLogin from "./TelegramLogin";
import { ArrowIcon, CheckIcon, CopyIcon, TelegramIcon } from "./icons";
import {
  DEFAULT_BOT_API_URL,
  DEFAULT_BOT_USERNAME,
  apiHost,
  apiUrlError,
  botShareUrl,
  botUrl,
  botUsernameError,
  normalizeBotUsername,
} from "./telegram";

type Props = {
  username: string;
  isDefault: boolean;
  onConnect: (name: string) => boolean;
  onReset: () => void;
  /** Base URL of the bot server that verifies sign-ins ("" when unset). */
  apiUrl: string;
  isDefaultApi: boolean;
  onConnectApi: (url: string) => boolean;
  onResetApi: () => void;
};

function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: count, path: d };
  }, [value]);

  return (
    <svg
      className="connect-qr-code"
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" />
      <path d={path} fill="currentColor" />
    </svg>
  );
}

const setupSteps = [
  {
    title: "Create the bot",
    body: (
      <>
        In Telegram, open{" "}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
          @BotFather
        </a>
        , send <code>/newbot</code>, and pick a name and a username ending in “bot”. It replies with
        a token. Keep it secret, like a password.
      </>
    ),
  },
  {
    title: "Add the token",
    body: <>Copy <code>bot/.env.example</code> to <code>bot/.env</code> and paste the token in.</>,
    code: "TELEGRAM_BOT_TOKEN=123456789:AA...",
  },
  {
    title: "Start the bot",
    body: <>Needs Node.js 22+ and ffmpeg. Or use the included Dockerfile, which installs both.</>,
    code: "cd bot && npm install && npm run build && npm start",
  },
  {
    title: "Link your domain",
    body: (
      <>
        Needed for the sign-in button: send <code>/setdomain</code> to{" "}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
          @BotFather
        </a>
        , pick your bot, and enter the domain this site runs on (like{" "}
        <code>sendable.vercel.app</code>). Telegram only shows the button on that domain.
      </>
    ),
  },
  {
    title: "Connect this page",
    body: (
      <>
        Enter the bot's username and its server address here. To make them the default for every
        visitor, build the site with <code>VITE_TELEGRAM_BOT_USERNAME</code> and{" "}
        <code>VITE_BOT_API_URL</code>.
      </>
    ),
  },
];

function ConnectSection({
  username,
  isDefault,
  onConnect,
  onReset,
  apiUrl,
  isDefaultApi,
  onConnectApi,
  onResetApi,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [apiDraft, setApiDraft] = useState("");
  const [apiError, setApiError] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef(0);

  const link = botUrl(username, "");
  const openLink = botUrl(username);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = (message: string, key: string | null = null) => {
    setNote(message);
    setCopied(key);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setNote("");
      setCopied(null);
    }, 2400);
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash("Copied to clipboard", key);
    } catch {
      flash("Copying isn't available in this browser");
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = botUsernameError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const name = normalizeBotUsername(draft);
    onConnect(name);
    setError("");
    setDraft("");
    flash(`Connected. Every Telegram button on this page now opens @${name}.`);
  };

  const reset = () => {
    onReset();
    setError("");
    flash(`Back to the default bot, @${DEFAULT_BOT_USERNAME}.`);
  };

  const submitApi = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = apiUrlError(apiDraft);
    if (problem) {
      setApiError(problem);
      return;
    }
    const clean = apiDraft.trim();
    if (!onConnectApi(clean)) {
      setApiError("That address couldn't be saved. Check it and try again.");
      return;
    }
    setApiError("");
    setApiDraft("");
    flash(`Saved. Sign-ins on this page will be verified by ${apiHost(clean)}.`);
  };

  const resetApi = () => {
    onResetApi();
    setApiError("");
    setApiDraft("");
    flash(
      DEFAULT_BOT_API_URL
        ? `Back to the default server, ${apiHost(DEFAULT_BOT_API_URL)}.`
        : "Saved server address removed.",
    );
  };

  return (
    <section className="connect-section page-width reveal" id="connect" aria-labelledby="connect-title">
      <div className="section-heading">
        <span className="section-kicker">04 / CONNECT</span>
        <div>
          <h2 id="connect-title">Connect to the bot.</h2>
          <p>
            Open the chat in Telegram, scan it from your phone, point this page at a bot you run
            yourself — and sign in with Telegram to link your account.
          </p>
        </div>
      </div>

      <div className="connect-grid">
        <div className="connect-card">
          <div className="connect-current">
            <a className="connect-qr" href={openLink} target="_blank" rel="noreferrer">
              <QrCode value={link} label={`QR code that opens @${username} in Telegram`} />
            </a>
            <div className="connect-info">
              <span className="connect-label">CONNECTED BOT</span>
              <strong className="connect-handle">@{username}</strong>
              <span className={`connect-badge${isDefault ? "" : " is-custom"}`}>
                <span aria-hidden="true" />
                {isDefault ? "Default bot" : "Your bot, saved in this browser"}
              </span>
              <div className="connect-actions">
                <a className="button-primary" href={openLink} target="_blank" rel="noreferrer">
                  <TelegramIcon />
                  Open in Telegram
                </a>
                <button className="connect-copy" type="button" onClick={() => copy("link", link)}>
                  {copied === "link" ? <CheckIcon /> : <CopyIcon />}
                  {copied === "link" ? "Copied" : "Copy link"}
                </button>
              </div>
              <p className="connect-hint">
                On a computer? Point your phone's camera at the code to open the chat.{" "}
                <a href={botShareUrl(username)} target="_blank" rel="noreferrer">
                  Share the bot
                </a>
              </p>
            </div>
          </div>

          <form className="connect-form" onSubmit={submit} noValidate>
            <label htmlFor="bot-username">Use a different bot</label>
            <div className={`connect-input-row${error ? " has-error" : ""}`}>
              <span aria-hidden="true">@</span>
              <input
                id="bot-username"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="MyVideoBot"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError("");
                }}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "bot-username-error" : "bot-username-hint"}
              />
              <button type="submit">
                Connect <ArrowIcon />
              </button>
            </div>
            {error ? (
              <p className="form-error" id="bot-username-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="connect-hint" id="bot-username-hint">
                Paste a username or a t.me link. Only the public username is needed, never the token.
              </p>
            )}
            {!isDefault && (
              <button className="text-button connect-reset" type="button" onClick={reset}>
                Switch back to @{DEFAULT_BOT_USERNAME}
              </button>
            )}
          </form>

          <form className="connect-form" onSubmit={submitApi} noValidate>
            <label htmlFor="bot-api-url">Your bot's server address</label>
            <div className={`connect-input-row no-prefix${apiError ? " has-error" : ""}`}>
              <input
                id="bot-api-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="https://my-bot.example.com"
                value={apiDraft}
                onChange={(event) => {
                  setApiDraft(event.target.value);
                  if (apiError) setApiError("");
                }}
                aria-invalid={Boolean(apiError)}
                aria-describedby={apiError ? "bot-api-url-error" : "bot-api-url-hint"}
              />
              <button type="submit">
                Save <ArrowIcon />
              </button>
            </div>
            {apiError ? (
              <p className="form-error" id="bot-api-url-error" role="alert">
                {apiError}
              </p>
            ) : (
              <p className="connect-hint" id="bot-api-url-hint">
                {apiUrl ? (
                  <>
                    Sign-ins are verified by <strong>{apiHost(apiUrl)}</strong>. The bot answers at{" "}
                    <code>/telegram/login</code>; its token never reaches this page.
                  </>
                ) : (
                  <>
                    Needed for “Sign in with Telegram”: the address of the bot server from{" "}
                    <code>bot/</code>, which verifies each sign-in. Set{" "}
                    <code>VITE_BOT_API_URL</code> at build time to make it the default.
                  </>
                )}
              </p>
            )}
            {!isDefaultApi && (
              <button className="text-button connect-reset" type="button" onClick={resetApi}>
                {DEFAULT_BOT_API_URL
                  ? `Switch back to ${apiHost(DEFAULT_BOT_API_URL)}`
                  : "Remove the saved address"}
              </button>
            )}
          </form>

          <TelegramLogin
            botUsername={username}
            apiUrl={apiUrl}
            onSignedIn={(signed) =>
              flash(`Signed in as ${signed.firstName}. You're connected to @${username}.`)
            }
            onSignedOut={() => flash("Signed out on this page. Your Telegram account is untouched.")}
          />

          <p className="connect-status" role="status">
            {note}
          </p>
        </div>

        <div className="setup-steps">
          <span className="connect-label">RUN YOUR OWN BOT</span>
          <ol>
            {setupSteps.map((step, index) => (
              <li key={step.title}>
                <span className="setup-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  {step.code && (
                    <div className="setup-code">
                      <code>{step.code}</code>
                      <button
                        type="button"
                        onClick={() => copy(step.title, step.code)}
                        aria-label={`Copy: ${step.code}`}
                      >
                        {copied === step.title ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="setup-footnote">
            Full guide, hosting options, and limits: <code>bot/README.md</code>
          </p>
        </div>
      </div>
    </section>
  );
}

export default ConnectSection;
