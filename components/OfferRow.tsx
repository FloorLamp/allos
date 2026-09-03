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
//
// THIS MODULE IS THE WHOLE SUBSTRATE, NOT JUST THE ROW (issue #4753): `LabeledVerbChip`
// below is the same offer compacted into a chip, and it lives here rather than beside
// it — a module a caller imports from is the actual claim about what belongs together,
// and a compact offer that only borrowed this file's tone was still a second module
// answering the same question.
export type OfferTone = "brand" | "neutral";

const OFFER_ROW_TONE: Record<OfferTone, string> = {
  brand:
    "border-brand-200 bg-brand-50/60 hover:bg-brand-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60",
  neutral:
    "border-(--border) bg-surface text-slate-700 hover:bg-(--ghost-hover) dark:text-slate-200",
};

// The VERB NUB's paint, shared by `LabeledVerbChip` below (issue #4753). A chip is a
// COMPACT offer — the action half of this substrate — so it declares the same two
// tones rather than minting a second vocabulary for the same question.
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

// ── THE ACTION HALF: A COMPACT OFFER (issue #4753) ──────────────────────────
//
// `OfferRow` above is the full-width offer; `LabeledVerbChip` is the same offer
// compacted into the 34px control box — a chip is a compact offer, so it lives here
// rather than beside `Chip.tsx`'s nav/filter roles, which are a different grammar
// (selection, not a write). The chip's LABEL SHOWS THE PAYLOAD THE TAP CARRIES —
// `Aug 30 · 250 mg` beside a `Log` nub, not a bare "Mark taken". That is what retires
// the "…now"-suffixed verbs on an adopted surface: the label already says what will
// be written, so the verb stops having to carry the whole sentence and can be one
// word.
//
// THE APPLICABILITY TEST, stated so nobody over-applies it: a one-tap that performs a
// WRITE whose payload is summarizable in the label. No label worth showing, or not a
// write, and this is not the chip — selection chips, navigation, form submits and
// destructive actions are all excluded by that test rather than by a list.
//
// ONE TARGET, AND THE NUB IS NOT A SECOND ONE. The whole pill is a single button
// wearing the 34px control box, so the label is informative and never a second tap;
// the verb is a `<span>` inside it, which is why it takes no tab stop and grows no
// hit region of its own. `chip-base`'s coarse-pointer `::after` reaches 6px past the
// pill, so a caller placing two of these side by side spends the same `gap-3` every
// other control row spends (#3938).
//
// THE CLOCK DOOR HAS A SEAT, AND THIS PRIMITIVE ONLY RESERVES IT (#4426, whose
// `components/TimeStatement.tsx` is the door itself). A door passed by the adopter
// renders immediately right of the pill, inside a wrapper that pays the reach gap;
// passed nothing, there is no wrapper and no seat — the absence is structural rather
// than an empty element rendering nothing.
export function LabeledVerbChip({
  label,
  verb,
  onAct,
  tone,
  clockDoor,
  disabled,
  ariaLabel,
  testId,
  data,
}: {
  /** The payload this tap writes, as the reader should see it. */
  label: ReactNode;
  /** One word for what the tap does. Never "now" — the label states the when. */
  verb: string;
  onAct: () => void;
  tone: OfferTone;
  /** #4426's statement control, in its seat. Absent renders no seat at all. */
  clockDoor?: ReactNode;
  disabled?: boolean;
  /**
   * The whole sentence for a reader (#2615 item 2), where the visible label
   * abbreviates it. Omitted, the pill's own text — label then verb — is the name.
   */
  ariaLabel?: string;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string | number | undefined>>;
}) {
  const pill = (
    <button
      type="button"
      disabled={disabled}
      onClick={onAct}
      aria-label={ariaLabel}
      data-testid={testId}
      data-chip-verb={verb}
      className="chip-base chip-offer"
      {...data}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={`-mr-1.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${OFFER_VERB_TONE[tone]}`}
      >
        {verb}
      </span>
    </button>
  );
  if (!clockDoor) return pill;
  return (
    <span className="inline-flex items-center gap-3">
      {pill}
      {clockDoor}
    </span>
  );
}
