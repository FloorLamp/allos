import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabeledVerbChip } from "@/components/Chip";
import OfferRow from "@/components/OfferRow";

// The primitive's four claims (#4753): the label carries the payload, the whole pill
// is ONE control-box target, the verb nub is not a second tab stop, and the clock door
// renders in its seat only when an adopter passes one.

function mount(props: Partial<Parameters<typeof LabeledVerbChip>[0]> = {}) {
  const onAct = vi.fn();
  render(
    <LabeledVerbChip
      label="Aug 30 · 250 mg"
      verb="Log"
      tone="neutral"
      onAct={onAct}
      {...props}
    />
  );
  return { onAct };
}

describe("LabeledVerbChip", () => {
  it("is one pressable box wearing the chip control box, label then verb", () => {
    mount();
    const pills = screen.getAllByRole("button");
    expect(pills).toHaveLength(1);
    const pill = pills[0]!;
    // The name a reader hears is the payload AND the verb, composed from the pill's
    // own text — no aria-label restates it, so the two cannot drift apart.
    expect(pill.textContent).toBe("Aug 30 · 250 mgLog");
    expect(pill.getAttribute("aria-label")).toBeNull();
    expect(pill.className).toBe("chip-base chip-offer");
    fireEvent.click(pill);
  });

  it("reports the tap once from anywhere in the pill, label included", () => {
    const { onAct } = mount();
    fireEvent.click(screen.getByText("Aug 30 · 250 mg"));
    expect(onAct).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Tone is DECLARED, and the verb nub is where it lands (#4548's ruling).
    ["brand", "bg-brand-600"],
    ["neutral", "bg-slate-200"],
  ] as const)("paints a %s verb from the offer substrate", (tone, fill) => {
    mount({ tone });
    expect(screen.getByText("Log").className).toContain(fill);
  });

  it.each([
    // [clock door passed, seats rendered]
    [undefined, 0],
    [<span key="door" data-testid="door" />, 1],
  ])("renders the clock door only in its seat (%#)", (door, seats) => {
    mount({ clockDoor: door });
    expect(screen.queryAllByTestId("door")).toHaveLength(seats);
    // And nothing else joins the tab sequence: the nub is a span, and a seated door
    // is the adopter's own control rather than a second half of this one.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the whole pill one tab stop with the verb inside it", () => {
    mount();
    const pill = screen.getByRole("button");
    const verb = screen.getByText("Log");
    expect(pill.contains(verb)).toBe(true);
    expect(verb.tagName).toBe("SPAN");
    expect(verb.getAttribute("tabindex")).toBeNull();
  });
});

describe("OfferRow", () => {
  it.each([
    ["brand", "bg-brand-50/60"],
    ["neutral", "bg-surface"],
  ] as const)("declares its %s tone and keeps the caller's margin", (tone, fill) => {
    const onAct = vi.fn();
    render(
      <OfferRow tone={tone} onAct={onAct} testId="offer" className="mb-3">
        Your usual Morning (3)
      </OfferRow>
    );
    const row = screen.getByTestId("offer");
    expect(row.className).toContain(fill);
    expect(row.className).toContain("mb-3");
    fireEvent.click(row);
    expect(onAct).toHaveBeenCalledTimes(1);
  });
});
