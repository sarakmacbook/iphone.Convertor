import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import ConnectSection from "./ConnectSection";
import { ArrowIcon, CheckIcon, CopyIcon, TelegramIcon } from "./icons";
import { botShareUrl, botUrl, useBotApiUrl, useBotUsername } from "./telegram";

type Stage =
  | "welcome"
  | "uploading"
  | "choose"
  | "custom"
  | "confirm"
  | "processing"
  | "preview"
  | "done"
  | "tooLarge";

type Role = "bot" | "user";

type ChatMessage = {
  id: number;
  role: Role;
  text: string;
  time: string;
  kind?: "file";
  meta?: string;
};

type Sample = {
  key: string;
  name: string;
  sizeMB: number;
  duration: string;
};

type SizeOption = {
  key: string;
  label: string;
  detail: string;
  pixels?: number;
};

const SOURCE_PIXELS = 1920 * 1080;
const MAX_DIMENSION = 3840;

const samples: Sample[] = [
  { key: "walk", name: "Weekend_walk.mov", sizeMB: 86, duration: "0:47" },
  { key: "concert", name: "Concert_clip.mov", sizeMB: 240, duration: "2:12" },
];

const presets: SizeOption[] = [
  {
    key: "balanced",
    label: "Recommended (720p)",
    detail: "A good place to start for everyday sharing.",
    pixels: 1280 * 720,
  },
  {
    key: "smaller",
    label: "Smaller (480p)",
    detail: "More reduction; fine details may look softer.",
    pixels: 854 * 480,
  },
  {
    key: "keep",
    label: "Keep dimensions",
    detail: "Try to reduce the file without changing picture size.",
    pixels: SOURCE_PIXELS,
  },
];

const customPreset: SizeOption = {
  key: "custom",
  label: "Custom dimensions",
  detail: "Choose the width and height yourself.",
};

const flowSteps = [
  {
    number: "01",
    title: "Send a video",
    copy: "Accept the upload, confirm what arrived, and show the current size limit before anyone sends a file.",
  },
  {
    number: "02",
    title: "Choose a size",
    copy: "Offer a recommended setting, a smaller option, the original dimensions, and an optional custom size.",
  },
  {
    number: "03",
    title: "Review, then save",
    copy: "Show the resized video and its real file size. Let people download it, try another size, or send a different video.",
  },
];

const messageRows = [
  {
    label: "WELCOME",
    title: "Set expectations up front",
    copy: "Hi, I'm Sendable. Send an iPhone video and I'll make a smaller copy for you to review. Videos up to {limit} work best. Making a file smaller can soften fine detail, and your original is never changed.",
  },
  {
    label: "AFTER UPLOAD",
    title: "Offer familiar choices",
    copy: "Got it: {filename} ({size}, {length}). What matters most to you? Pick a size below. You can review the result before downloading.",
    options: [
      ["Recommended (720p)", "A good place to start for everyday sharing."],
      ["Smaller (480p)", "More reduction; fine details may look softer."],
      ["Keep dimensions", "Try to reduce the file without changing picture size."],
      ["Custom dimensions", "Enter a width and height in pixels."],
    ],
  },
  {
    label: "CUSTOM SIZE",
    title: "Keep the video from stretching",
    copy: "Enter a width and height in pixels, like 720 x 1280. I'll fit the video inside those dimensions so it keeps its shape.",
  },
  {
    label: "PREVIEW",
    title: "Let the user decide",
    copy: "Your preview is ready. Watch it and check the file size before downloading. Some fine detail may look softer. Download this version, try another size, or send a different video.",
  },
  {
    label: "SAVE",
    title: "Make the final step obvious",
    copy: "Tap the download icon on the video in this chat to save it, or Share to send it. Your original is still unchanged.",
  },
  {
    label: "HELP",
    title: "One place to look things up",
    copy: "I make a smaller copy of a video you send. Send a video, pick a size, then preview it before downloading. Videos up to {limit}, MOV or MP4 only. Commands: /help, /cancel.",
  },
];

