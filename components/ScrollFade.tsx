"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

// Horizontal scroll container that fades whichever edge has more content
// scrolled past it, hinting there's more to see. The fade is a mask so it's
// theme-agnostic (works on any background, light or dark). Edges only fade
// when actually scrollable in that direction — no clipping when the content
// fits or when scrolled fully to an end.
const FADE = "1.75rem";

export interface ScrollFadeEdges {
  left: boolean;
  right: boolean;
}

// The same fade as a HOOK, for a scroller that must BE the element rather than
// live inside a wrapper (issue #2614). The Trends tab strip is the case: it owns
// `role="tablist"`, its own ref and the scroll-the-selected-tab-into-view effect,
// so wrapping it would separate the tablist from the box that scrolls. One
// implementation, two hosts — never a second hand-rolled gradient.
//
// `data-fade-*` rides along with the mask so the affordance is ASSERTABLE: "this
// row scrolls, and says so" is a measurable claim; a gradient in a screenshot is
// not.
export function useScrollFade(ref: RefObject<HTMLElement | null>): {
  edges: ScrollFadeEdges;
  update: () => void;
  fadeProps: {
    style: CSSProperties | undefined;
    "data-fade-left": "true" | undefined;
    "data-fade-right": "true" | undefined;
  };
} {
  const [edges, setEdges] = useState<ScrollFadeEdges>({
    left: false,
    right: false,
  });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    // Re-measure when the container or its content changes size (window
    // resize, data reflow, late-loading fonts).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [ref, update]);

  const mask =
    edges.left && edges.right
      ? `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`
      : edges.left
        ? `linear-gradient(to right, transparent, #000 ${FADE})`
        : edges.right
          ? `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`
          : undefined;

  return {
    edges,
    update,
    fadeProps: {
      style: mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined,
      "data-fade-left": edges.left ? "true" : undefined,
      "data-fade-right": edges.right ? "true" : undefined,
    },
  };
}

export default function ScrollFade({
  children,
  className,
  hideScrollbar = false,
  "data-testid": testId,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  hideScrollbar?: boolean;
  "data-testid"?: string;
  // SEMANTICS BELONG ON THE SCROLLER, not on a wrapper around it (#3408). A
  // control group that IS the scrolling row — the filter pill strip — must carry
  // its own `role`/`aria-label`, and splitting them onto an outer div would put
  // the accessible name on one element and the `data-fade-*` affordance markers
  // on another, so a spec could no longer ask one locator both questions. The
  // hook half of this file (`useScrollFade`) exists for the cases where the
  // scroller must be a DIFFERENT element entirely; this is the cheaper case, so
  // it stays here.
  //
  // Deliberately NOT a `...React.HTMLAttributes<HTMLDivElement>` spread: this
  // element owns its `ref`, its `onScroll`, its `className` and its `style` (the
  // mask), and letting a caller pass any of those in would silently defeat the
  // fade. The narrow list is the point.
} & Pick<React.HTMLAttributes<HTMLDivElement>, "role" | "aria-label"> & {
    [key: `data-${string}`]: string | undefined;
  }) {
  const ref = useRef<HTMLDivElement>(null);
  const { update, fadeProps } = useScrollFade(ref);

  return (
    <div
      ref={ref}
      onScroll={update}
      data-testid={testId}
      className={`overflow-x-auto ${hideScrollbar ? "scrollbar-none [&::-webkit-scrollbar]:hidden" : ""} ${className ?? ""}`}
      {...rest}
      {...fadeProps}
    >
      {children}
    </div>
  );
}
