import path from "path"
import { fileURLToPath } from "url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The bot server that converts videos (bot/src/web.ts). In development the site
// calls it on the same origin and these routes are proxied through, so nothing
// in the browser needs to know a second address.
const botApiTarget = `http://127.0.0.1:${process.env.BOT_API_PORT ?? 8080}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: botApiTarget,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
})
