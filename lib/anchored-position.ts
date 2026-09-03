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
  // How tall the panel may be on the side it landed. ALWAYS present (#4776): a
  // consumer that does not apply it is not opting out of a constraint, it simply
  // does not know there was one, and the panel then runs off the screen edge —
  // which is where confirm and cancel live.
  maxHeight: number;
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
  // A cap the panel wants for its OWN sake, tighter than the room: a listbox that
  // should stop at eight rows on a tall screen rather than growing to fill it.
  // Omit it and the panel simply takes the room, which is what a menu and a
  // calendar want — never more than the room, either way.
  preferredMaxHeight?: number;
}): AnchoredPosition {
  const width = matchAnchorWidth ? anchor.width : panel.width;
  const roomBelow =
    viewport.height - anchor.bottom - ANCHOR_GAP - ANCHOR_MARGIN;
  const roomAbove = anchor.top - ANCHOR_GAP - ANCHOR_MARGIN;
  const desired = preferredMaxHeight ?? panel.height;

  // Below by default; flip up when it will not fit below and there is more room
  // above. Every panel is now capped to the side it lands on and scrolls the
  // rest, so the roomier side is strictly better — the old rule kept an UNCAPPED
  // panel below when it fit neither side, on the reasoning that flipping only
  // moved the overflow, and that reasoning ended when the overflow did (#4776).
  const above = desired > roomBelow && roomAbove > roomBelow;
  const room = Math.max(0, above ? roomAbove : roomBelow);
  const maxHeight = Math.min(preferredMaxHeight ?? room, room);
  // An above-placed panel is positioned from the height it will ACTUALLY take,
  // so its bottom edge lands against the anchor rather than a gap below it.
  const top = above
    ? anchor.top - ANCHOR_GAP - Math.min(desired, room)
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
    maxHeight,
  };
}
