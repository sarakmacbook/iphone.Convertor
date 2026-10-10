# Sendable: Telegram bot + website

This repo has two parts:

| Part | Folder | Deploy to |
| --- | --- | --- |
| Website (working **Convert here** page, interactive demo, **Connect** page) | `/` | Vercel or any static host |
| Working Telegram bot + conversion API (ffmpeg) | `bot/` | Any host that keeps a process running (VPS, Railway, Fly.io, Render, Docker) |

## Website

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

### "Convert here" on the site

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

### "Sign in with Telegram" on the site

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

## Bot

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