const recoveryRows = [
  {
    label: "File is too large",
    copy: "This video is over the current {limit} limit. Try a shorter video, or one saved at a smaller size. Nothing was saved.",
  },
  {
    label: "File not supported",
    copy: "I can't read this video. Please send a MOV or MP4 file, or tap Help.",
  },
  {
    label: "Upload stopped",
    copy: "The upload didn't finish. Check your connection and send the video again.",
  },
  {
    label: "Preview failed",
    copy: "I couldn't make a preview this time. Your original is unchanged. Please try once more.",
  },
  {
    label: "Custom size needs fixing",
    copy: "Enter a width and height in pixels, like 720 and 1280.",
  },
  {
    label: "Custom size is too large",
    copy: "Those dimensions are above this bot's {dimension} pixel limit. Choose a smaller width and height.",
  },
];

function formatTime() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMB(value: number) {
  return value >= 10 ? `${Math.round(value)} MB` : `${value.toFixed(1)} MB`;
}

function estimateSizeMB(originalMB: number, targetPixels: number) {
  const ratio = Math.max(0.04, targetPixels / SOURCE_PIXELS);
  return Math.max(0.5, originalMB * Math.pow(ratio, 0.85));
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" fill="none">
      <rect x="3" y="5" width="26" height="22" rx="7" fill="currentColor" />
      <path d="m13 10 9 6-9 6V10Z" fill="#fffaf4" />
      <path
        d="M7 2v4M15 2v3M23 2v4M7 26v4M15 27v3M23 26v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="3" y="5" width="13" height="14" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="m16 10 5-3v10l-5-3v-4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m8 9 4 3-4 3V9Z" fill="currentColor" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M16 8a6.2 6.2 0 0 0-10.8-2L3.5 8M4 4v4h4M4 12a6.2 6.2 0 0 0 10.8 2l1.7-2M16 16v-4h-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M10 3.5v8m0 0 3-3m-3 3-3-3M4 13.5v2A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      {open ? (
        <path
          d="M5 5 15 15M15 5 5 15"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M3.5 6h13M3.5 10h13M3.5 14h13"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function Landscape({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#bcd9d4" />
          <stop offset="1" stopColor="#e9e0c4" />
        </linearGradient>
        <linearGradient id={`${id}-water`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6f9c90" />
          <stop offset="1" stopColor="#abc7ae" />
        </linearGradient>
      </defs>
      <rect width="360" height="148" fill={`url(#${id}-sky)`} />
      <circle cx="276" cy="34" r="18" fill="#f7da94" />
      <path d="M0 91 65 49l44 39 47-47 76 61 51-45 77 47v44H0V91Z" fill="#839c81" />
      <path d="m0 109 77-40 57 35 55-31 77 44 48-25 46 23v33H0v-39Z" fill="#a4ab83" />
      <path d="M0 107c53-12 94 1 144 10 72 13 119-9 216-4v35H0v-41Z" fill={`url(#${id}-water)`} />
      <path
        d="M0 124c59-8 91 3 150 11 65 9 112-10 210-4"
        fill="none"
        stroke="#d8dfc6"
        strokeWidth="2"
        opacity=".75"
      />
    </>
  );
}

