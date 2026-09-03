import type { ReactNode } from "react";

// ── THE OFFER, AND ITS TWO TONES (issue #4548) ──────────────────────────────
//
// An OFFER is a control whose tap performs the write it describes. The brand-tinted
// full-width row was copied byte-identically at three call sites while
// `DoseHistoryPanel` had extracted a DIFFERENT one, so the app shipped two answers to
// "what does an offer look like" and no way to tell which was meant.
//
// TONE IS A DECLARED PROPERTY, NOT A FORK (#4548's baked ruling): brand is a COMPOSED
// offer — one tap standing in for several writes — and neutral is a list-hosted offer
// row. A caller declares which it is; it never spells the paint.
//
// MARGINS STAY THE CALLER'S. The three copies differed only in their leading margin,
// which is the row's position in ITS list and not a property of the offer, so it
// arrives through `className` rather than becoming a third tone.
export type OfferTone = "brand" | "neutral";

const OFFER_ROW_TONE: Record<OfferTone, string> = {
  brand:
    "border-brand-200 bg-brand-50/60 hover:bg-brand-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60",
  neutral:
    "border-(--border) bg-surface text-slate-700 hover:bg-(--ghost-hover) dark:text-slate-200",
};

// The VERB NUB's paint, read from here by the labeled-verb chip in
// `components/Chip.tsx` (issue #4753). A chip is a COMPACT offer — the action half of
// this substrate — so it declares the same two tones rather than minting a second
// vocabulary for the same question. It lives beside the chip's other presentation
// because `lib/__tests__/chip-residual.test.ts` pins raw chip classes to that one
// module; what is shared is the DECLARATION, which is the part that could drift.
export const OFFER_VERB_TONE: Record<OfferTone, string> = {
  brand: "bg-brand-600 text-white dark:bg-brand-500 dark:text-ink-950",
  neutral: "bg-slate-200 text-slate-700 dark:bg-ink-700 dark:text-slate-200",
};

export default function OfferRow({
  tone,
  onAct,
  disabled,
  ariaLabel,
  testId,
  className,
  data,
  children,
}: {
  tone: OfferTone;
  onAct: () => void;
  disabled?: boolean;
  /** The whole sentence for a reader, where the visible row abbreviates it. */
  ariaLabel?: string;
  testId?: string;
  /** The caller's own position in its list — margins only. */
  className?: string;
  data?: Readonly<Record<`data-${string}`, string | number | undefined>>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onAct}
      aria-label={ariaLabel}
      data-testid={testId}
      // `min-w-0` IS THE SEAM, NOT THE HOST'S PROBLEM (#4918 ruling 6). `w-full`
      // alone means "as wide as my box"; it says nothing about how wide the box may
      // become, so an intrinsically-sized host — a grid track, a flex item that has
      // not been told to shrink — grew the box to the row's max-content width and
      // the truncating span inside never had a narrower box to truncate in. Declared
      // here so no host can stretch it, rather than at each mount, because the mount
      // that gets it wrong is the one nobody has written yet.
      className={`press flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
        OFFER_ROW_TONE[tone]
      }${className ? ` ${className}` : ""}`}
      {...data}
    >
      {children}
    </button>
  );
}
