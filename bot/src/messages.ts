/**
 * Everything the bot says, matching the message guide on the Sendable website.
 */

const welcomeText = (limitMB: number) =>
  `Hi, I'm Sendable. Send an iPhone video and I'll make a smaller copy for you to review. ` +
  `Videos up to ${limitMB} MB work best. Making a file smaller can soften fine detail, and your original is never changed.\n\n` +
  `Tip: send it as a file (📎 → File) to keep the full quality of your original.`;

export const messages = {
  welcome: welcomeText,

  /** Shown when someone opens the bot from the website after signing in there (start payload "web-<id>"). */
  welcomeFromSite: (limitMB: number) =>
    `Connected! You signed in on the Sendable website, and this chat is where your resized videos arrive.\n\n` +
    welcomeText(limitMB),

  /** Sent by the login endpoint right after a website sign-in verifies. */
  siteLoginGreeting: (firstName: string) =>
    `Hi ${firstName}! You just signed in on the Sendable website. ✅\n\n` +
    `You're connected: send a video here whenever you want a smaller copy to preview and download.`,

  help: (limitMB: number, allowCustom: boolean) =>
    `I make a smaller copy of a video you send.\n\n` +
    `1. Send a video (MOV or MP4, up to ${limitMB} MB).\n` +
    `2. Pick a size: Recommended (720p), Smaller (480p), Keep dimensions` +
    `${allowCustom ? ", or your own width and height" : ""}.\n` +
    `3. Preview it and check the real file size before downloading.\n\n` +
    `Commands:\n/help: show this message\n/cancel: stop the current resize\n\n` +
    `Your original is never changed.`,

  gotIt: (name: string, size: string, length?: string) =>
    `Got it: ${name} (${size}${length ? `, ${length}` : ""}). What matters most to you? ` +
    `Pick a size below. You can review the result before downloading.`,

  tooLarge: (name: string, size: string, limitMB: number) =>
    `${name} is ${size}, which is over this bot's current ${limitMB} MB limit. ` +
    `Try a shorter video, or one saved at a smaller size. Nothing was saved.`,

  notSupported: "I can't read this video. Please send a MOV or MP4 file, or tap /help.",

  askCustom:
    "Enter a width and height in pixels, like 720 x 1280. I'll fit the video inside those dimensions so it keeps its shape.",

  customFormat: "Enter a width and height in pixels, like 720 x 1280.",

  customTooLarge: (max: number) =>
    `Those dimensions are above this bot's ${max} pixel limit. Choose a smaller width and height.`,

  confirm: (label: string) =>
    `I'll make a copy using ${label}. The final size depends on the video, so you'll see the real size before you download. ` +
    `Your original stays unchanged. Create a preview first?`,

  queued: "You're in line. I'll start your preview as soon as possible.",

  processing: (percent?: number) =>
    `Preparing your preview${percent !== undefined ? ` (${percent}%)` : ""}…\n` +
    `Longer videos take longer. You can keep chatting in the meantime.`,

  previewReady: (original: string, resized: string, label: string, smaller: boolean) =>
    `Your preview is ready.\n\n` +
    `${label}\nOriginal: ${original}\nNew copy: ${resized}\n\n` +
    (smaller
      ? "Watch it and check the size before downloading. Some fine detail may look softer."
      : "This setting didn't make the file smaller. Try a smaller size instead."),

  saveHint:
    "Here's the file. Tap the download icon on it to save it, or Share to send it. Your original is still unchanged.",

  pickAgain: "No problem. Pick a different size below.",
  sendAnother: "Sure. Send me another video whenever you're ready.",
  cancelled: "Cancelled. Your original is unchanged. Pick a size when you're ready.",
  nothingToCancel: "There's nothing to cancel right now. Send a video to get started.",
  sendVideoFirst: "Please send a video first. Tap /help to see how it works.",
  expired: "That button has expired. Please send the video again.",
  busy: "I'm still working on your last preview. Wait for it to finish, or tap /cancel.",
  idleText: "Send me a video to get started, or tap /help.",

  uploadFailed: "The upload didn't finish. Check your connection and send the video again.",
  previewFailed: "I couldn't make a preview this time. Your original is unchanged. Please try once more.",
  outputTooLarge: (size: string, limitMB: number) =>
    `The new copy is ${size}, which is over the ${limitMB} MB Telegram lets me send back. Try a smaller size.`,
} as const;

export const buttons = {
  differentVideo: "Send a different video",
  createPreview: "Create preview",
  changeSize: "Change size",
  cancel: "Cancel",
  download: "Download this version",
  tryAnother: "Try another size",
  tryAgain: "Try again",
  custom: "Custom dimensions",
} as const;
