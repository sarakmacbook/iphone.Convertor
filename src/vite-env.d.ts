/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default bot the site links to, without the @. Visitors can still pick another. */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
