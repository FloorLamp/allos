// Where a portaled panel goes, relative to the control that opened it (#3271).
//
// Pure — no DOM, no React. The hook (components/overlay/useAnchoredPopover.ts)
// reads the rects and applies the answer; this decides it. Split that way
// because the decisions here are the ones worth pinning: which side the panel
// lands on, how tall it may be there, and how far it may be pushed to stay on
// screen. A browser is a poor place to ask "what happens when nothing fits".
//
// WHY ANY OF THIS EXISTS. A panel left in flow is clipped by any ancestor
// carrying an `overflow`, and z-index does not escape a clip box. Portaling to
// <body> and positioning `fixed` removes the clip — and hands over the whole job
// of staying on screen, which the ancestor used to do badly but did do.

export const ANCHOR_GAP = 4; // the visual gap between control and panel
export const ANCHOR_MARGIN = 8; // keep the panel this far from the viewport edges

export type AnchoredAlign = "start" | "end";

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface AnchoredPosition {
  top: number;
  left: number;
  // Present only when the caller asked to match the anchor's width.
  width?: number;
  // Present only when the caller declared a `preferredMaxHeight` — i.e. the panel
  // scrolls itself and may therefore be shrunk to fit.
  maxHeight?: number;
}

export function anchoredPosition({
  anchor,
  panel,
  viewport,
  align = "start",
  matchAnchorWidth = false,
  preferredMaxHeight,
}: {
  anchor: AnchorRect;
  // The panel as measured. `height` is 0 before its first measurement, which is
  // why a consumer keeps it hidden until then.
  panel: { height: number; width: number };
  viewport: { width: number; height: number };
  align?: AnchoredAlign;
  matchAnchorWidth?: boolean;
  // The height the panel WANTS, for a panel that scrolls itself. Escaping the
  // ancestor's clip is only half the job: a list that then runs off the bottom of
  // the screen is unreachable in a way the clipped one at least hinted at. With
  // this the panel is capped to the room actually available on the side it lands
  // and its own `overflow` scrolls the rest. Omit it and the panel is placed but
  // never capped, which is what a menu and a calendar want.
  preferredMaxHeight?: number;
}): AnchoredPosition {
  const width = matchAnchorWidth ? anchor.width : panel.width;
  const roomBelow =
    viewport.height - anchor.bottom - ANCHOR_GAP - ANCHOR_MARGIN;
  const roomAbove = anchor.top - ANCHOR_GAP - ANCHOR_MARGIN;
  const desired = preferredMaxHeight ?? panel.height;

  // Below by default. Flip up only when it will not fit below AND it does fit
  // above — a flip into an even smaller gap trades one clipped panel for
  // another. An UNCAPPED panel that fits neither side stays below, which is
  // where it has always been; a CAPPED one takes the roomier side, because it
  // will shrink to whichever it lands on either way.
  const above =
    desired > roomBelow &&
    (desired <= roomAbove ||
      (preferredMaxHeight != null && roomAbove > roomBelow));
  const room = above ? roomAbove : roomBelow;
  const maxHeight =
    preferredMaxHeight == null
      ? undefined
      : Math.max(0, Math.min(preferredMaxHeight, room));
  const top = above
    ? anchor.top - ANCHOR_GAP - (maxHeight ?? panel.height)
    : anchor.bottom + ANCHOR_GAP;

  // `start` lines the left edges up, `end` the right ones — then the whole panel
  // is pushed back inside the viewport. The margin wins over the alignment: a
  // panel aligned perfectly to a control that is itself half off-screen is not
  // what anyone asked for.
  const left = Math.max(
    ANCHOR_MARGIN,
    Math.min(
      align === "end" ? anchor.right - width : anchor.left,
      viewport.width - width - ANCHOR_MARGIN
    )
  );

  return {
    top,
    left,
    ...(matchAnchorWidth ? { width } : {}),
    ...(maxHeight == null ? {} : { maxHeight }),
  };
}
