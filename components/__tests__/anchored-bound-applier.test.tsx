import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import Combobox from "@/components/Combobox";
import { ANCHOR_GAP, ANCHOR_MARGIN } from "@/lib/anchored-position";

// ONE BOUND, ONE APPLIER (#4887). Two components portal an anchored surface — the
// shared panel and the combobox listbox — and #4887 ruled they stay two, because a
// listbox that forked to a bottom sheet below `md` would stop being a field's
// dropdown. What they must NOT do is each decide separately how much of the
// positioner's answer to wear: `maxHeight` is required (#4776) precisely because a
// consumer applying only the coordinates is not opting out of a bound, it does not
// know there was one.
//
// So this counts what actually reaches the DOM, through the same query for both,
// and it is a RELATIONSHIP rather than two pinned numbers: the panel declares no
// preference and must therefore take the whole room, and the listbox declares one
// and must therefore land strictly inside it. A shared constant applied to both, or
// either surface dropping the style, breaks a different half of that.
//
// jsdom gives every rect zeros, so the anchor sits at the viewport's top edge and
// the room below is the whole viewport less the gap and the margin. No matchMedia
// here, so `useCompactViewport` answers false and both surfaces render their
// desktop, portaled branch — the only one with a bound to apply.
const ROOM = window.innerHeight - ANCHOR_GAP - ANCHOR_MARGIN;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

function PanelHarness() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        data-testid="open"
        onClick={() => setOpen(true)}
      >
        Open
      </button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Panel"
        testId="bound-panel"
      >
        {() => <p>Body</p>}
      </AnchoredPanel>
    </>
  );
}

function ComboboxHarness() {
  const [value, setValue] = useState("");
  return (
    <Combobox
      value={value}
      onChange={setValue}
      options={["Creatine"]}
      ariaLabel="Item"
    />
  );
}

const SURFACES = [
  {
    what: "the anchored panel, which declares no preference",
    node: <PanelHarness />,
    open: () => fireEvent.click(screen.getByTestId("open")),
    selector: '[data-anchored-panel="popover"]',
    takesTheWholeRoom: true,
  },
  {
    what: "the combobox listbox, which prefers a short list",
    node: <ComboboxHarness />,
    open: () => fireEvent.focus(screen.getByLabelText("Item")),
    selector: '[role="listbox"]',
    takesTheWholeRoom: false,
  },
] as const;

describe("a portaled anchored surface wears the bound the positioner reported", () => {
  it.each(SURFACES)(
    "$what caps itself against the room",
    ({ node, open, selector, takesTheWholeRoom }) => {
      render(node);
      open();
      const surface = document.body.querySelector<HTMLElement>(selector);
      expect(surface).toBeTruthy();
      expect(surface!.parentElement).toBe(document.body);

      const bound = Number.parseFloat(surface!.style.maxHeight);
      expect(Number.isFinite(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
      if (takesTheWholeRoom) expect(bound).toBe(ROOM);
      else expect(bound).toBeLessThan(ROOM);
    }
  );
});
