# Sendable bot

The working Telegram bot behind the Sendable website. Someone sends an iPhone video. They choose
**Recommended (720p)**, **Smaller (480p)**, **Keep dimensions** or **Custom dimensions**. They get a
preview with the real before-and-after file size, and can then download it as a file. The original
video is never changed.

It's built with [grammY](https://grammy.dev) and uses ffmpeg (H.264 + AAC MP4, `+faststart`) to make
the copy. Videos are never stretched or upscaled, iPhone rotation is respected, and metadata such as
GPS location is removed from the copy.

## 1. Create your bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a display name, then a username that ends in `bot` (for example `MyVideoBot`).
3. BotFather replies with a **token** like `123456789:AA…`. Treat it like a password and never commit it.

## 2. Run it

You need Node.js 22+ and ffmpeg (`brew install ffmpeg`, `sudo apt install ffmpeg`, or
`winget install ffmpeg`).

```bash
cd bot
cp .env.example .env        # then paste your token into TELEGRAM_BOT_TOKEN
npm install
npm run build
npm start
```

You should see:

```
Connected to Telegram as @MyVideoBot (https://t.me/MyVideoBot)
Polling mode: listening for messages. Press Ctrl+C to stop.
```

Open the link and send it a video. For development, `npm run dev` restarts the bot when you change a file.

### With Docker

```bash
docker build -t sendable-bot bot
docker run --env-file bot/.env -p 8080:8080 sendable-bot
```

The image installs ffmpeg for you.

## 3. Connect the website

On the website, open the **Connect** section and enter your bot's username. Every "Open in
Telegram" button then opens your bot. The choice is saved in that browser. You can also:

