import type { ReactNode } from "react";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import { NOTICE_TONE, type NoticeTone } from "@/components/Notice";
import { dismissIntakeFinding } from "@/app/(app)/nutrition/supplement-actions";

// Inline dismiss control for the page's finding cards (#435): posts the finding's
// dedupeKey to the namespace-guarded dismissIntakeFinding action, which hides it
// through the shared findings-suppression bus. One helper so every warning block
// (UL, RDA, interaction, PGx) and the keep-apart bucket banner dismiss identically.
export function DismissFindingButton({
  dedupeKey,
  label,
}: {
  dedupeKey: string;
  label: string;
}) {
  return (
    <form
      action={async (fd) => {
        "use server";
        await dismissIntakeFinding(fd);
      }}
    >
      <input type="hidden" name="dedupe_key" value={dedupeKey} />
      <button
        type="submit"
        data-testid="medicine-finding-dismiss"
        aria-label={label}
        title="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
      >
        <IconX className="h-4 w-4" stroke={2} />
      </button>
    </form>
  );
}

// The shared intake finding-card anatomy (#747): an optional alert icon, a
// bold title, a detail line, an optional middle slot (`children` — e.g. the RDA
// food-sources note), a small evidence/citation footnote, and the dismiss-via-bus
// button. The blocks differ ONLY in tone (amber UL hazard, slate RDA calm, rose
// drug-interaction, violet PGx) and the formatted title/detail/evidence each
// caller passes; every one is the same card. The container tint comes from the
// shared NOTICE_TONE map (so FindingCard and Notice can't drift); tone also maps to
// the detail + evidence text colors below.
type FindingTone = NoticeTone;

// Detail (mid) and evidence (small footnote) text colors per tone. Both are -700 on
// the -50 tint — cluster 8b: the evidence line used to be -600, which fails WCAG AA
// at text-xs (amber-600 = 3.07:1, rose-600 = 4.28:1); -700 passes (4.84 / 5.72). The
// calm slate block keeps its lighter -600/-500 (both pass on slate-50: 7.24 / 4.55).
const TEXT: Record<FindingTone, { detail: string; evidence: string }> = {
  amber: {
    detail: "text-amber-700 dark:text-amber-300",
    evidence: "text-amber-700 dark:text-amber-400",
  },
  slate: {
    detail: "text-slate-600 dark:text-slate-300",
    evidence: "text-slate-500 dark:text-slate-400",
  },
  rose: {
    detail: "text-rose-700 dark:text-rose-300",
    evidence: "text-rose-700 dark:text-rose-400",
  },
  violet: {
    detail: "text-violet-700 dark:text-violet-300",
    evidence: "text-violet-700 dark:text-violet-400",
  },
  emerald: {
    detail: "text-emerald-700 dark:text-emerald-300",
    evidence: "text-emerald-700 dark:text-emerald-400",
  },
  sky: {
    detail: "text-sky-700 dark:text-sky-300",
    evidence: "text-sky-700 dark:text-sky-400",
  },
};

export function FindingCard({
  tone,
  testid,
  icon = true,
  embedded = false,
  title,
  detail,
  evidence,
  children,
  dismissKey,
  dismissLabel,
  dismissable = true,
}: {
  tone: FindingTone;
  testid: string;
  // The amber/rose/violet hazard blocks lead with an alert triangle; the calm
  // slate RDA block has no icon.
  icon?: boolean;
  // A grouped parent can supply the shared surface and dividers. In that layout,
  // keep the finding anatomy but avoid nesting another tinted card inside it.
  embedded?: boolean;
  title: ReactNode;
  detail: ReactNode;
  evidence: ReactNode;
  // Optional slot between detail and evidence (the RDA food-sources line).
  children?: ReactNode;
  dismissKey: string;
  dismissLabel: string;
  // Whether to render the dismiss-via-bus control (#1373). A NON-acting multi-view
  // Medications board shows a member's own warnings read-only: the dismiss action
  // carries no cross-profile target seam, so offering it here would suppress on the
  // WRONG profile — the dismiss stays acting-only (act as the member to dismiss).
  // Default true keeps every existing caller byte-identical.
  dismissable?: boolean;
}) {
  const t = TEXT[tone];
  return (
    <div
      data-testid={testid}
      className={
        embedded
          ? "py-3 text-sm first:pt-0 last:pb-0"
          : `rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE[tone]}`
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className={`flex min-w-0 items-start gap-1.5 ${embedded ? t.detail : ""}`}
        >
          {icon ? (
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : null}
          <p className="font-semibold">{title}</p>
        </div>
        {dismissable && (
          <DismissFindingButton dedupeKey={dismissKey} label={dismissLabel} />
        )}
      </div>
      <p className={`mt-0.5 ${t.detail}`}>{detail}</p>
      {children}
      <p className={`mt-1 text-xs ${t.evidence}`}>{evidence}</p>
    </div>
  );
}
