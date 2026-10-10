/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default bot the site links to, without the @. Visitors can still pick another. */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
  /** Default bot server that verifies Telegram sign-ins (its /telegram/login endpoint). */
  readonly VITE_BOT_API_URL?: string;
  /**
   * "write" (default) lets your bot message people after they sign in on the site.
   * Set to anything else to ask for the profile only.
   */
  readonly VITE_TELEGRAM_REQUEST_ACCESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
