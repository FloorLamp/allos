import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SubstanceForm from "@/components/substances/SubstanceForm";
import SubstanceUnitControl from "@/components/substances/SubstanceUnitControl";
import QuickSubstanceList from "@/components/quick-entry/QuickSubstanceList";
import { substanceDef } from "@/lib/substance-use";

// THE SUBSTANCE DOMAIN'S TWO PIECES (#4424, `LOG_MANIFEST.substance.pieces`).
//
// The manifest cell flips on two claims, and each is asserted here as a RELATIONSHIP
// rather than as a rendered literal, because a literal would go stale the day the copy
// moves and would say nothing about the property:
//
//   • ONE FORM for add and full-statement edit — asserted at the SEAM (same component,
//     same field set, differing only in seed and action) rather than by rendering two
//     surfaces and observing they happen to agree today;
//   • the amount NAMES ITS UNIT — asserted against `substanceDef(key).unitPlural`, so
//     deleting the unit from the label reddens this whatever the wording becomes, and
//     two substances with different unit words cannot share one label.
//
// The cap verdict's reach is asserted at both of its surfaces: the tap surface through
// the row control the record's card and the quick-log sheet both mount, and the FORM
// surfaces — which had no readout at all — through what a save announces.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};
let addResult: { kind: string; id?: number; capProgress?: string | null } = {
  kind: "added",
  id: 1,
  capProgress: null,
};
let logResult: { ok: boolean; weekCount?: number; error?: string } = {
  ok: true,
  weekCount: 3,
};

vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  addSubstanceDailyTotalAction: async (fd: FormData) => {
    record("add")(fd);
    return addResult;
  },
  correctSubstanceUseAction: async (fd: FormData) => {
    record("update")(fd);
    return { kind: "updated", eventId: 4, date: "2026-08-18" };
  },
  logSubstanceUnitAction: async (fd: FormData) => {
    record("log")(fd);
    return logResult;
  },
  undoSubstanceUnitAction: async (fd: FormData) => {
    record("undo")(fd);
    return logResult;
  },
}));

const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));

const TODAY = "2026-08-20";
const FOUND_DAY = "2026-08-18";
const ROW = {
  eventId: 4,
  substance: "nicotine",
  date: FOUND_DAY,
  statedAt: `${FOUND_DAY}T13:15:00.000Z`,
};

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
  addResult = { kind: "added", id: 1, capProgress: null };
  logResult = { ok: true, weekCount: 3 };
  cleanup();
});

function openForm(row?: typeof ROW, substance = "nicotine"): void {
  render(
    <SubstanceForm
      substances={[{ key: substance, label: substanceDef(substance).label }]}
      date={FOUND_DAY}
      maxDate={TODAY}
      row={row}
      onSaved={() => {}}
      onCancel={() => {}}
    />
  );
}

/** Every labelled control the form draws, by its LABEL. The field SIGNATURE.
 *  Text nodes only: a textarea's seeded value is part of its label's textContent, and
 *  the signature is about which fields exist, not about what is in them. */
function fieldSignature(): string[] {
  return [...document.querySelectorAll<HTMLElement>("input, select, textarea")]
    .map((el) => {
      const label = el.closest("label");
      if (!label) return el.tagName;
      return [...label.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
    })
    .sort();
}

function payload(action: string): Record<string, string> {
  const all = posted[action] ?? [];
  expect(all, `${action} was handed ${all.length} payloads`).toHaveLength(1);
  return Object.fromEntries(
    [...all[0].entries()].map(([k, v]) => [k, String(v)])
  );
}

async function save(label: string): Promise<void> {
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: label }))
  );
}

