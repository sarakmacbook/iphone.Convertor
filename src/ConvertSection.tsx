import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  ConvertError,
  cancelJob,
  downloadUrl,
  fetchServerConfig,
  fileProblem,
  formatBytes,
  formatDimensions,
  formatDuration,
  pollJob,
  savingPercent,
  startConvert,
  FALLBACK_PRESETS,
  type Job,
  type Preset,
  type ServerConfig,
  type SizeRequest,
} from "./convert";

type Props = {
  /** Base URL of the bot server ("" = same origin). Set it in the Connect section. */
  apiUrl: string;
};

type Phase = "pick" | "ready" | "working" | "done";

type Choice = { kind: "preset"; key: string } | { kind: "custom"; width: string; height: string };

const DEFAULT_CHOICE: Choice = { kind: "preset", key: "balanced" };

function StepBadge({ n, done }: { n: string; done?: boolean }) {
  return (
    <span className={`convert-step-badge${done ? " is-done" : ""}`} aria-hidden="true">
      {done ? "✓" : n}
    </span>
  );
}

function MediaCard({
  label,
  name,
  bytes,
  width,
  height,
  duration,
  tone,
}: {
  label: string;
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  tone: "before" | "after";
}) {
  return (
    <div className={`media-card media-${tone}`}>
      <span className="media-label">{label}</span>
      <strong className="media-size">{formatBytes(bytes)}</strong>
      <span className="media-name" title={name}>
        {name}
      </span>
      <dl className="media-meta">
        <div>
          <dt>Dimensions</dt>
          <dd>{formatDimensions(width, height)}</dd>
        </div>
        {duration !== undefined && (
          <div>
            <dt>Length</dt>
            <dd>{formatDuration(duration)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export default function ConvertSection({ apiUrl }: Props) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [checking, setChecking] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [dragging, setDragging] = useState(false);

  const [choice, setChoice] = useState<Choice>(DEFAULT_CHOICE);
  const [phase, setPhase] = useState<Phase>("pick");
  const [uploadPct, setUploadPct] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const presets: Preset[] = config?.presets?.length ? config.presets : FALLBACK_PRESETS;
  const maxUploadMB = config?.limits.maxUploadMB ?? 200;
  const allowCustom = config?.limits.allowCustom ?? true;
  const maxDimension = config?.limits.maxDimension ?? 3840;
  const ttlMinutes = config?.limits.jobTtlMinutes ?? 60;

  /* ---------- server settings ---------- */

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setConfigError("");
    fetchServerConfig(apiUrl, controller.signal)
      .then((next) => {
        setConfig(next);
        setChecking(false);
      })
      .catch((caught: unknown) => {
        if ((caught as Error)?.name === "AbortError") return;
        setConfig(null);
        setConfigError(
          caught instanceof ConvertError
            ? caught.message
            : "Couldn't reach the bot server that does the converting.",
        );
        setChecking(false);
      });
    return () => controller.abort();
  }, [apiUrl]);

  /* ---------- the chosen file ---------- */

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const acceptFile = useCallback(
    (next: File | undefined | null) => {
      if (!next) return;
      const problem = fileProblem(next, maxUploadMB);
      if (problem) {
        setFileError(problem);
        return;
      }
      setFileError("");
      setError("");
      setFile(next);
      setJob(null);
      setPhase("ready");
    },
    [maxUploadMB],
  );

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };

  /* ---------- conversion ---------- */

  const customSize = useMemo(() => {
    if (choice.kind !== "custom") return null;
    const width = Number(choice.width);
    const height = Number(choice.height);
    if (!Number.isInteger(width) || !Number.isInteger(height)) return { error: "Enter a width and height in pixels." };
    if (width < 16 || height < 16) return { error: "Width and height must be at least 16 pixels." };
    if (width > maxDimension || height > maxDimension) return { error: `Stay under ${maxDimension} pixels.` };
    return { width, height };
  }, [choice, maxDimension]);

  const request: SizeRequest | null =
    choice.kind === "preset"
      ? { preset: choice.key }
      : customSize && !("error" in customSize)
        ? { width: customSize.width, height: customSize.height }
        : null;

  const canConvert =
    phase !== "working" && Boolean(file) && Boolean(request) && !checking && !configError;

  const convert = async () => {
    if (!file || !request) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setJob(null);
    setUploadPct(0);
    setPhase("working");

    try {
      const created = await startConvert(apiUrl, file, request, {
        signal: controller.signal,
        onProgress: (fraction) => setUploadPct(fraction),
      });
      setJob(created);
      const finished = await pollJob(apiUrl, created.id, {
        signal: controller.signal,
        intervalMs: 700,
        onUpdate: (next) => setJob(next),
      });
      setJob(finished);
      if (finished.state === "done") {
        setPhase("done");
      } else if (finished.state === "cancelled") {
        setPhase("ready");
      } else {
        setError(finished.error?.message ?? "The conversion failed. Your original is unchanged.");
        setPhase("ready");
      }
    } catch (caught) {
      const cancelled =
        (caught as Error)?.name === "AbortError" ||
        (caught instanceof ConvertError && caught.code === "cancelled");
      if (cancelled) {
        setPhase("ready");
        return;
      }
      const message =
        caught instanceof ConvertError
          ? caught.message
          : "The upload didn't finish. Check your connection and try again.";
      setError(message);
      setPhase("ready");
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (job?.id) await cancelJob(apiUrl, job.id);
    setJob(null);
    setPhase("ready");
  };

  const reset = () => {
    abortRef.current?.abort();
    setFile(null);
    setFileError("");
    setJob(null);
    setError("");
    setUploadPct(0);
    setPhase("pick");
  };

  /* ---------- progress copy ---------- */

  const serverPercent = job && job.state !== "queued" ? Math.round(job.progress * 100) : 0;
  const percent =
    phase === "working"
      ? job && job.state === "converting"
        ? serverPercent
        : Math.min(99, Math.round(uploadPct * 100))
      : 0;
  const statusText =
    job?.state === "converting"
      ? `Converting… ${serverPercent}%`
      : job?.state === "queued"
        ? "In line — starting as soon as a slot is free…"
        : `Uploading… ${Math.round(uploadPct * 100)}%`;

  const output = job?.output;
  const saved = output ? savingPercent(job!.source.bytes, output.bytes) : null;
  const convertPreset = choice.kind === "preset" ? presets.find((p) => p.key === choice.key) : undefined;
  const actionLabel =
    convertPreset?.shortSide === null && convertPreset.key === "convert"
      ? "Create the MP4"
      : "Make it smaller";

  return (
    <section className="convert-section page-width reveal" id="convert" aria-labelledby="convert-title">
      <div className="section-heading">
        <span className="section-kicker">00 / CONVERT HERE</span>
        <div>
          <h2 id="convert-title">Shrink a gallery video right here.</h2>
          <p>
            Pick a video from your phone or computer, choose a size, and the bot's server converts it
            with ffmpeg and hands you a smaller MP4. Your original is never changed.
          </p>
        </div>
      </div>

      <div className="convert-grid">
        <div className="convert-card">
          {checking && (
            <p className="convert-note" role="status">
              Checking the bot server…
            </p>
          )}
          {!checking && configError && (
            <div className="convert-alert">
              <strong>The converter can't reach a bot server.</strong>
              <p>
                {configError} Run the bot (<code>cd bot &amp;&amp; npm start</code>) and enter its address in{" "}
                <a href="#connect">Connect</a>, or build the site with <code>VITE_BOT_API_URL</code>.
              </p>
            </div>
          )}

          <div className="convert-step">
            <div className="convert-step-head">
              <StepBadge n="1" done={Boolean(file)} />
              <h3>Choose a video</h3>
            </div>

            {!file ? (
              <label
                className={`convert-dropzone${dragging ? " is-dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-m4v,video/*"
                  onChange={onPick}
                />
                <span className="convert-drop-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="5" width="13" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
                    <path d="m16 10 5-3v10l-5-3v-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                    <path d="m8 9 4 3-4 3V9Z" fill="currentColor" />
                  </svg>
                </span>
                <strong>Tap to pick from your gallery</strong>
                <span>MOV, MP4 or M4V · up to {maxUploadMB} MB</span>
              </label>
            ) : (
              <div className="convert-file">
                {previewUrl && (
                  <video className="convert-thumb" src={previewUrl} muted playsInline preload="metadata" />
                )}
                <div className="convert-file-info">
                  <strong className="convert-file-name" title={file.name}>
                    {file.name}
                  </strong>
                  <span>{formatBytes(file.size)} · ready to convert</span>
                  <button className="text-button" type="button" onClick={reset}>
                    Choose a different video
                  </button>
                </div>
              </div>
            )}
            {fileError && (
              <p className="convert-error" role="alert">
                {fileError}
              </p>
            )}
          </div>

          <div className="convert-step">
            <div className="convert-step-head">
              <StepBadge n="2" done={Boolean(request)} />
              <h3>Choose a size</h3>
            </div>
            <div className="convert-choices" role="radiogroup" aria-label="Size options">
              {presets.map((preset) => {
                const selected = choice.kind === "preset" && choice.key === preset.key;
                return (
                  <label key={preset.key} className={`convert-choice${selected ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="convert-size"
                      checked={selected}
                      onChange={() => setChoice({ kind: "preset", key: preset.key })}
                    />
                    <span className="convert-choice-copy">
                      <strong>{preset.label}</strong>
                      <span>{preset.detail}</span>
                    </span>
                  </label>
                );
              })}

              {allowCustom && (
                <label
                  className={`convert-choice${choice.kind === "custom" ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="convert-size"
                    checked={choice.kind === "custom"}
                    onChange={() => setChoice({ kind: "custom", width: "720", height: "1280" })}
                  />
                  <span className="convert-choice-copy">
                    <strong>Custom dimensions</strong>
                    <span>Fit the video inside a width and height you set.</span>
                    {choice.kind === "custom" && (
                      <span className="convert-custom-fields">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={16}
                          max={maxDimension}
                          value={choice.width}
                          aria-label="Width in pixels"
                          onChange={(event) => setChoice({ ...choice, width: event.target.value })}
                        />
                        <span aria-hidden="true">×</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={16}
                          max={maxDimension}
                          value={choice.height}
                          aria-label="Height in pixels"
                          onChange={(event) => setChoice({ ...choice, height: event.target.value })}
                        />
                        <span className="convert-custom-unit">px</span>
                      </span>
                    )}
                  </span>
                </label>
              )}
            </div>
            {choice.kind === "custom" && customSize && "error" in customSize && (
              <p className="convert-error" role="alert">
                {customSize.error}
              </p>
            )}
          </div>

          <div className="convert-step">
            <div className="convert-step-head">
              <StepBadge n="3" done={phase === "done"} />
              <h3>{phase === "working" ? "Working on it" : "Convert"}</h3>
            </div>

            {phase === "working" ? (
              <div className="convert-progress">
                <div
                  className="convert-progress-bar"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Conversion progress"
                >
                  <span style={{ width: `${Math.max(3, percent)}%` }} />
                </div>
                <p role="status">{statusText}</p>
                <button className="button-secondary" type="button" onClick={() => void cancel()}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button className="button-primary" type="button" disabled={!canConvert} onClick={() => void convert()}>
                  {actionLabel}
                </button>
                <p className="convert-hint">
                  Longer videos take longer. You'll see the real before-and-after size before saving.
                </p>
              </>
            )}

            {error && (
              <p className="convert-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="convert-card convert-result" aria-live="polite">
          {phase !== "done" || !output ? (
            <div className="convert-empty">
              <span className="convert-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 7h10l2 2h4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M8 13h8m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <h3>Your smaller video lands here</h3>
              <p>
                Pick a video and a size. The result shows the real file sizes, plays right in the page,
                and can be saved with one tap.
              </p>
              <ul>
                <li>Nothing is stored on the server after {ttlMinutes} minutes.</li>
                <li>Videos are never stretched or upscaled.</li>
                <li>GPS and other metadata are stripped from the copy.</li>
              </ul>
            </div>
          ) : (
            <div className="convert-result-body">
              <div className="convert-sizes">
                <MediaCard
                  label="ORIGINAL"
                  name={job!.source.name}
                  bytes={job!.source.bytes}
                  width={job!.source.width}
                  height={job!.source.height}
                  duration={job!.source.duration}
                  tone="before"
                />
                <div className="convert-arrow" aria-hidden="true">
                  {saved !== null ? `−${saved}%` : "same or bigger"}
                </div>
                <MediaCard
                  label="NEW COPY"
                  name={output.name}
                  bytes={output.bytes}
                  width={output.width}
                  height={output.height}
                  tone="after"
                />
              </div>

              <video
                className="convert-preview"
                src={downloadUrl(apiUrl, job!, true)}
                controls
                playsInline
                preload="metadata"
              />

              <div className="convert-result-actions">
                <a
                  className="button-primary"
                  href={downloadUrl(apiUrl, job!)}
                  download={output.name}
                  rel="noreferrer"
                >
                  Save the smaller video
                </a>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => {
                    setJob(null);
                    setPhase("ready");
                  }}
                >
                  Try another size
                </button>
                <button className="text-button" type="button" onClick={reset}>
                  Start over
                </button>
              </div>

              {saved === null ? (
                <p className="convert-warning">
                  This setting didn't make the file smaller, so keep the original or try 720p or 480p.
                  Re-encoding can change detail slightly.
                </p>
              ) : (
                <p className="convert-hint">
                  {job!.choice.label} · saved {formatBytes(job!.source.bytes - output.bytes)}. Re-encoding
                  can change detail slightly; watch it before you share it. The copy is deleted from the
                  server after {ttlMinutes} minutes.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