function FrameArtwork({
  id,
  label,
  soften = false,
}: {
  id: string;
  label: string;
  soften?: boolean;
}) {
  return (
    <figure className={`frame${soften ? " frame-soft" : ""}`}>
      <svg viewBox="0 0 360 148" role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
        {soften && (
          <defs>
            <filter id={`${id}-soften`} x="-6%" y="-6%" width="112%" height="112%">
              <feGaussianBlur stdDeviation="1.35" />
            </filter>
          </defs>
        )}
        <g filter={soften ? `url(#${id}-soften)` : undefined}>
          <Landscape id={id} />
        </g>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function SizeEstimator() {
  const [originalMB, setOriginalMB] = useState(86);
  const [target, setTarget] = useState<"keep" | "720" | "480">("720");
  const pixels =
    target === "keep" ? SOURCE_PIXELS : target === "720" ? 1280 * 720 : 854 * 480;
  const estimate = estimateSizeMB(originalMB, pixels);
  const widest = Math.max(originalMB, estimate);

  return (
    <div className="estimator">
      <span className="column-label">ROUGH SIZE GUIDE</span>
      <p className="estimator-intro">
        A rough idea only. Real results vary with motion, detail, and frame rate.
      </p>
      <div className="estimator-controls">
        <label className="estimator-slider">
          <span className="estimator-field-head">
            Video size <strong>{originalMB} MB</strong>
          </span>
          <input
            type="range"
            min="10"
            max="300"
            step="2"
            value={originalMB}
            onChange={(event) => setOriginalMB(Number(event.target.value))}
            aria-label="Original video size in megabytes"
          />
        </label>
        <div className="segmented" role="group" aria-label="Target size">
          {(
            [
              ["keep", "Keep size"],
              ["720", "720p"],
              ["480", "480p"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={target === key ? "is-active" : ""}
              aria-pressed={target === key}
              onClick={() => setTarget(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="estimator-bars">
        <div className="est-row">
          <span>Original</span>
          <span className="est-track">
            <span className="est-fill est-original" style={{ width: `${(originalMB / widest) * 100}%` }} />
          </span>
          <strong>{originalMB} MB</strong>
        </div>
        <div className="est-row">
          <span>Resized</span>
          <span className="est-track">
            <span className="est-fill est-new" style={{ width: `${(estimate / widest) * 100}%` }} />
          </span>
          <strong>~{formatMB(estimate)}</strong>
        </div>
      </div>
      <p className="estimator-note">
        The bot only ever shows the real size after it finishes a preview.
      </p>
    </div>
  );
}

function App() {
  const bot = useBotUsername();
  const api = useBotApiUrl();
  const telegramUrl = botUrl(bot.username);
  const shareUrl = botShareUrl(bot.username);
  const [stage, setStage] = useState<Stage>("welcome");
  const [maxUploadMB, setMaxUploadMB] = useState(100);
  const [allowCustom, setAllowCustom] = useState(true);
  const [activeSample, setActiveSample] = useState<Sample | null>(null);
  const [job, setJob] = useState<{ label: string; pixels: number } | null>(null);
  const [customWidth, setCustomWidth] = useState("720");
  const [customHeight, setCustomHeight] = useState("1280");
  const [customError, setCustomError] = useState("");
  const [progress, setProgress] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("demo");
  const messageId = useRef(2);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef(0);

  const welcomeText = `Hi, I'm Sendable. Send an iPhone video and I'll make a smaller copy for you to review. Videos up to ${maxUploadMB} MB work best. Making a file smaller can soften fine detail, and your original is never changed.`;

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: 1, role: "bot", text: welcomeText, time: formatTime() },
  ]);

  const addMessage = useCallback(
    (role: Role, text: string, kind?: "file", meta?: string) => {
      const id = messageId.current++;
      setMessages((current) => [
        ...current,
        { id, role, text, time: formatTime(), kind, meta },
      ]);
    },
    [],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stage]);

  useEffect(() => {
    setMessages((current) => {
      if (current.length !== 1 || current[0].id !== 1) return current;
      return [{ ...current[0], text: welcomeText }];
    });
  }, [welcomeText]);

  const finishUpload = useCallback(
    (sample: Sample) => {
      addMessage(
        "bot",
        `Got it: ${sample.name} (${sample.sizeMB} MB, ${sample.duration}). What matters most to you? Pick a size below. You can review the result before downloading.`,
      );
      setStage("choose");
    },
    [addMessage],
  );

  const finishPreview = useCallback(() => {
    addMessage(
      "bot",
      "Your preview is ready. Watch it and check the file size before downloading. Some fine detail may look softer. Your original stays unchanged.",
    );
    setStage("preview");
  }, [addMessage]);

  useEffect(() => {
    if (stage !== "uploading" && stage !== "processing") return;

    const duration = stage === "uploading" ? 1300 : 2200;
    const started = performance.now();
    let frame = 0;

    const step = () => {
      const elapsed = performance.now() - started;
      const percent = Math.min(100, (elapsed / duration) * 100);
      setProgress(percent);

      if (percent < 100) {
        frame = requestAnimationFrame(step);
        return;
      }
      if (stage === "uploading" && activeSample) finishUpload(activeSample);
      if (stage === "processing") finishPreview();
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [stage, activeSample, finishUpload, finishPreview]);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (!("IntersectionObserver" in window)) {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const ids = ["demo", "flow", "messages", "guardrails", "connect"];
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      { rootMargin: "-28% 0px -55% 0px", threshold: [0.1, 0.35, 0.6] },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const closeNav = () => setNavOpen(false);

  const sendSample = (sample: Sample) => {
    addMessage("user", sample.name, "file", `${sample.sizeMB} MB · ${sample.duration}`);

    if (sample.sizeMB > maxUploadMB) {
      addMessage(
        "bot",
        `${sample.name} is ${sample.sizeMB} MB, which is over this bot's current ${maxUploadMB} MB limit. Try a shorter video, or one saved at a smaller size. Nothing was saved.`,
      );
      setStage("tooLarge");
      return;
    }

    setActiveSample(sample);
    setJob(null);
    setProgress(0);
    setStage("uploading");
  };

  const chooseSize = (label: string, pixels: number) => {
    setJob({ label, pixels });
    addMessage("user", label);
    addMessage(
      "bot",
      `I'll make a copy using ${label}. The final size depends on the video, so you'll see the real size before you download. Your original stays unchanged. Create a preview first?`,
    );
    setStage("confirm");
  };

  const selectOption = (option: SizeOption) => {
    if (option.key === "custom") {
      addMessage("user", option.label);
      addMessage(
        "bot",
        "Enter a width and height in pixels, like 720 x 1280. I'll fit the video inside those dimensions so it keeps its shape.",
      );
      setCustomError("");
      setStage("custom");
      return;
    }
    if (option.pixels) chooseSize(option.label, option.pixels);
  };

  const submitCustomSize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const width = Number(customWidth);
    const height = Number(customHeight);

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      setCustomError("Enter a whole number for both sides, like 720 and 1280.");
      return;
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      setCustomError(
        `Those dimensions are above this bot's ${MAX_DIMENSION} pixel limit. Choose a smaller width and height.`,
      );
      return;
    }

    setCustomError("");
    chooseSize(`Custom: ${width} x ${height} px`, width * height);
  };

  const createPreview = () => {
    addMessage("user", "Create preview");
    setProgress(0);
    setStage("processing");
  };

  const changeSize = () => {
    addMessage("user", "Change size");
    addMessage("bot", "No problem. Pick a different size below.");
    setStage("choose");
  };

  const cancelPreview = () => {
    addMessage("user", "/cancel");
    addMessage("bot", "Cancelled. Your original is unchanged. Pick a size when you're ready.");
    setStage("choose");
  };

  const sendAnotherVideo = () => {
    addMessage("user", "Send a different video");
    addMessage("bot", "Sure. Pick one of the sample videos below.");
    setStage("welcome");
  };

  const sendHelp = () => {
    if (stage === "uploading" || stage === "processing") return;
    addMessage("user", "/help");
    addMessage(
      "bot",
      `I make a smaller copy of a video you send. Send a video, pick a size, then preview it before downloading. Videos up to ${maxUploadMB} MB, MOV or MP4 only. Commands: /help, /cancel. Your original is never changed.`,
    );
  };

  const finishDemo = () => {
    addMessage("user", "Download this version");
    addMessage(
      "bot",
      "In Telegram, tap the download icon on the video to save it, or Share to send it. This is a design demo, so no file is created.",
    );
    setStage("done");
  };

  const resetDemo = () => {
    messageId.current = 2;
    setMessages([{ id: 1, role: "bot", text: welcomeText, time: formatTime() }]);
    setActiveSample(null);
    setJob(null);
    setCustomError("");
    setProgress(0);
    setStage("welcome");
  };

  const copyMessage = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setCopyNote("Message copied");
    } catch {
      setCopyNote("Copying is not available in this browser");
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopiedKey(null);
      setCopyNote("");
    }, 2000);
  };

  const sizeOptions: SizeOption[] = allowCustom
    ? [...presets, customPreset]
    : presets;
  const smallerSample = samples.find((sample) => sample.sizeMB <= maxUploadMB);
  const estimatedMB =
    job && activeSample ? estimateSizeMB(activeSample.sizeMB, job.pixels) : 0;
  const busy = stage === "uploading" || stage === "processing";

  const navLinks = [
    { href: "#demo", id: "demo", label: "Try it" },
    { href: "#flow", id: "flow", label: "The flow" },
    { href: "#messages", id: "messages", label: "Bot messages" },
    { href: "#guardrails", id: "guardrails", label: "Limits & help" },
    { href: "#connect", id: "connect", label: "Connect" },
  ];

  return (
    <div className="site-shell" id="top">
      <a className="skip-link" href="#demo">
        Skip to the conversation
      </a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Sendable bot blueprint home" onClick={closeNav}>
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span>sendable</span>
        </a>
        <span className="topbar-context">TELEGRAM BOT / UX BLUEPRINT</span>
        <nav className={`top-nav${navOpen ? " is-open" : ""}`} aria-label="Main navigation">
          {navLinks.map((link) => (
            <a
              key={link.id}
              href={link.href}
              className={activeSection === link.id ? "is-current" : ""}
              aria-current={activeSection === link.id ? "location" : undefined}
              onClick={closeNav}
            >
              {link.label}
            </a>
          ))}
          <a className="nav-telegram" href={telegramUrl} target="_blank" rel="noreferrer" onClick={closeNav}>
            <TelegramIcon />
            Open in Telegram
          </a>
        </nav>
        <a className="top-try" href="#demo" onClick={closeNav}>
          Try the flow <ArrowIcon diagonal />
        </a>
        <button
          className="nav-toggle"
          type="button"
          aria-expanded={navOpen}
          aria-controls="mobile-nav-panel"
          onClick={() => setNavOpen((open) => !open)}
        >
          <MenuIcon open={navOpen} />
          <span className="sr-only">{navOpen ? "Close menu" : "Open menu"}</span>
        </button>
      </header>
      {navOpen && (
        <div id="mobile-nav-panel" className="mobile-nav" role="dialog" aria-label="Site sections">
          {navLinks.map((link) => (
            <a key={link.id} href={link.href} onClick={closeNav}>
              {link.label}
            </a>
          ))}
          <a href={telegramUrl} target="_blank" rel="noreferrer" onClick={closeNav}>
            Open in Telegram
          </a>
        </div>
      )}
      <nav className="section-jump" aria-label="On this page">
        {navLinks.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className={activeSection === link.id ? "is-current" : ""}
            title={link.label}
            aria-label={link.label}
            aria-current={activeSection === link.id ? "location" : undefined}
          >
            <span />
          </a>
        ))}
      </nav>

      <main>
        <section className="hero page-width" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="eyebrow-mark" /> BOT EXPERIENCE / 01
            </div>
            <h1 id="hero-title">
              Sendable<span>.</span>
            </h1>
            <p className="hero-tagline">Smaller iPhone videos, minus the guesswork.</p>
            <p className="hero-description">
              A Telegram bot concept that walks people from upload to a clear preview,
              one simple choice at a time. No editing vocabulary required.
            </p>
            <div className="hero-actions">
              <a className="button-primary" href={telegramUrl} target="_blank" rel="noreferrer">
                <TelegramIcon />
                Open in Telegram
              </a>
              <a className="button-secondary" href="#demo">
                Try the flow here <ArrowIcon />
              </a>
            </div>
            <p className="hero-actions-note">
              Opens <strong>@{bot.username}</strong> in Telegram. Running your own bot?{" "}
              <a href="#connect">Connect it here</a>.
            </p>
            <div className="hero-promise">
              <span className="promise-check" aria-hidden="true">
                <svg viewBox="0 0 12 12" fill="none">
                  <path
                    d="m2.5 6 2.2 2.2 4.8-5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>The original video is never changed.</span>
            </div>
          </div>

          <section className="demo-column" id="demo" aria-labelledby="demo-title">
            <div className="demo-heading">
              <div>
                <span className="section-kicker">INTERACTIVE WALK-THROUGH</span>
                <h2 id="demo-title">Try the conversation</h2>
              </div>
              <div className="demo-heading-actions">
                <button className="ghost-button" type="button" onClick={sendHelp} disabled={busy}>
                  Send /help
                </button>
                <button className="reset-button" type="button" onClick={resetDemo}>
                  <RefreshIcon />
                  <span>Restart</span>
                </button>
              </div>
            </div>

            <div className="limits-card">
              <div className="limits-copy">
                <span className="section-kicker">CHANGE THE LIMITS</span>
                <p>Adjust a setting and watch the bot's messages update.</p>
              </div>
              <label className="limit-field">
                <span className="limit-field-head">
                  Maximum video size <strong>{maxUploadMB} MB</strong>
                </span>
                <input
                  type="range"
                  min="20"
                  max="300"
                  step="10"
                  value={maxUploadMB}
                  onChange={(event) => setMaxUploadMB(Number(event.target.value))}
                  aria-label="Maximum video size in megabytes"
                />
              </label>
              <label className="limit-toggle">
                <input
                  type="checkbox"
                  checked={allowCustom}
                  onChange={(event) => setAllowCustom(event.target.checked)}
                />
                <span>Allow custom dimensions</span>
              </label>
            </div>

            <div className="chat-window">
              <div className="chat-header">
                <div className="bot-avatar">
                  <VideoIcon />
                </div>
                <div className="chat-identity">
                  <strong>Sendable</strong>
                  <span>bot / design preview</span>
                </div>
                <span className="chat-online">
                  <span /> prototype
                </span>
              </div>

              <div className="demo-disclaimer">
                <span className="demo-disclaimer-dot" />
                Sample conversation. No video is uploaded or processed.
              </div>

              <div
                className="chat-log"
                role="log"
                aria-label="Sample Telegram conversation"
                aria-live="polite"
                aria-relevant="additions text"
              >
                <div className="date-divider">
                  <span>Today</span>
                </div>

                {messages.map((message) => (
                  <div className={`message-row ${message.role}`} key={message.id}>
                    {message.role === "bot" && (
                      <div className="message-avatar">
                        <VideoIcon />
                      </div>
                    )}
                    <div className={`message-bubble${message.kind === "file" ? " file-message" : ""}`}>
                      {message.kind === "file" ? (
                        <>
                          <span className="file-message-icon">
                            <VideoIcon />
                          </span>
                          <span className="file-message-info">
                            <strong>{message.text}</strong>
                            <small>{message.meta}</small>
                          </span>
                        </>
                      ) : (
                        <p>{message.text}</p>
                      )}
                      <span className="message-time">{message.time}</span>
                    </div>
                  </div>
                ))}

                {stage === "welcome" && (
                  <div className="chat-controls welcome-controls">
                    <p>Pick a sample video to send, just like you would in Telegram.</p>
                    <div className="sample-list">
                      {samples.map((sample) => (
                        <button
                          key={sample.key}
                          className="sample-button"
                          type="button"
                          onClick={() => sendSample(sample)}
                        >
                          <span className="sample-icon">
                            <VideoIcon />
                          </span>
                          <span className="sample-info">
                            <strong>{sample.name}</strong>
                            <small>
                              {sample.sizeMB} MB · {sample.duration}
                            </small>
                          </span>
                          {sample.sizeMB > maxUploadMB && (
                            <span className="sample-flag">over limit</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {stage === "uploading" && (
                  <div className="chat-controls">
                    <div className="upload-card">
                      <div className="upload-head">
                        <span className="upload-name">{activeSample?.name}</span>
                        <span className="upload-percent">{Math.round(progress)}%</span>
                      </div>
                      <span className="progress-track">
                        <span style={{ transform: `scaleX(${progress / 100})` }} />
                      </span>
                      <span className="upload-note">Uploading. Keep this chat open.</span>
                    </div>
                  </div>
                )}

                {stage === "choose" && (
                  <div className="chat-controls option-list" aria-label="Choose a video size">
                    {sizeOptions.map((option) => (
                      <button
                        key={option.key}
                        className="preset-button"
                        type="button"
                        onClick={() => selectOption(option)}
                      >
                        <span className="preset-label">{option.label}</span>
                        <span className="preset-detail">{option.detail}</span>
                      </button>
                    ))}
                    <button className="text-button" type="button" onClick={sendAnotherVideo}>
                      Send a different video
                    </button>
                  </div>
                )}

                {stage === "custom" && (
                  <form className="chat-controls custom-form" onSubmit={submitCustomSize}>
                    <div className="custom-fields">
                      <label>
                        Width <span>(pixels)</span>
                        <input
                          aria-label="Custom width in pixels"
                          type="number"
                          min="1"
                          step="1"
                          value={customWidth}
                          onChange={(event) => setCustomWidth(event.target.value)}
                        />
                      </label>
                      <span className="dimension-separator">x</span>
                      <label>
                        Height <span>(pixels)</span>
                        <input
                          aria-label="Custom height in pixels"
                          type="number"
                          min="1"
                          step="1"
                          value={customHeight}
                          onChange={(event) => setCustomHeight(event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="form-hint">
                      The bot fits the video inside these dimensions so nothing stretches.
                    </p>
                    {customError && (
                      <p className="form-error" role="alert">
                        {customError}
                      </p>
                    )}
                    <button className="sample-upload-button" type="submit">
                      Use these dimensions <ArrowIcon />
                    </button>
                  </form>
                )}

                {stage === "confirm" && (
                  <div className="chat-controls confirm-controls">
                    <button className="sample-upload-button" type="button" onClick={createPreview}>
                      Create preview <ArrowIcon />
                    </button>
                    <button className="text-button" type="button" onClick={changeSize}>
                      Change size
                    </button>
                  </div>
                )}

                {stage === "processing" && (
                  <div className="chat-controls">
                    <div className="processing-bubble" role="status">
                      <span className="processing-head">
                        <span className="typing-indicator">
                          <i />
                          <i />
                          <i />
                        </span>
                        Preparing your preview
                      </span>
                      <span className="progress-track">
                        <span style={{ transform: `scaleX(${progress / 100})` }} />
                      </span>
                      <span className="processing-note">
                        Longer videos take longer. You can keep chatting in the meantime.
                      </span>
                    </div>
                    <button className="text-button" type="button" onClick={cancelPreview}>
                      Cancel
                    </button>
                  </div>
                )}

                {stage === "tooLarge" && (
                  <div className="chat-controls error-controls">
                    {smallerSample && (
                      <button
                        className="sample-upload-button"
                        type="button"
                        onClick={() => sendSample(smallerSample)}
                      >
                        Send {smallerSample.name}
                      </button>
                    )}
                    <button className="text-button" type="button" onClick={resetDemo}>
                      Start over
                    </button>
                  </div>
                )}

                {(stage === "preview" || stage === "done") && job && activeSample && (
                  <div className="preview-result">
                    <div className="compare-grid">
                      <FrameArtwork id="after" label={`After · ${job.label}`} soften />
                      <FrameArtwork id="before" label="Before · original" />
                    </div>
                    <p className="compare-note">
                      Illustration only. The bot shows your real video here.
                    </p>
                    <div className="preview-file-row">
                      <span className="preview-file-icon">
                        <VideoIcon />
                      </span>
                      <span className="preview-file-name">
                        <strong>{activeSample.name.replace(/\.[^.]+$/, "")}_preview.mp4</strong>
                        <small>
                          {job.label} · {activeSample.duration}
                        </small>
                      </span>
                    </div>
                    <div className="size-comparison">
                      <div>
                        <span>Original</span>
                        <strong>{activeSample.sizeMB} MB</strong>
                      </div>
                      <span className="comparison-arrow" aria-hidden="true">
                        to
                      </span>
                      <div>
                        <span>Estimated</span>
                        <strong>~{formatMB(estimatedMB)}</strong>
                      </div>
                    </div>
                    <p className="example-note">
                      Estimate only. The real size depends on the video's motion and detail,
                      and the bot shows it once the preview is finished.
                    </p>
                  </div>
                )}

                {stage === "preview" && (
                  <div className="chat-controls preview-controls">
                    <button className="sample-upload-button" type="button" onClick={finishDemo}>
                      <DownloadIcon />
                      Download this version
                    </button>
                    <button className="text-button" type="button" onClick={changeSize}>
                      Try another size
                    </button>
                    <button className="text-button" type="button" onClick={sendAnotherVideo}>
                      Send a different video
                    </button>
                  </div>
                )}

                {stage === "done" && (
                  <div className="chat-controls done-controls">
                    <button className="text-button" type="button" onClick={resetDemo}>
                      Start over
                    </button>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              <div className="chat-footer">
                <span className="composer-plus" aria-hidden="true">
                  +
                </span>
                <span>{busy ? "Working on it…" : "Use the buttons above to continue"}</span>
                <span className="composer-mic" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none">
                    <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.5" />
                    <path
                      d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5m-3 0h6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </div>
            </div>
            <p className="demo-caption">
              A clickable sample of the flow. The real bot runs in Telegram:{" "}
              <a href={telegramUrl} target="_blank" rel="noreferrer">
                open @{bot.username}
              </a>{" "}
              or <a href="#connect">connect your own</a>.
            </p>
          </section>
        </section>

        <section className="journey-section page-width reveal" id="flow" aria-labelledby="flow-title">
          <div className="section-heading">
            <span className="section-kicker">01 / THE USER JOURNEY</span>
            <div>
              <h2 id="flow-title">Three steps. No editing vocabulary.</h2>
              <p>
                The bot explains one next action at a time and keeps advanced choices optional.
              </p>
            </div>
          </div>
          <ol className="journey-list">
            {flowSteps.map((step) => (
              <li key={step.number}>
                <span className="journey-number">{step.number}</span>
                <div className="journey-copy">
                  <h3>{step.title}</h3>
                  <p>{step.copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="message-section page-width reveal" id="messages" aria-labelledby="messages-title">
          <div className="section-heading">
            <span className="section-kicker">02 / MESSAGE GUIDE</span>
            <div>
              <h2 id="messages-title">Friendly, useful, and short.</h2>
              <p>Suggested bot copy for each moment in the resize process.</p>
            </div>
          </div>
          <div className="message-script">
            {messageRows.map((row, index) => (
              <article className="script-row" key={row.label}>
                <div className="script-label">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{row.label}</strong>
                </div>
                <div className="script-copy">
                  <h3>{row.title}</h3>
                  <p>&quot;{row.copy}&quot;</p>
                  {row.options && (
                    <div className="script-options" aria-label="Suggested size choices">
                      {row.options.map(([name, detail]) => (
                        <div className="script-option" key={name}>
                          <strong>{name}</strong>
                          <span>{detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    className="copy-button"
                    type="button"
                    onClick={() => copyMessage(row.label, row.copy)}
                  >
                    {copiedKey === row.label ? <CheckIcon /> : <CopyIcon />}
                    <span>{copiedKey === row.label ? "Copied" : "Copy message"}</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
          <p className="copy-status" role="status">
            {copyNote}
          </p>
        </section>

        <section className="guardrail-section" id="guardrails" aria-labelledby="guardrail-title">
          <div className="guardrail-inner page-width reveal">
            <div className="section-heading guardrail-heading">
              <span className="section-kicker">03 / TRUST &amp; RECOVERY</span>
              <div>
                <h2 id="guardrail-title">Clear limits. Helpful way back.</h2>
                <p>
                  Be honest about what the bot can handle, and make mistakes easy to recover from.
                </p>
              </div>
            </div>

            <div className="guardrail-columns">
              <div className="guardrail-rules">
                <span className="column-label">SET BEFORE LAUNCH</span>
                <div className="rule-row">
                  <strong>Upload size</strong>
                  <p>
                    Show the real maximum before upload. Telegram and hosting limits vary, so never
                    guess at a fixed number.
                  </p>
                </div>
                <div className="rule-row">
                  <strong>File types</strong>
                  <p>List only the video formats the bot has been tested to read, such as MOV or MP4.</p>
                </div>
                <div className="rule-row">
                  <strong>Quality and size</strong>
                  <p>
                    Smaller settings can soften detail. Show real before-and-after sizes; never promise
                    a smaller result or unchanged quality.
                  </p>
                </div>
                <div className="rule-row">
                  <strong>Custom size</strong>
                  <p>Set a real dimension limit, check every request, and keep the video from stretching.</p>
                </div>
                <div className="rule-row">
                  <strong>Waiting time</strong>
                  <p>
                    Give a rough sense of how long a preview takes, and keep people updated if it is
                    slow.
                  </p>
                </div>
                <div className="rule-row">
                  <strong>File privacy</strong>
                  <p>
                    Say how long uploaded videos and resized copies are kept, and when they are deleted.
                  </p>
                </div>
                <SizeEstimator />
              </div>

              <div className="recovery-list">
                <span className="column-label">IF SOMETHING GOES WRONG</span>
                {recoveryRows.map((row) => (
                  <div className="recovery-row" key={row.label}>
                    <span>{row.label}</span>
                    <p>&quot;{row.copy}&quot;</p>
                  </div>
                ))}
                <p className="commands-note">
                  <code>/help</code> explains the limits and choices. <code>/cancel</code> stops the
                  current resize and leaves the original alone.
                </p>
              </div>
            </div>
          </div>
        </section>
        <ConnectSection
          username={bot.username}
          isDefault={bot.isDefault}
          onConnect={bot.setUsername}
          onReset={bot.resetUsername}
          apiUrl={api.apiUrl}
          isDefaultApi={api.isDefault}
          onConnectApi={api.setApiUrl}
          onResetApi={api.resetApiUrl}
        />
      </main>

      <footer className="page-footer page-width">
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span>sendable</span>
        </a>
        <p>A simple bot flow for a real-world sharing problem.</p>
        <div className="footer-links">
          <a href={telegramUrl} target="_blank" rel="noreferrer" className="footer-telegram">
            <TelegramIcon />
            Open bot
          </a>
          <a href={shareUrl} target="_blank" rel="noreferrer">
            Share in Telegram
          </a>
          <a href="#top" className="back-top">
            Back to top <ArrowIcon diagonal />
          </a>
        </div>
      </footer>
    </div>
  );
}

export default App;
