import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Stepper from "@/components/Stepper";

// The extraction's claims (#4542): one glyph pair, one button box, and a decrement
// that can be stopped at a floor without taking the increment with it.

function mount(props: Partial<Parameters<typeof Stepper>[0]> = {}) {
  const onStep = vi.fn();
  render(
    <Stepper
      onStep={onStep}
      decreaseLabel="Down"
      increaseLabel="Up"
      testId="control"
      {...props}
    />
  );
  return {
    onStep,
    down: screen.getByLabelText("Down"),
    up: screen.getByLabelText("Up"),
  };
}

describe("Stepper", () => {
  it.each([
    ["Down", -1],
    ["Up", 1],
  ] as const)("%s reports its direction to the caller", (label, direction) => {
    const { onStep } = mount();
    fireEvent.click(screen.getByLabelText(label));
    expect(onStep).toHaveBeenCalledWith(direction);
  });

  it("draws one glyph pair at the activity form's pinned button box", () => {
    const { down, up } = mount();
    expect([down.textContent, up.textContent]).toEqual(["−", "+"]);
    for (const box of ["h-11", "w-11", "sm:h-9", "sm:w-7"]) {
      expect(down.className).toContain(box);
      expect(up.className).toContain(box);
    }
  });

  it.each([
    // [props, down disabled, up disabled]
    [{}, false, false],
    [{ decreaseDisabled: true }, true, false],
    [{ disabled: true }, true, true],
  ] as const)("%o disables what it says and nothing else", (props, d, u) => {
    const { down, up } = mount(props);
    expect((down as HTMLButtonElement).disabled).toBe(d);
    expect((up as HTMLButtonElement).disabled).toBe(u);
  });

  it.each([
    // The buttons leave the tab sequence where the value itself is the tab stop
    // (#3335), and stay in it where they are the only way to act.
    [false, -1],
    [true, 0],
  ] as const)(
    "tabStops=%s puts the buttons at tabIndex %i",
    (tabStops, index) => {
      const { down, up } = mount({ tabStops });
      expect([down.tabIndex, up.tabIndex]).toEqual([index, index]);
    }
  );

  it("puts the caller's middle slot between the two buttons", () => {
    render(
      <Stepper
        onStep={vi.fn()}
        decreaseLabel="Less"
        increaseLabel="More"
        testId="framed"
      >
        <input aria-label="Minutes" />
      </Stepper>
    );
    const children = [...screen.getByTestId("framed").children];
    expect(children.map((c) => c.tagName)).toEqual([
      "BUTTON",
      "INPUT",
      "BUTTON",
    ]);
  });
});