describe("SubstanceForm is ONE form for add and for edit", () => {
  // ONE FORM, TWO SUBJECTS (#4424 ruling 1, narrowed by #5026 phase 2). The seam is no
  // longer "the same field set in both modes": a correction addresses ONE USE, so the
  // day's amount and the day's note are not on it — restating either would be the day
  // form coming back through the edit door. What both modes DO share is the layout,
  // the When control and the day, and that is what this asserts, in both directions:
  // the fields edit mode drops, and the fields it must keep.
  it("keeps the When control in both modes and drops the day's own fields from edit", async () => {
    openForm();
    const addFields = fieldSignature();
    expect(addFields).toEqual(expect.arrayContaining(["Notes"]));
    expect(screen.getByLabelText(/^Amount/)).toBeTruthy();
    await save("Add");
    const added = payload("add");

    cleanup();
    openForm(ROW);
    expect(screen.queryByLabelText(/^Amount/)).toBeNull();
    expect(screen.queryByLabelText(/^Notes/)).toBeNull();
    // …and the day is still asked for, through the same control, seeded from the row.
    // The field renders a DISPLAY date, so the pin is on what gets POSTED below.
    expect(document.querySelector("#substance-when-date")).toBeTruthy();
    await save("Save");
    const updated = payload("update");

    // The correction's wire shape: the event's address and the pair it may move.
    expect(Object.keys(updated).sort()).toEqual([
      "date",
      "event_id",
      "logged_via",
      "stated_at",
    ]);
    expect(updated.event_id).toBe(String(ROW.eventId));
    expect(updated.date).toBe(FOUND_DAY);
    expect(added.date).toBe(FOUND_DAY);
  });

  it("carries the SUBJECT when the mount names one, and nothing when it does not", async () => {
    openForm(ROW);
    expect(payload).toBeTruthy();
    await save("Save");
    expect(payload("update").profile_id).toBeUndefined();

    cleanup();
    render(
      <SubstanceForm
        substances={[{ key: "nicotine", label: "Nicotine" }]}
        date={FOUND_DAY}
        maxDate={TODAY}
        row={ROW}
        subjectProfileId={7}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    );
    await save("Save");
    expect(posted.update).toHaveLength(2);
    expect(String(posted.update[1].get("profile_id"))).toBe("7");
  });

  // #4211's "unlabeled substance amounts", absorbed by #4424 and satisfied by deleting
  // the copy that lacked the label. Bound to the catalog's own word, so the assertion
  // cannot be satisfied by a hardcoded string that later stops matching the substance.
  it.each(["alcohol", "nicotine", "cannabis"])(
    "labels the amount with %s's own unit word",
    (key) => {
      openForm(undefined, key);
      const label = screen
        .getByLabelText(new RegExp("^Amount"))
        .closest("label")!.textContent!;
      expect(label).toContain(substanceDef(key).unitPlural);
    }
  );

  it("gives two substances with different unit words two different labels", () => {
    openForm(undefined, "alcohol");
    const drinks = screen
      .getByLabelText(/^Amount/)
      .closest("label")!.textContent;
    cleanup();
    openForm(undefined, "nicotine");
    const uses = screen.getByLabelText(/^Amount/).closest("label")!.textContent;
    expect(substanceDef("alcohol").unitPlural).not.toBe(
      substanceDef("nicotine").unitPlural
    );
    expect(drinks).not.toBe(uses);
  });

  // THE CAP VERDICT REACHES THE FORM SURFACES (#998/#3279). Before this leg the
  // verdict rendered only beside the tap, so a correction made on the record could
  // take somebody past their weekly cap in silence.
  it("announces the cap verdict the write produced, and nothing when there is no cap", async () => {
    addResult = { kind: "added", id: 1, capProgress: "8 of 7 this week." };
    openForm();
    await save("Add");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("8 of 7 this week.");

    cleanup();
    toasts.length = 0;
    addResult = { kind: "added", id: 2, capProgress: null };
    openForm();
    await save("Add");
    expect(toasts).toEqual(["Added to the record."]);
  });

  it("reports a refusal instead of announcing a save that did not happen", async () => {
    addResult = { kind: "invalid-amount" };
    openForm();
    await save("Add");
    expect(toasts).toEqual([]);
    expect(screen.getByRole("alert").textContent).toMatch(/Enter an amount/i);
  });
});

