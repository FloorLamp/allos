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

function Panel({
  options,
  onEscape,
}: {
  options: string[];
  onEscape: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useFocusTrap({ panelRef, onClose: onEscape });
  return (
    <div ref={panelRef} role="dialog" aria-label="Panel">
      <Combobox
        value={value}
        onChange={setValue}
        options={options}
        allowFreeText
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
      render(<Panel options={options} onEscape={escaped} />);
      fireEvent.focus(field());
      press();
      expect(escaped).toHaveBeenCalledTimes(reaches ? 1 : 0);
    }
  );

  it("a picker with a list still spends the first press on it, and the second reaches the panel", () => {
    // The half that must NOT change: a list a person can see gets dismissed on its own
    // press, so opening one by mistake never costs them the form (#3409/#3417).
    const escaped = vi.fn();
    render(<Panel options={["Creatine"]} onEscape={escaped} />);
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
    // owns the first press. Collapsing that one is the ruling's other half.
    const escaped = vi.fn();
    render(<Panel options={[]} onEscape={escaped} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "Zinc" } });
    press();
    expect(escaped).not.toHaveBeenCalled();
    expect((field() as HTMLInputElement).value).toBe("Zinc");
  });
});