- link to the site with `?bot=MyVideoBot` to preselect a bot, or
- make it the default for everyone by building the site with
  `VITE_TELEGRAM_BOT_USERNAME=MyVideoBot npm run build` (or by setting it in Vercel's environment variables).

The website only ever needs the public username. The token stays on the bot server.

## 4. Sign-in on the website (Telegram Login Widget)

The Connect section also has a **"Sign in with Telegram"** button — Telegram's official
[Login Widget](https://core.telegram.org/widgets/login) — so visitors can link their Telegram
account to the site with one tap. It works like this:

1. The visitor taps the button and confirms in Telegram. The widget hands the browser a signed
   payload: `id`, `first_name`, `last_name`, `username`, `photo_url`, `auth_date` and a `hash`.
2. The site POSTs that payload to **`POST /telegram/login`** on this bot server.
3. The server proves it really came from Telegram (HMAC-SHA-256 of the data-check-string, keyed
   with `SHA256(token)` — the official algorithm), rejects stale payloads, and answers
   `{ok: true, user: {...}}`. With `LOGIN_GREETING=true` (default) the bot also sends the visitor
   a short "you signed in on the website" message in Telegram.
4. The site shows a signed-in card and links back into the chat with `?start=web-<id>`, which this
   bot answers with a "Connected!" welcome.

The token never leaves this server, and the site never trusts the payload until the server
verifies it.

### One-time setup

1. **Link the site's domain to your bot.** In Telegram, send `/setdomain` to
   [@BotFather](https://t.me/BotFather), pick your bot, and enter the domain the site runs on
   (for example `sendable.vercel.app`). Telegram only shows the login button on that exact
   domain — without this step the widget refuses to work.
2. **Tell the site where this server is.** Enter the address in the Connect section's
   "Your bot's server address" field (saved per browser), or build the site with
   `VITE_BOT_API_URL=https://your-bot.example.com npm run build`. The site calls
   `VITE_BOT_API_URL + /telegram/login`.
3. **Allow the site's origin (recommended).** `CORS_ORIGIN` defaults to `*`, which already works.
   To tighten it, list your origins: `CORS_ORIGIN=https://sendable.vercel.app,https://staging.example`.

By default the widget asks for "write" access (`VITE_TELEGRAM_REQUEST_ACCESS=write` on the site),
which is what lets the bot send the greeting to people who haven't started a chat yet. Build the
site with `VITE_TELEGRAM_REQUEST_ACCESS=read` (or any non-`write` value) to ask for the profile
only — the greeting then works only for people who have pressed Start on the bot.

> Local note: Telegram compares the page's domain with the one you set via `/setdomain`, so the
> widget only works on that domain. Test it on your deployed site (or a tunnel/preview domain you
> registered with BotFather), not on `localhost`. Everything else — including
> `POST /telegram/login` — works locally.

## Polling or webhook?

- **Polling** (default, when `WEBHOOK_URL` is empty): the bot asks Telegram for new messages. It works
  anywhere, including a laptop, a VPS, Railway, Fly.io, or a Render background worker. No public URL is needed.
- **Webhook**: set `WEBHOOK_URL=https://your-bot.example.com` (and ideally `WEBHOOK_SECRET`).
  Telegram then POSTs updates to `WEBHOOK_URL + WEBHOOK_PATH` (default `/telegram/webhook`). Use this
  on hosts that sleep when idle or only run web services.

Either way, `GET /health` on `PORT` returns `{"ok":true,"bot":"MyVideoBot",...}` for your host's health checks, and `POST /telegram/login` on the same port verifies website sign-ins (below).

The bot isn't a good fit for Vercel serverless functions. Converting a video takes longer than
those functions are allowed to run, and the bot keeps each chat's state in memory. Deploy the website
to Vercel and run the bot on a host that keeps a process running.

## Settings

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | (required) | Token from @BotFather |
| `MAX_UPLOAD_MB` | `20` | Largest video accepted |
| `ALLOW_CUSTOM` | `true` | Show the "Custom dimensions" option |
| `MAX_DIMENSION` | `3840` | Largest custom width or height, in pixels |
| `MAX_CONCURRENT_JOBS` | `2` | Videos converted at the same time; others wait in line |
| `FFMPEG_PATH` | auto | ffmpeg binary (ffmpeg-static if it installed, otherwise `ffmpeg` on PATH) |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Point at a self-hosted Bot API server |
| `WEBHOOK_URL` / `WEBHOOK_PATH` / `WEBHOOK_SECRET` | (empty) | Turn on webhook mode |
| `PORT` | `8080` | Health check and webhook port |
| `CORS_ORIGIN` | `*` | Website origins allowed to call `POST /telegram/login` (`*`, or a comma-separated list like `https://a.com,https://b.com`) |
| `LOGIN_MAX_AGE_SECONDS` | `86400` | How long a website sign-in payload stays acceptable |
| `LOGIN_GREETING` | `true` | Message the user in Telegram after a verified website sign-in |

### About the 20 MB limit

Telegram's hosted Bot API only lets bots **download files up to 20 MB** and **send files up to
50 MB**. Most iPhone videos longer than about 10 seconds are bigger than that. To accept large videos
(up to 2000 MB), run the official [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server
in `--local` mode next to the bot. Then set:

```
TELEGRAM_API_ROOT=http://localhost:8081
MAX_UPLOAD_MB=2000
```

If you set `MAX_UPLOAD_MB` higher than the API allows, the bot refuses to start and tells you why.
That's better than failing on someone's upload.

## Commands

- `/start`: welcome message and the current size limit
- `/help`: how it works, the limits, and the commands
- `/cancel`: stop the current conversion (the original is untouched)

## Tests

```bash
npm test
```

These cover the size parsing and run real conversions with ffmpeg. They check the output dimensions
for portrait, landscape, custom and no-upscale cases, and that cancelling works.

## Privacy

Videos are downloaded to a temporary folder only while they're being converted. The finished preview
is kept so the "Download this version" button can send it. It's deleted when the person sends
another video, picks a new size, or after 6 hours of inactivity. Nothing is written anywhere else.
