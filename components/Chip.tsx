import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import TimelineFilterLink from "@/components/TimelineFilterLink";
import { OFFER_VERB_TONE, type OfferTone } from "@/components/OfferRow";
import type { AppRoute } from "@/lib/hrefs";

export type ChipRole = "nav" | "filter";

interface InternalChipLinkProps {
  href: AppRoute | `#${string}`;
  className: string;
  children: ReactNode;
  ariaCurrent?: "page" | "true" | "location";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
}

type CommonProps = {
  role: ChipRole;
  children: ReactNode;
  testId?: string;
};

type LinkChipProps = CommonProps & {
  current: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  pressed?: never;
  disabled?: never;
  expanded?: never;
  controls?: never;
} & (
    | {
        href: `#${string}`;
        linkBehavior?: never;
      }
    | {
        href: AppRoute;
        /** Closed behavior adapter; presentation and ARIA remain primitive-owned. */
        linkBehavior?: "timeline";
      }
  );

type FilterButtonChipProps = CommonProps & {
  role: "filter";
  pressed: boolean;
  accessibleLabel?: string;
  data?: Readonly<
    Record<`data-${string}`, string | number | boolean | undefined>
  >;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  href?: never;
  current?: never;
  linkBehavior?: never;
};

export type ChipProps = LinkChipProps | FilterButtonChipProps;

function DefaultChipLink({
  href,
  className,
  children,
  ariaCurrent,
  onClick,
  testId,
}: InternalChipLinkProps) {
  const props = {
    href,
    className,
    children,
    "aria-current": ariaCurrent,
    onClick,
    "data-testid": testId,
  };
  return href.startsWith("#") ? <a {...props} /> : <Link {...props} />;
}

// The one pressable chip primitive. Role chooses the visual language, geometry is
// the control box every control wears (#3938 retired the dense size), and
// interaction state is the same state that paints the selected treatment. Callers
// provide content and behavior, never presentation classes or independent ARIA.
export default function Chip(props: ChipProps) {
  const className = `chip-base chip-${props.role}`;

  if (props.href !== undefined) {
    const ariaCurrent = props.current
      ? props.role === "filter"
        ? "true"
        : props.href.startsWith("#")
          ? "location"
          : "page"
      : undefined;
    if (props.linkBehavior === "timeline") {
      return (
        <TimelineFilterLink
          href={props.href}
          ariaCurrent={ariaCurrent}
          onClick={props.onClick}
          className={className}
          testId={props.testId}
        >
          {props.children}
        </TimelineFilterLink>
      );
    }
    return (
      <DefaultChipLink
        href={props.href}
        ariaCurrent={ariaCurrent}
        onClick={props.onClick}
        className={className}
        testId={props.testId}
      >
        {props.children}
      </DefaultChipLink>
    );
  }

  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.pressed}
      aria-label={props.accessibleLabel}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onClick}
      data-testid={props.testId}
      data-chip-role="filter"
      className={className}
      {...props.data}
    >
      {props.children}
    </button>
  );
}

// ── THE LABELED-VERB CHIP (issue #4753) ─────────────────────────────────────
//
// The visual form of the one-tap doctrine: a tap carries the usual payload, and the
// chip's LABEL SHOWS THE PAYLOAD THE TAP CARRIES — `Aug 30 · 250 mg` beside a `Log`
// nub, not a bare "Mark taken". That is what retires the "…now"-suffixed verbs on an
// adopted surface: the label already says what will be written, so the verb stops
// having to carry the whole sentence and can be one word.
//
// THE APPLICABILITY TEST, stated so nobody over-applies it: a one-tap that performs a
// WRITE whose payload is summarizable in the label. No label worth showing, or not a
// write, and this is not the chip — selection chips (the `filter` role above),
// navigation (the `nav` role), form submits and destructive actions are all excluded
// by that test rather than by a list.
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
