import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import Combobox from "@/components/Combobox";
import { useFocusTrap } from "@/components/useFocusTrap";

// #3432. A combobox inside a trapped panel claimed the Escape layer whenever the FIELD
// thought it was open, including when there was no listbox to close — an allowFreeText
// picker whose vocabulary is empty and whose value is still blank, which is #3100's
// stack field for anyone who has never named a stack. The press was swallowed with
// nothing on screen to show for it, which is what a dismissed keypress always looks
// like, and the panel took a second press to close.
//
// COUNTED THROUGH A REAL TRAP, NOT READ OFF THE MARKER. The marker is what looked
// decisive when this was tried and reverted on #3426, and it was not: `useFocusTrap`
// yields to ANY marked descendant, so a second marker over the same panel makes the
// attribute irrelevant. Only the press count says what a person gets.

// The listbox is portaled through the shared anchored popover, which observes the
// document on mount. jsdom ships no ResizeObserver — the same stand-in eight sibling
// files in this tier already install.
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

// AnalyzePicker's shape: `options` are opaque identities and `labelFor` renders the
// human text, so the field's VALUE is never one of the options. Harmless for every other
// row here — their options are not in this map, so they render as themselves.
const LABEL_FOR: Record<string, string> = {
  "entity:0": "Cycling",
  "entity:1": "Curl",
};

function Panel({
  options,
  onEscape,
  allowFreeText,
  initial = "",
}: {
  options: string[];
  onEscape: () => void;
  allowFreeText: boolean;
  initial?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initial);
  useFocusTrap({ panelRef, onClose: onEscape });
  return (
    <div ref={panelRef} role="dialog" aria-label="Panel">
      <Combobox
        value={value}
        onChange={setValue}
        options={options}
        allowFreeText={allowFreeText}
        labelFor={(option) => LABEL_FOR[option] ?? option}
        ariaLabel="Item"
      />
    </div>
  );
}

const field = () => screen.getByLabelText("Item");
const press = () => fireEvent.keyDown(field(), { key: "Escape" });

// The two states differ only in whether there is a LIST — the field is `open` in both,
// which is exactly what the old marker could not tell apart.
describe("a picker only claims the Escape layer while it has a list to close", () => {
  it.each([
    { list: "no rows and no draft to offer", options: [], reaches: true },
    { list: "rows to show", options: ["Creatine"], reaches: false },
  ])(
    "with $list, the FIRST press reaches the panel: $reaches",
    ({ options, reaches }) => {
      const escaped = vi.fn();
      render(<Panel options={options} onEscape={escaped} allowFreeText />);
      fireEvent.focus(field());
      press();
      expect(escaped).toHaveBeenCalledTimes(reaches ? 1 : 0);
    }
  );

  it("a picker with a list still spends the first press on it, and the second reaches the panel", () => {
    // The half that must NOT change: a list a person can see gets dismissed on its own
    // press, so opening one by mistake never costs them the form (#3409/#3417).
    const escaped = vi.fn();
    render(<Panel options={["Creatine"]} onEscape={escaped} allowFreeText />);
    fireEvent.focus(field());
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);

    press();
    expect(escaped).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    press();
    expect(escaped).toHaveBeenCalledTimes(1);
  });

  it("a draft that renders a row keeps its press — typing is what reopens the list", () => {
    // The main #3432 case, unchanged by the marker: after typing there IS a list, so it
    // owns the first press. What that press does to the draft is the table below.
    const escaped = vi.fn();
    render(<Panel options={[]} onEscape={escaped} allowFreeText />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "Zinc" } });
    press();
    expect(escaped).not.toHaveBeenCalled();
    expect((field() as HTMLInputElement).value).toBe("Zinc");
  });
});

// #3432 SECOND HALF, PINNED AS TODAY'S BEHAVIOUR RATHER THAN AS THE RULING. The ruling
// (2026-09-02) drops the typed draft on this same press, restricted to pickers WITHOUT
// `allowFreeText` — "where the typed text cannot be the value". That restriction does not
// separate those two populations here: the flag decides whether a "Use '<query>'" ROW is
// offered, not whether the caller keeps what was typed. The two rows below the first are
// the shipped counterexamples, and they are the reason the drop is not built — so the
// next attempt reads them here instead of re-deriving them.
describe("Escape closes the list and leaves the field's text alone", () => {
  it.each([
    // The free-text case the eight shipped specs already assert (they read the typed
    // entry back on the line after the press).
    {
      picker: "a free-text picker holding a typed draft",
      free: true,
      options: ["Creatine"],
      initial: "",
      typed: "Zinc",
      kept: "Zinc",
    },
    // GenomicVariantForm's Gene field: no `allowFreeText`, a ten-symbol catalog, and an
    // empty state that reads "Not a pharmacogenomic gene — type any symbol". The typed
    // symbol IS the value and posts under `name="gene"`.
    {
      picker: "a catalog picker whose empty state invites any symbol",
      free: false,
      options: ["CYP2C19", "CYP2D6"],
      initial: "",
      typed: "BRCA1",
      kept: "BRCA1",
    },
    // AnalyzePicker's title: identity options, human labels, and NOTHING TYPED. Its value
    // matches no option in any state, so a rule keyed on "the value is not an option"
    // blanks the analyze page's heading on the bare Escape that #3432 exists to make good.
    {
      picker: "identity options under human labels, with nothing typed",
      free: false,
      options: Object.keys(LABEL_FOR),
      initial: "Cycling",
      typed: null,
      kept: "Cycling",
    },
  ])(
    '$picker: the field still reads "$kept" afterwards',
    ({ free, options, initial, typed, kept }) => {
      const escaped = vi.fn();
      render(
        <Panel
          options={options}
          onEscape={escaped}
          allowFreeText={free}
          initial={initial}
        />
      );
      fireEvent.focus(field());
      if (typed !== null)
        fireEvent.change(field(), { target: { value: typed } });

      press();
      expect(escaped).not.toHaveBeenCalled();
      expect((field() as HTMLInputElement).value).toBe(kept);

      // Two presses, not three — the first half's collapse stands in every row here.
      press();
      expect(escaped).toHaveBeenCalledTimes(1);
    }
  );
});
