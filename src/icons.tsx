/* Icons shared by the page sections. */

export function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      {diagonal ? (
        <path
          d="M5 15 15 5M7 5h8v8"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3.5 10h12m-5-5 5 5-5 5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <rect x="7" y="7" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M13 5.5A2.5 2.5 0 0 0 10.5 3H5.5A2.5 2.5 0 0 0 3 5.5v5A2.5 2.5 0 0 0 5.5 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        d="M7.4 12.2 16.2 8.4c.4-.16.76.1.62.7l-1.5 7.05c-.1.48-.4.6-.82.37l-2.26-1.67-1.09 1.05c-.12.12-.22.22-.45.22l.16-2.28 4.16-3.76c.18-.16-.04-.25-.28-.1L9.1 13.7l-2.2-.69c-.48-.15-.49-.48.1-.81Z"
        fill="#fff"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
