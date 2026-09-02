import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import TimeField from "@/components/TimeField";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import type { TimeFormat } from "@/lib/format-date";

// THE STYLED TIME FIELD (#4218) — what a caller hands in and what it gets back.
//
// `TimeField` is semantics-free by design: canonical 24h "HH:MM" in, canonical
// "HH:MM" (or "" for "no time") out, with the pair rules staying `WhenControl`'s.
// So everything asserted here is one of three things — what the field DISPLAYS
// for a given clock preference, what it EMITS for a given input, and what the
// wheel emits when a row is chosen. Nothing about "now", bounds or requiredness
// belongs to this component and none of it is tested here.
//
// jsdom has no layout and no `matchMedia` beyond the tier's stand-in, which
// answers false to every query — so `useCompactViewport` is false and the picker
// mounts in its DESKTOP host. The sheet presentation and the wheel's real scroll
// physics are a browser claim and live in e2e/anchored-panel-fork.mobile.spec.ts;
// what is here is the value contract, which is the same in both hosts.
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

/** The field under a clock preference, holding its own value like a real form. */
function mount(timeFormat: TimeFormat, initial = "") {
  const emitted: string[] = [];
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat }}>
        <TimeField
          value={value}
          onChange={(next) => {
            emitted.push(next);
            setValue(next);
          }}
          label="Time taken"
          data-testid="tf"
        />
      </FormatPrefsProvider>
    );
  }
  render(<Host />);
  return { emitted, field: () => screen.getByTestId("tf") as HTMLInputElement };
}

const openWheel = () =>
  fireEvent.click(screen.getByRole("button", { name: "Open time picker" }));

const column = (name: string) => screen.getByRole("listbox", { name });

describe("TimeField — typing", () => {
  // EITHER CLOCK IS ACCEPTED, one canonical value is emitted. A profile on 24h
  // that types the 12h form it read on a label should not be told it is wrong,
  // and the wire shape `statedHhmm` speaks is 24h whichever was typed.
  it.each([
    ["19:30", "19:30"],
    ["7:30pm", "19:30"],
    ["7:30 PM", "19:30"],
    ["07:05", "07:05"],
    ["7:05", "07:05"],
    ["12:00am", "00:00"],
    ["12:00pm", "12:00"],
  ])("typing %s emits %s", (typed, canonical) => {
    const { emitted, field } = mount("24h");
    fireEvent.change(field(), { target: { value: typed } });
    expect(emitted.at(-1)).toBe(canonical);
  });

  // CLEARING IS A STATEMENT, not a no-op: empty means "no time stated", and the
  // caller's null branch depends on hearing it.
  it("clearing the field emits empty", () => {
    const { emitted, field } = mount("24h", "19:30");
    fireEvent.change(field(), { target: { value: "" } });
    expect(emitted.at(-1)).toBe("");
  });

  // A HALF-TYPED TIME IS NOT A VALUE. The parent holds only canonical "HH:MM", so
  // "7:3" has nowhere to live there; the field keeps it on screen and emits
  // nothing until it parses. Re-rendering the parent's unmoved value over the
  // typist would delete the character they just pressed.
  it("keeps unparseable text on screen and emits nothing for it", () => {
    const { emitted, field } = mount("24h");
    fireEvent.change(field(), { target: { value: "7:3" } });
    expect(field().value).toBe("7:3");
    expect(emitted).toEqual([]);
    expect(field().validationMessage).not.toBe("");
  });

  // The native input refused a malformed time itself; a text input does not, so
  // the refusal has to be carried explicitly or a form would submit "quarter
  // past" as a time.
  it("clears the validity message once the text parses", () => {
    const { field } = mount("24h");
    fireEvent.change(field(), { target: { value: "quarter past" } });
    expect(field().validationMessage).not.toBe("");
    fireEvent.change(field(), { target: { value: "19:30" } });
    expect(field().validationMessage).toBe("");
  });

  // A PARSED TIME SETTLES INTO THE PROFILE'S OWN CLOCK when the field is left —
  // one typed as "7:30pm" by a 24h profile is shown back as 19:30, because that
  // is what was stored and what every other rendered time on the page says.
  it("settles a parsed entry into the profile's clock on blur", () => {
    const { field } = mount("24h");
    fireEvent.change(field(), { target: { value: "7:30pm" } });
    fireEvent.blur(field());
    expect(field().value).toBe("19:30");
  });
});

describe("TimeField — displaying", () => {
  // ONE STORED VALUE, TWO RENDERS. This is the defect the native input could not
  // fix: `timeFormat` governs every other time in the app and the browser widget
  // followed the OS locale instead, so a 24h profile could be handed AM/PM.
  it.each([
    ["24h" as const, "19:30"],
    ["12h" as const, "7:30 PM"],
  ])("renders 19:30 as %s → %s", (timeFormat, shown) => {
    const { field } = mount(timeFormat, "19:30");
    expect(field().value).toBe(shown);
  });

  it("renders no time as an empty field", () => {
    const { field } = mount("12h", "");
    expect(field().value).toBe("");
  });
});

