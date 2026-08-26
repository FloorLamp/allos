import { getAppVersion } from "@/lib/version";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// Renders the running commit hash, linked to its GitHub commit when known.
// Server component — reads the hash via lib/version.ts.
//   - "inline" (default): bare text with a dotted underline when it's a link.
//   - "cell": quiet text for an already-bordered container (e.g. the sidebar
//     footer box); links underline on hover. Carries no layout of its own so
//     the click area hugs the text — the parent handles alignment/padding.
export default function AppVersion({
  className,
  variant = "inline",
}: {
  className?: string;
  variant?: "inline" | "cell";
}) {
  const { sha, commitMessage, commitUrl } = getAppVersion();

  const cell = variant === "cell";
  const base = cell
    ? "font-mono text-xs text-slate-500 dark:text-slate-400"
    : "font-mono text-xs text-slate-500 dark:text-slate-400";
  const linkHover = cell
    ? "underline-offset-2 transition hover:text-slate-700 hover:underline dark:hover:text-slate-200"
    : "underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300";

  if (sha && commitUrl) {
    return (
      <span className="inline-flex items-center">
        <a
          href={commitUrl}
          target="_blank"
          rel="noreferrer"
          className={`${base} ${linkHover} ${className ?? ""}`}
        >
          {sha}
        </a>
        {commitMessage ? <InfoTooltipIcon label={commitMessage} /> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center">
      <span className={`${base} ${className ?? ""}`}>{sha ?? "unknown"}</span>
      {commitMessage ? <InfoTooltipIcon label={commitMessage} /> : null}
    </span>
  );
}
