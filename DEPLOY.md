# Sendable: Telegram bot + website

This repo has two parts:

| Part | Folder | Deploy to |
| --- | --- | --- |
| Website (UX blueprint, interactive demo, **Connect** page) | `/` | Vercel or any static host |
| Working Telegram bot (resizes videos with ffmpeg) | `bot/` | Any host that keeps a process running (VPS, Railway, Fly.io, Render, Docker) |

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

## Bot

```bash
cd bot
cp .env.example .env   # paste the token from @BotFather
npm install && npm run build && npm start
```

See [`bot/README.md`](bot/README.md) for Docker, webhook mode, limits and settings.