describe("TimeField — the wheel", () => {
  // TAP A ROW, GET A TIME. The scroll physics are the platform's and are asserted
  // in the browser; what a row IS — a button that composes the whole value from
  // where the other columns rest — is assertable here.
  it("picking an hour and a minute composes the value", () => {
    const { emitted } = mount("24h", "09:15");
    openWheel();
    fireEvent.click(within(column("Hour")).getByRole("option", { name: "07" }));
    expect(emitted.at(-1)).toBe("07:15");
    fireEvent.click(
      within(column("Minute")).getByRole("option", { name: "45" })
    );
    expect(emitted.at(-1)).toBe("07:45");
  });

  // A TAP OUTRANKS A SCROLL STILL IN FLIGHT. The column suppresses its own parking
  // effect while a flick owns the offset, so a row tapped mid-momentum was overwritten
  // ~120ms later by the settle reading the momentum's resting place instead: the finger
  // hit 45 and the field committed 21. The tap is the explicit choice and has to win,
  // or "tap a row selects it" is not true. Found by running dose-history.spec.ts at two
  // workers, where the slower machine let the settle land after the tap.
  //
  // THE FIXTURE REACHES THE FORBIDDEN STATE ON PURPOSE: the scroll is fired FIRST, so a
  // settle is genuinely pending and genuinely disagrees with the tap. Without the fix
  // this reads "09:21" — the assertion can fail, which is the only reason to trust it
  // passing.
  it("a row tapped mid-scroll wins over the settle still pending against it", async () => {
    const { emitted } = mount("24h", "09:15");
    openWheel();
    const minutes = column("Minute");
    minutes.scrollTop = 21 * 44; // a flick resting two dozen rows from the tap
    fireEvent.scroll(minutes);
    fireEvent.click(within(minutes).getByRole("option", { name: "45" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(emitted.at(-1)).toBe("09:45");
  });

  // THE MERIDIEM COLUMN IS THE PREFERENCE'S, not a third opinion about the value:
  // a 12h profile picks 7 + PM and the field still emits the 24h "19:30".
  it("a 12h profile gets a meridiem column that composes 24h", () => {
    const { emitted } = mount("12h", "07:30");
    openWheel();
    expect(column("AM or PM")).toBeTruthy();
    fireEvent.click(
      within(column("AM or PM")).getByRole("option", { name: "PM" })
    );
    expect(emitted.at(-1)).toBe("19:30");
  });

  it("a 24h profile gets no meridiem column", () => {
    mount("24h", "07:30");
    openWheel();
    expect(screen.queryByRole("listbox", { name: "AM or PM" })).toBeNull();
  });

  // AN UNSET WHEEL PROPOSES NOTHING (#2053). It rests at the top of each column
  // and marks no row selected — "the field is empty" is a statement, and a wheel
  // that pre-selected 00:00 would have made it silently.
  it("marks nothing selected while the field has no time", () => {
    mount("24h", "");
    openWheel();
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(0);
  });

  it("marks exactly the value's row in each column once it has one", () => {
    mount("24h", "07:45");
    openWheel();
    for (const [name, expected] of [
      ["Hour", "07"],
      ["Minute", "45"],
    ] as const) {
      const selected = within(column(name))
        .getAllByRole("option")
        .filter((o) => o.getAttribute("aria-selected") === "true");
      expect(selected.map((o) => o.textContent)).toEqual([expected]);
    }
  });

  // WITHOUT A POINTER. A wheel is a scroll surface first, so the keyboard route
  // has to be stated: each column is a listbox that steps on the arrows and jumps
  // on Home/End.
  it("steps the column with the arrow keys and jumps with Home/End", () => {
    const { emitted } = mount("24h", "09:15");
    openWheel();
    fireEvent.keyDown(column("Hour"), { key: "ArrowDown" });
    expect(emitted.at(-1)).toBe("10:15");
    fireEvent.keyDown(column("Hour"), { key: "ArrowUp" });
    expect(emitted.at(-1)).toBe("09:15");
    fireEvent.keyDown(column("Minute"), { key: "End" });
    expect(emitted.at(-1)).toBe("09:59");
    fireEvent.keyDown(column("Minute"), { key: "Home" });
    expect(emitted.at(-1)).toBe("09:00");
  });

  // THE COLUMN'S ENDS ARE ENDS, not a wrap: stepping past 23:00 stays there. A
  // wheel that rolled over would turn one arrow press into a twelve-hour move.
  it("does not wrap past either end of a column", () => {
    const { emitted } = mount("24h", "23:00");
    openWheel();
    fireEvent.keyDown(column("Hour"), { key: "ArrowDown" });
    expect(emitted).toEqual([]);
  });
});
