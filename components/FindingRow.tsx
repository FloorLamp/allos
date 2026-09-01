"use client";

import { useOptimistic } from "react";
import { IconX } from "@tabler/icons-react";
import DestinationLink from "@/components/DestinationLink";
import type { Finding } from "@/lib/findings";
import IconButton from "@/components/IconButton";
import { useToast } from "@/components/Toast";

// ONE finding row — title/detail, the optional evidence + action line, and the
// dismiss button posting to the surface's own namespace-guarded server action.
//
// Extracted out of FindingsList (issue #1496) so a surface that needs a DIFFERENT
// list SHAPE still renders the same ROW: the Training → Overview rollup folds the
// per-muscle volume findings into one expandable group row, and the findings inside
// it must stay byte-identical to the flat cards elsewhere — same markup, same
// dismiss affordance, same `dedupeKey` posted to the same bus (the AGENTS.md
// "shared content component" rule; hand-mirrored row markup is exactly what drifts).
//
// ── The dismiss paints in the same frame (#2641 gap 2) ───────────────────────
//
// The row used to sit there unchanged for the whole round trip AND the two-to-five
// route revalidations behind it, because the only thing a bare Server-Action form
// moves is the submit button's own pending glyph. A dismiss is the clearest case in
// the app of a tap whose destination state is known before the server answers: the
// row goes away. So it goes away on the tap.
//
// AND IT CANNOT LIE, structurally — the same guarantee `StarButton` documents. The
// hidden state is `useOptimistic` OVER the server's own render, not state of its
// own, so it lives exactly as long as the form action's transition. If the write
// refused (every surface's action guards its own dedupeKey namespace and returns
// without writing when the key is not its own), the revalidated render still
// contains this finding, the optimistic value falls away, and the row COMES BACK —
// which is the visible revert the inline-action rule asks for. A throw is reported
// as a toast on top of that, because a dropped request is not a refusal and the
// deploy-skew classification upstream must not read as "dismissed".
export default function FindingRow({
  finding: f,
  dismissAction,
  itemTestid,
  dismissTestid,
  dismissKey,
}: {
  finding: Finding;
  // The surface's dismiss server action (guards its own dedupeKey namespace).
  dismissAction: (formData: FormData) => void | Promise<void>;
  itemTestid: string;
  dismissTestid: string;
  // The key POSTED to the bus, when it is deliberately BROADER than this row's own
  // identity. The Results-hub trajectory watch is the case: since #564 a trajectory
  // finding's dismiss records the ANALYTE-level acknowledgment it carries as
  // `supersedes` ("biomarker-flag:<family>"), so dismissing the velocity rule also
  // silences the analyte's dashboard flag. Defaults to the finding's own dedupeKey,
  // which is what every other surface posts.
  dismissKey?: string;
}) {
  const toast = useToast();
  const [dismissed, showDismissed] = useOptimistic(false);

  if (dismissed) return null;

  return (
    <li
      data-testid={itemTestid}
      className={`subpanel-inset-sm flex items-start gap-3 rounded-xl border p-3 ${
        f.tone === "info"
          ? "border-slate-200 bg-slate-50/60 dark:border-ink-750 dark:bg-ink-850/40"
          : "border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-800 dark:text-slate-100">
          {f.title}
        </p>
        {f.detail && (
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            {f.detail}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {f.evidence && <span>{f.evidence}</span>}
          {f.actionHref && (
            <DestinationLink
              href={f.actionHref}
              className="font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              {f.actionLabel ?? "View"}
            </DestinationLink>
          )}
        </div>
      </div>
      {/* Dismiss through the shared findings-bus suppression store (#39/#45). Still a
          form-owned submit: the optimistic hide rides React's own action transition,
          so the submit event the e2e lost-click contract reads (#3359) survives. */}
      <form
        action={async (fd) => {
          showDismissed(true);
          try {
            await dismissAction(fd);
          } catch {
            toast("Couldn't dismiss that. Try again.", { tone: "error" });
          }
        }}
      >
        <input
          type="hidden"
          name="dedupe_key"
          value={dismissKey ?? f.dedupeKey}
        />
        <IconButton
          type="submit"
          data-testid={dismissTestid}
          label={`Dismiss ${f.title}`}
        >
          <IconX className="h-4 w-4" stroke={2} />
        </IconButton>
      </form>
    </li>
  );
}
