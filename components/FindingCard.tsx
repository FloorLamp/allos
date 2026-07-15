import type { ReactNode } from "react";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
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
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-black/5 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-300"
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
// caller passes; every one is the same card. Tone maps to the container +
// detail + evidence text colors.
type FindingTone = "amber" | "slate" | "rose" | "violet";

const TONE: Record<
  FindingTone,
  { container: string; detail: string; evidence: string }
> = {
  amber: {
    container:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
    detail: "text-amber-700 dark:text-amber-300",
    evidence: "text-amber-600 dark:text-amber-400",
  },
  slate: {
    container:
      "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200",
    detail: "text-slate-600 dark:text-slate-300",
    evidence: "text-slate-500 dark:text-slate-400",
  },
  rose: {
    container:
      "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
    detail: "text-rose-700 dark:text-rose-300",
    evidence: "text-rose-600 dark:text-rose-400",
  },
  violet: {
    container:
      "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200",
    detail: "text-violet-700 dark:text-violet-300",
    evidence: "text-violet-600 dark:text-violet-400",
  },
};

export function FindingCard({
  tone,
  testid,
  icon = true,
  title,
  detail,
  evidence,
  children,
  dismissKey,
  dismissLabel,
}: {
  tone: FindingTone;
  testid: string;
  // The amber/rose/violet hazard blocks lead with an alert triangle; the calm
  // slate RDA block has no icon.
  icon?: boolean;
  title: ReactNode;
  detail: ReactNode;
  evidence: ReactNode;
  // Optional slot between detail and evidence (the RDA food-sources line).
  children?: ReactNode;
  dismissKey: string;
  dismissLabel: string;
}) {
  const t = TONE[tone];
  const body = (
    <div>
      <p className="font-semibold">{title}</p>
      <p className={`mt-0.5 ${t.detail}`}>{detail}</p>
      {children}
      <p className={`mt-1 text-xs ${t.evidence}`}>{evidence}</p>
    </div>
  );
  return (
    <div
      data-testid={testid}
      className={`rounded-lg border px-3 py-2.5 text-sm ${t.container}`}
    >
      <div className="flex items-start justify-between gap-2">
        {icon ? (
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {body}
          </div>
        ) : (
          body
        )}
        <DismissFindingButton dedupeKey={dismissKey} label={dismissLabel} />
      </div>
    </div>
  );
}
