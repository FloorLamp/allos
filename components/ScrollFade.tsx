"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Horizontal scroll container that fades whichever edge has more content
// scrolled past it, hinting there's more to see. The fade is a mask so it's
// theme-agnostic (works on any background, light or dark). Edges only fade
// when actually scrollable in that direction — no clipping when the content
// fits or when scrolled fully to an end.
const FADE = "1.75rem";

export default function ScrollFade({
  children,
  className,
  hideScrollbar = false,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  className?: string;
  hideScrollbar?: boolean;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

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
  }, [update]);

  const mask =
    edges.left && edges.right
      ? `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`
      : edges.left
        ? `linear-gradient(to right, transparent, #000 ${FADE})`
        : edges.right
          ? `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`
          : undefined;

  return (
    <div
      ref={ref}
      onScroll={update}
      data-testid={testId}
      className={`overflow-x-auto ${hideScrollbar ? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""} ${className ?? ""}`}
      style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}