describe("SubstanceUnitControl is ONE row control", () => {
  function control(capProgress: string | null, weekCount?: number) {
    render(
      <SubstanceUnitControl
        substance="nicotine"
        weekCount={weekCount}
        capProgress={capProgress}
        testIdPrefix="substance"
      />
    );
  }

  it("offers BOTH taps, and both post the substance through the shared actions", async () => {
    control("2 of 7 this week.", 2);
    await act(async () =>
      fireEvent.click(screen.getByTestId("substance-log-nicotine"))
    );
    expect(payload("log").substance).toBe("nicotine");
    await act(async () =>
      fireEvent.click(screen.getByTestId("substance-undo-nicotine"))
    );
    expect(payload("undo").substance).toBe("nicotine");
  });

  it("renders the cap verdict beside the tap, and NOTHING for a profile with no cap", () => {
    control("2 of 7 this week.", 2);
    expect(
      screen.getByTestId("substance-cap-progress-nicotine").textContent
    ).toBe("2 of 7 this week.");
    cleanup();
    control(null, 2);
    // The absence of a cap is not an empty cap: no line, no dash, no placeholder.
    expect(screen.queryByTestId("substance-cap-progress-nicotine")).toBeNull();
  });

  it("says why a refused tap was refused rather than looking as if it landed", async () => {
    logResult = { ok: false, error: "Couldn't log that." };
    control(null, 2);
    await act(async () =>
      fireEvent.click(screen.getByTestId("substance-log-nicotine"))
    );
    expect(screen.getByRole("alert").textContent).toBe("Couldn't log that.");
  });

  // THE REACH, at the sheet. The record's card is driven by e2e/substance-use.spec.ts;
  // this is the surface the cap line had to keep on the way through the convergence,
  // and the one that gained the undo it used to send people to another page for.
  it("is what the quick-log sheet's row mounts, cap line and both taps", () => {
    render(
      <QuickSubstanceList
        substances={[
          {
            key: "nicotine",
            label: "Nicotine",
            logLabel: "Log a use",
            capProgress: "2 of 7 this week.",
          },
        ]}
      />
    );
    expect(
      screen.getByTestId("quick-entry-substance-cap-progress-nicotine")
        .textContent
    ).toBe("2 of 7 this week.");
    expect(
      screen.getByTestId("quick-entry-substance-log-nicotine")
    ).toBeTruthy();
    expect(
      screen.getByTestId("quick-entry-substance-undo-nicotine")
    ).toBeTruthy();
  });
});

// EVERY SUBSTANCE MAY STATE A TIME (#3295 phase 1, widened by #5026 phase 2). A time
// was offered on the ADD door for the food-log ledger alone, because
// `substance_daily_totals` had nowhere to put an instant and a control that collects a
// value the store must throw away is worse than no control. Both ledgers hold one now,
// so the offer is unconditional — and the CORRECTION door has it too, which is the
// whole of what "a use is a thing that happened at a time" buys somebody who mistyped.
describe("the substance doors state a use's minute", () => {
  const timeField = () => document.querySelector("#substance-when-time");

  it.each([
    ["alcohol", undefined],
    ["nicotine", undefined],
    ["cannabis", undefined],
    ["Kratom", undefined],
    ["nicotine", ROW],
  ] as const)("%s (row seeded: %o) offers a time", (substance, row) => {
    openForm(row && { ...row, substance }, substance);
    expect(timeField()).toBeTruthy();
    // The day is asked for beside it — the control owns the PAIR, so offering a time
    // must not lose the date.
    expect(document.querySelector("#substance-when-date")).toBeTruthy();
  });

  it("seeds the correction from the row's own stated minute", () => {
    openForm(ROW);
    // Non-empty and not the placeholder: the exact wall clock depends on the runner's
    // zone, so what is pinned is that the row's instant reached the field at all — a
    // form that dropped it would open empty and clear the time on the next save.
    expect((timeField() as HTMLInputElement).value).toMatch(/^\d{2}:\d{2}$/);
  });

  it.each(["alcohol", "nicotine"])(
    "%s posts the stated instant it collected, and an empty one when untouched",
    async (substance) => {
      openForm(undefined, substance);
      await save("Add");
      // ALWAYS POSTED, EVEN EMPTY: absent means "leave it alone" to the correction
      // action, so a form that omitted the field could never clear a stated time.
      expect(payload("add").stated_at).toBe("");
      expect(payload("add").date).toBe(FOUND_DAY);

      cleanup();
      openForm(undefined, substance);
      await act(async () =>
        fireEvent.change(timeField() as HTMLInputElement, {
          target: { value: "21:30" },
        })
      );
      await save("Add");
      // The instant's profile-local day IS the entry's date, which is what the shared
      // control's pair rule guarantees and the action re-checks.
      const timed = posted.add[1];
      expect(String(timed.get("stated_at"))).toContain(FOUND_DAY);
      expect(String(timed.get("date"))).toBe(FOUND_DAY);
    }
  );
});
