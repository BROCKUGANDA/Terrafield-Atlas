'use client';

/**
 * GLOBAL error boundary — last resort when the ROOT LAYOUT itself faults
 * (it must render its own <html>/<body> because the app shell is gone).
 * Keeps the mission tone, states honestly what is down, offers reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#050914',
          color: '#cdd6e4',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 640,
            padding: 28,
            border: '1px solid rgba(255,93,93,0.4)',
            borderRadius: 2,
            background: 'rgba(255,93,93,0.06)',
          }}
        >
          <p style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#ff5d5d', margin: '0 0 10px' }}>
            Global fault — console shell unavailable
          </p>
          <h1 style={{ fontSize: 18, margin: '0 0 10px', color: '#eef2f8' }}>
            TerraField Atlas hit a fatal render fault
          </h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 12px', color: '#9aa7bb' }}>
            The root layout failed, so the full console cannot mount. No data was fabricated; reload
            re-requests the live console from the server.
          </p>
          <p style={{ fontSize: 11, color: '#6d7a90', margin: '0 0 16px', wordBreak: 'break-word' }}>
            {error.name}: {error.message.slice(0, 200)}
            {error.digest ? ` · digest ${error.digest}` : ''}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 36,
              padding: '0 14px',
              border: '1px solid rgba(90,200,250,0.5)',
              background: 'rgba(90,200,250,0.1)',
              color: '#eef2f8',
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Reload console
          </button>
        </div>
      </body>
    </html>
  );
}
