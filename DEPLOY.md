# Sendable: Telegram bot + website

This repo has two parts, and two ways to run them:

| Part | Folder | Option A: all on Vercel | Option B: separate hosts |
| --- | --- | --- | --- |
| Website (working **Convert here** page, interactive demo, **Connect** page) | `/` | Vercel | Vercel or any static host |
| Telegram bot, sign-in check, website converter (ffmpeg) | `api/` + `serverless/` (Vercel), `bot/` (server) | Vercel Functions | Any host that keeps a process running (VPS, Railway, Fly.io, Render, Docker) |

**Option A** is one Vercel project with nothing else to run. **Option B** has no time limit per video,
lets people cancel a conversion, and supports the second MP4 bot.

## Option A: deploy everything to Vercel

### 1. Import the repo

In Vercel, choose **Add New… → Project** and import this repository. Keep the defaults: `vercel.json`
sets the build (`node scripts/vercel-build.mjs`), the output folder (`dist/`) and the functions.

### 2. Add a Blob store (for the website converter)

Vercel Functions only accept request bodies up to 4.5 MB, so the website uploads videos directly to
[Vercel Blob](https://vercel.com/docs/vercel-blob) instead.

1. In the project, open **Storage → Create Database → Blob**. Pick **Public** access.
2. Connect it to the project for all environments. This adds `BLOB_READ_WRITE_TOKEN` for you.

Skip this if you only want the Telegram bot; the converter section then explains what's missing.

### 3. Add your bot token (for the Telegram bot and sign-in)

Under **Settings → Environment Variables**, add `TELEGRAM_BOT_TOKEN` (from @BotFather, `/newbot`).
Skip it for a converter-only site.

### 4. Deploy

Deploy (or push to your production branch). On a production deployment the build also:

- looks up your bot's username, so the site's "Open in Telegram" buttons open your bot
  (set `VITE_TELEGRAM_BOT_USERNAME` to override), and
- points the bot's webhook at `https://<your production domain>/api/telegram/webhook`, protected by a
  secret derived from the token, and sets the command menu.

Then open **`https://<your domain>/api/telegram/setup`** to check it. It reports the bot, the webhook
Telegram is using, any delivery errors, and the archive channel status. If it says the webhook isn't
registered (for example, the build couldn't reach Telegram), open
`/api/telegram/setup?register=1`. It is safe to repeat, and it only ever registers the production
domain (or `PUBLIC_URL`). Preview deployments never take over the webhook.

> Telegram delivers updates either to one webhook or by polling, not both. If the same bot also runs
> on a server (Option B) in polling mode, stop it. Polling deletes the webhook, and the webhook stops
> polling.

### 5. Sign in with Telegram (optional)

Send `/setdomain` to @BotFather, pick your bot, and enter your Vercel domain. The site already sends
sign-ins to its own `/telegram/login`, so nothing else is needed.

### What runs where

| URL | What it does |
| --- | --- |
| `/` | The website (static, single file) |
| `POST /api/telegram/webhook` | Telegram updates. Answers at once, then converts in the background (up to `maxDuration`) |
| `GET /api/telegram/setup` | Webhook status; `?register=1` registers it |
| `POST /telegram/login` | Website sign-in check (same as the bot server's) |
| `GET /api/config` | Converter presets and limits (`"mode": "blob"`) |
| `POST /api/upload` | Short-lived Blob upload token for the browser |
| `POST /api/convert` | Converts an uploaded video and streams progress as JSON lines |
| `GET /api/cleanup` | Daily cron: deletes stored files older than `WEB_JOB_TTL_MINUTES` |
| `GET /health` | What this deployment has switched on |

ffmpeg comes from the `ffmpeg-static` package and is bundled only into the two functions that use it
(`api/convert.ts`, `api/telegram/webhook.ts`).

### Limits on Vercel, and how they differ from the server

| | Vercel (Hobby) | Bot server (`bot/`) |
| --- | --- | --- |
| Time per conversion | Up to 300 s per function, so about 4 minutes of work. A longer job is stopped and the person is told to pick a smaller size or a shorter clip | No limit |
| Telegram files | 20 MB in, 50 MB out (Telegram's Bot API limits) | Same, or 2000 MB with a self-hosted Bot API server |
| Website uploads | `WEB_MAX_UPLOAD_MB` (default 100), via Blob | `WEB_MAX_UPLOAD_MB` (default 200), direct |
| Cancel | Website: yes (closing the request stops ffmpeg). Telegram: no `/cancel`, because the job runs in another invocation | Yes |
| Chat memory | None. Each step reads the video from the message it replies to (see `serverless/telegram-bot.ts`); custom sizes are typed as a reply to the video | In memory |
| Converted website files | Public but unguessable Blob URLs, deleted after `WEB_JOB_TTL_MINUTES` by the daily cron (Hobby crons run once a day) and by periodic sweeps | Private, deleted after the TTL |
| MP4 converter bot (`MP4_BOT_TOKEN`) | Not included | Included |

On **Pro**, raise `maxDuration` for `api/convert.ts` and `api/telegram/webhook.ts` in `vercel.json` (up to
800) and set `FUNCTION_MAX_SECONDS` to the same number. Vercel's Hobby plan is for non-commercial use.

The upload route can't know who is uploading, so anyone who finds the site can upload a video (up to
`WEB_MAX_UPLOAD_MB`, video types only, into `sendable/uploads/`). Every upload is deleted right after
conversion or by the cleanup. `WEB_API_KEY` (with `VITE_BOT_API_KEY` on the site) adds a light
deterrent.

### Environment variables (Vercel)

All are optional except where noted. Names match the bot server's (`bot/.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Turns on the Telegram bot and sign-in |
| `BLOB_READ_WRITE_TOKEN` | — | Added by connecting a Blob store; turns on the website converter |
| `VITE_TELEGRAM_BOT_USERNAME` | looked up from the token | Bot the website opens |
| `PUBLIC_URL` | production domain | Address used for the webhook, e.g. a custom domain |
| `AUTO_REGISTER_WEBHOOK` | `true` | Set `false` to register only via `/api/telegram/setup?register=1` |
| `WEBHOOK_SECRET` | derived from the token | Secret Telegram must send with each update |
| `MAX_UPLOAD_MB` | `20` | Largest Telegram video accepted |
| `ALLOW_CUSTOM` / `MAX_DIMENSION` | `true` / `3840` | Custom dimensions |
| `TELEGRAM_ARCHIVE_CHAT_ID` / `TELEGRAM_ARCHIVE_ALLOW_PUBLIC` | — / `false` | Optional channel archive (see `bot/README.md`) |
| `WEB_CONVERT` | `true` | Turn the website converter off |
| `WEB_MAX_UPLOAD_MB` | `100` | Largest website upload |
| `WEB_JOB_TTL_MINUTES` | `60` | How long stored files are kept |
| `WEB_API_KEY` | — | Require an `X-Api-Key` on `/api/*` |
| `CORS_ORIGIN` | `*` | Origins allowed to call the API from another site |
| `LOGIN_MAX_AGE_SECONDS` / `LOGIN_GREETING` | `86400` / `true` | Sign-in freshness, and the greeting message |
| `FUNCTION_MAX_SECONDS` | `300` | Must match `maxDuration`; work stops a little before it |
| `CRON_SECRET` | — | If set, `/api/cleanup` only accepts Vercel's cron calls |

### Checking it locally

```bash
npm install
npm run typecheck     # site + functions
npm run test:api      # functions: bot flow, converter, sign-in, setup (needs ffmpeg for some tests)
npx vercel build      # optional: the exact bundles Vercel deploys, in .vercel/output
```

## Option B: website on Vercel, bot on a server

### Website

Build: `npm install && npm run build`
Deploy: `vercel` (or upload the `dist/` folder to any static host)
Output folder: `dist/`
Single-file build: yes (`dist/index.html` includes CSS + JS inlined)
Live URL: https://your-project.vercel.app

Choose which bot the site opens by default:

```bash
VITE_TELEGRAM_BOT_USERNAME=MyVideoBot npm run build
```

On Vercel, add `VITE_TELEGRAM_BOT_USERNAME` under Project → Settings → Environment Variables.
Visitors can still pick a different bot in the **Connect** section, or open the site with `?bot=MyVideoBot`.

#### "Convert here" on the site

The Convert section really converts: the browser uploads the video to the bot server, which runs
ffmpeg and returns the smaller MP4. It needs to know where that server is — the same address the
sign-in uses:

```bash
VITE_BOT_API_URL=https://your-bot.example.com npm run build
```

Visitors can also enter it per browser in the **Connect** section. Running locally, the Vite dev
server proxies `/api` to `http://127.0.0.1:8080`, so start the bot (`cd bot && npm run dev`, optionally
with `WEB_ONLY=true` to skip Telegram) and then `npm run dev`. Endpoint reference and limits:
[`bot/README.md`](bot/README.md) → "Convert from the website".

#### "Sign in with Telegram" on the site

The Connect section includes Telegram's official Login Widget. To make it work for your bot:

1. In Telegram, send `/setdomain` to @BotFather, pick your bot, and enter the domain your site
   runs on (e.g. `your-project.vercel.app`). Telegram only shows the button on that domain.
2. Run the bot server (below) somewhere with a public HTTPS address, and tell the site where it is:

```bash
VITE_TELEGRAM_BOT_USERNAME=MyVideoBot VITE_BOT_API_URL=https://your-bot.example.com npm run build
```

   Visitors can also enter the server address per browser in the **Connect** section.
3. Optional: `CORS_ORIGIN=https://your-project.vercel.app` on the bot to lock the endpoint to your
   site (default `*` also works), and `VITE_TELEGRAM_REQUEST_ACCESS=read` on the site to skip the
   "bot may message you" permission.

The site POSTs the widget payload to `VITE_BOT_API_URL + /telegram/login`; the bot server verifies
it with the bot token (which never leaves the server) and can greet the user in Telegram. Details:
[`bot/README.md`](bot/README.md) → "Sign-in on the website".

### Bot

```bash
cd bot
cp .env.example .env   # paste the token from @BotFather
npm install && npm run build && npm start
```

Optional channel-backed archive: create a private Telegram channel, add the bot as an admin allowed to
post, and set `TELEGRAM_ARCHIVE_CHAT_ID=-100...` in the bot's environment. The bot saves only
successfully reduced outputs there and tells users before conversion. Channel copies remain until an
admin deletes them; a channel is a media archive, not a relational database. Public archives are
blocked unless `TELEGRAM_ARCHIVE_ALLOW_PUBLIC=true` is explicitly set.

The bot server also hosts the website's conversion API (`GET /api/config`, `POST /api/convert`,
`GET /api/jobs/:id`, `GET /api/jobs/:id/download`), `POST /telegram/login` (website sign-in
verification) and `GET /health`. Set `WEB_ONLY=true` to run those without a Telegram bot.
See [`bot/README.md`](bot/README.md) for Docker, webhook mode, sign-in, limits and settings.
