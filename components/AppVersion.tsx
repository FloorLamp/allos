import { getAppVersion } from "@/lib/version";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// Renders the running commit hash, linked to its GitHub commit when known.
// Server component — reads the hash via lib/version.ts. Bare text with a dotted
// underline when it's a link.
//
// The "cell" variant this used to carry is gone with its only reason (#3154): it
// existed for the sidebar footer's bordered box, which no longer holds a hash —
// and its two branches had already converged on one `base`, so the flag chose
// between identical text and a different hover rule for a caller that no longer
// exists. "What am I running?" is answered on What's new, Settings, and
// Settings → Server, all of which render this default.
export default function AppVersion({ className }: { className?: string }) {
  const { sha, commitMessage, commitUrl } = getAppVersion();

  const base = "font-mono text-xs text-slate-500 dark:text-slate-400";
  const linkHover =
    "underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300";

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
