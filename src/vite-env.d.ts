/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default bot the site links to, without the @. Visitors can still pick another. */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
  /**
   * Default bot server for sign-in and the converter, or "same-origin" when they
   * run on this site (the Vercel deployment sets that automatically).
   */
  readonly VITE_BOT_API_URL?: string;
  /** Optional WEB_API_KEY for the converter; public in the bundle, so an abuse deterrent only. */
  readonly VITE_BOT_API_KEY?: string;
  /**
   * "write" (default) lets your bot message people after they sign in on the site.
   * Set to anything else to ask for the profile only.
   */
  readonly VITE_TELEGRAM_REQUEST_ACCESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
