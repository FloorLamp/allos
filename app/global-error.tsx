"use client";

// Top-level error boundary. Unlike app/(app)/error.tsx this replaces the root
// layout when the layout itself (or something above the route group) throws, so
// it must render its own <html>/<body>. Tailwind/globals may not be applied at
// this point, so the card is styled with inline styles to stay legible in the
// worst case. `reset()` attempts a re-render.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#e4ece6",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          color: "#1e293b",
        }}
      >
        <div
          style={{
            maxWidth: "28rem",
            margin: "1rem",
            padding: "2rem",
            borderRadius: "0.75rem",
            background: "#ffffff",
            boxShadow: "0 10px 30px rgba(15,23,42,0.15)",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              color: "#64748b",
            }}
          >
            The app hit an unexpected error. Try reloading — if it keeps
            happening, the reference below can help with debugging.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "0.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: "#94a3b8",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.25rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#16a34a",
              color: "#ffffff",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
