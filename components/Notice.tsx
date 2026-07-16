import type { ReactNode } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";

// The ONE tinted-block tone map (issue #794 cluster 4 + 8b), shared by the Notice
// primitive below AND FindingCard (which builds its dismiss-carrying finding cards
// on top of the same containers). Before this, ~15 warning/notice blocks hand-rolled
// their own tint with drifting borders (-200 vs -300), radii (rounded-lg vs -xl), and
// three dark-mode bg treatments (dark:bg-amber-950 vs /40 vs /50). Now a tone is one
// entry here and every surface reads it, so the family can't drift.
//
// Contrast (cluster 8b): light-mode text is -800 on the -50 tint (amber 6.84:1, rose
// 7.30:1, emerald 7.29:1, sky 7.09:1, violet 8.19:1, slate 9.90:1 — all pass WCAG AA),
// deliberately NOT the -600 sibling that fails at text-xs (amber-600 = 3.07:1). Dark
// mode keeps the already-excellent -200-on-950 text.
export type NoticeTone =
  "amber" | "rose" | "slate" | "emerald" | "sky" | "violet";

export const NOTICE_TONE: Record<NoticeTone, string> = {
  amber:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  rose: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
  slate:
    "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200",
  emerald:
    "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  sky: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  violet:
    "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200",
};

// A lighter sibling to FindingCard (#747): the plain informational / warning /
// success / error message block that carries NO dismiss and is NOT a finding — a
// bordered tinted container with an optional lead icon, an optional bold title, the
// message (children), and an optional right-aligned `action` slot (a dismiss button
// or link, e.g. the supplement keep-apart banner). FindingCard stays the primitive
// for dismiss-via-bus finding cards; both share NOTICE_TONE so they read as siblings.
export function Notice({
  tone,
  children,
  title,
  icon = false,
  action,
  testid,
  className,
}: {
  tone: NoticeTone;
  children: ReactNode;
  // Optional bold lead line above the message.
  title?: ReactNode;
  // `true` → the default alert triangle; a node → a custom icon; false → none.
  icon?: boolean | ReactNode;
  // Right-aligned slot (dismiss button / link) — renders the block as a flex row.
  action?: ReactNode;
  testid?: string;
  // Layout passthrough only (margins, max-width, col-span) — never tone classes.
  className?: string;
}) {
  const iconEl =
    icon === true ? (
      <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
    ) : (
      icon || null
    );
  const body = (
    <div className="min-w-0">
      {title != null && <p className="font-semibold">{title}</p>}
      {title != null ? <div className="mt-0.5">{children}</div> : children}
    </div>
  );
  const left = iconEl ? (
    <div className="flex min-w-0 items-start gap-1.5">
      {iconEl}
      {body}
    </div>
  ) : (
    body
  );
  return (
    <div
      data-testid={testid}
      className={`rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE[tone]}${
        className ? ` ${className}` : ""
      }`}
    >
      {action ? (
        <div className="flex items-start justify-between gap-2">
          {left}
          {action}
        </div>
      ) : (
        left
      )}
    </div>
  );
}
