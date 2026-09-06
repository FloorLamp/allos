import { IconChevronRight } from "@tabler/icons-react";
import Disclosure from "@/components/Disclosure";

// THE LEAD + FOLD PRIMITIVE (copy.md rule 10; #3488, #3490).
//
// One sentence a reader is handed, and everything else behind a disclosure they
// can open. It is ONE component for both surface families that #3488 and #3490
// filed separately — the Import card's intro and every integration page's intro —
// because the convention is a convention, and a convention expressed twice is two
// conventions by next month. A third surface (#3497's provenance blocks are the
// next one queued) inherits it by rendering this with its own `summary` label;
// there is nothing else to decide, and nothing to re-derive.
//
// ── WHY `<Disclosure>` AND NOT `<Collapse>` ─────────────────────────────────────
//
// The fold is the app's shared `<Disclosure>` (#3677): a native `<details>`, so it stays
// server-renderable, works before hydration, and arrives with the keyboard and AT
// semantics already correct — while animating open on the one continuity token. This
// file's earlier note that an animated collapse would cost nine integration pages a
// `"use client"` boundary was about `components/Collapse.tsx`, a different primitive that
// reads `usePrefersReducedMotion`; that reasoning is unchanged and is why this is not it.
// The fold holds NO persisted state, which is the honest default for an intro: it is
// closed on every visit, for everyone, and the summary always says what is inside.
//
// ── WHAT THE CALLER DECIDES, AND WHAT IT DOES NOT ───────────────────────────────
//
// The caller brings the lead, the detail, and the question the summary answers
// ("What can I import?", "How it works"). It does NOT bring a type scale, a text
// tone, spacing, or a chevron: those are the primitive's, so nine pages cannot
// drift into nine intros. `text-slate-500` on both halves keeps the lead and the
// detail the same register — a fold is not a demotion, and the detail is not a
// footnote.
//
// The summary is a QUESTION or a plain label, never "Read more": a reader decides
// whether to open it from what it says it holds.
export default function LeadFold({
  lead,
  detail,
  summary,
  testId,
  className = "",
}: {
  /** The one sentence. Rendered unconditionally, never behind the fold. */
  lead: React.ReactNode;
  /**
   * Everything else. When absent the disclosure is not rendered at all — a fold
   * with nothing behind it is a control that lies.
   */
  detail?: React.ReactNode;
  /** What the closed disclosure says it holds. */
  summary: string;
  /**
   * Names the whole intro block for the census probe, which measures this box's
   * RENDERED height at 390px. Every adopter passes one.
   */
  testId: string;
  className?: string;
}) {
  return (
    <div data-testid={testId} className={`space-y-2 ${className}`}>
      <p
        data-testid={`${testId}-lead`}
        className="text-sm text-slate-500 dark:text-slate-400"
      >
        {lead}
      </p>
      {detail ? (
        <Disclosure data-testid={`${testId}-fold`}>
          <summary
            data-testid={`${testId}-fold-summary`}
            className="fold-control flex w-fit list-none items-center gap-1 text-sm font-medium text-link"
          >
            <IconChevronRight
              className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90"
              stroke={1.75}
              aria-hidden
            />
            {summary}
          </summary>
          <div
            data-testid={`${testId}-detail`}
            className="mt-2 text-sm text-slate-500 dark:text-slate-400"
          >
            {detail}
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
