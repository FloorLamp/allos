import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeReceipt from "@/components/home/HomeReceipt";

// THE RECEIPT IS A CLAIM ABOUT ONE ROW AT A TIME (#5899).
//
// `HomeReceipt` marks the row a write just landed on and unmarks it 2s later. The
// defect was in the UNMARKING: the effect's cleanup cancelled the pending timer but
// left the classes on the row it had marked, so two writes inside the window — two
// due doses taken back to back — left the FIRST row wearing "just written" until a
// full page reload.
//
// WHAT IS ASSERTED IS THE ROW'S OWN CLASS LIST, NOT THE CLASSES THE COMPONENT PICKS:
// each row is seeded with a base class and the claim is that a superseded row is back
// to exactly that. A test naming `bg-(--accent-soft)` would be testing the source's
// wording, and would still pass if the highlight were left behind under another name.
//
// The timers are fake because the whole defect lives inside the 2s window: the second
// write has to arrive while the first row's removal is still pending, which is the one
// ordering a real clock cannot be asked for.

function seedRow(id: string): HTMLElement {
  const row = document.createElement("li");
  row.id = id;
  row.className = "base";
  document.body.append(row);
  return row;
}

describe("HomeReceipt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom implements no scrollIntoView, and the component calls it before it
    // marks the row — without this stand-in every case below throws first.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error -- removing the stand-in restores jsdom's own (absent) member.
    delete Element.prototype.scrollIntoView;
  });

  it("moves the highlight to the newest row when a second write lands inside the window", () => {
    const first = seedRow("row-1");
    const second = seedRow("row-2");
    // The first render is the baseline, not a write: nothing is marked by it.
    const { rerender } = render(<HomeReceipt rowId="row-0" />);
    expect(first.className, "before any write").toBe("base");

    rerender(<HomeReceipt rowId="row-1" />);
    // THE POSITIVE CONTROL. Without this a harness that never marked anything would
    // satisfy the absence claim below for the wrong reason.
    expect(first.className, "the first write is marked").not.toBe("base");

    vi.advanceTimersByTime(500);
    rerender(<HomeReceipt rowId="row-2" />);

    expect(second.className, "the second write is marked").not.toBe("base");
    expect(
      first.className,
      "the superseded row stops claiming it was just written"
    ).toBe("base");
  });

  it("clears the highlight once the window passes", () => {
    const row = seedRow("row-1");
    const { rerender } = render(<HomeReceipt rowId="row-0" />);
    rerender(<HomeReceipt rowId="row-1" />);
    expect(row.className).not.toBe("base");

    vi.advanceTimersByTime(2000);

    expect(row.className, "the only write's highlight expires").toBe("base");
  });
});
