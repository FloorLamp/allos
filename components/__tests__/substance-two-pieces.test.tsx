import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  updateSubstanceDailyTotalAction: async (fd: FormData) => {
    record("update")(fd);
    return { kind: "updated", id: 4, capProgress: null };
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
  id: 4,
  substance: "nicotine",
  date: FOUND_DAY,
  amount: 3,
  notes: "after lunch",
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
  it("draws the same fields in both modes and differs only in seed and action", async () => {
    openForm();
    const addFields = fieldSignature();
    const addSeed = (
      screen.getByLabelText(/^Amount/) as HTMLInputElement
    ).value;
    await save("Add");
    const added = payload("add");

    cleanup();
    openForm(ROW);
    // THE SEAM. Not "both surfaces render an amount box" — the whole labelled field
    // set, so a field that appears in one mode and not the other reddens this.
    expect(fieldSignature()).toEqual(addFields);
    expect((screen.getByLabelText(/^Amount/) as HTMLInputElement).value).toBe(
      String(ROW.amount)
    );
    expect(addSeed).not.toBe(String(ROW.amount));
    await save("Save");
    const updated = payload("update");

    // Same wire shape, different action and one extra address field: the row's id.
    expect(Object.keys(updated).sort()).toEqual(
      [...Object.keys(added), "id"].sort()
    );
    expect(updated.id).toBe(String(ROW.id));
    expect(added.date).toBe(FOUND_DAY);
    expect(updated.notes).toBe(ROW.notes);
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
    const drinks = screen.getByLabelText(/^Amount/).closest("label")!
      .textContent;
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
    addResult = { kind: "date-conflict" };
    openForm();
    await save("Add");
    expect(toasts).toEqual([]);
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
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
