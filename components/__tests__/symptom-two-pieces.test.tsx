import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SymptomForm from "@/components/illness/SymptomForm";
import SymptomRowControl from "@/components/illness/SymptomRowControl";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";

// THE SYMPTOM DOMAIN'S TWO PIECES (#4424, `LOG_MANIFEST.symptom.pieces`).
//
// Each cell flips on a claim, and each is asserted as a RELATIONSHIP rather than as a
// rendered literal — a literal goes stale the day the copy moves and says nothing about
// the property:
//
//   • ONE FORM for add and full-statement edit — asserted at the SEAM (same component,
//     same field set, differing only in seed and action) rather than by rendering two
//     surfaces and observing they happen to agree today;
//   • the picker collapses on the CHOICE LIST and not on the mode, which is what makes
//     that seam assertable at all;
//   • ONE ROW CONTROL whose taps route by the relationship between the chip and the
//     day's current severity — raise through the log core, lower through the narrow
//     one — never by which chip was pressed;
//   • ONE SUBJECT SPELLING on every write either piece makes. The retired name is
//     asserted ABSENT, because the defect was posting BOTH.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};
let removeResult: { ok: boolean; undoId?: number | null; error?: string } = {
  ok: true,
  undoId: 9,
};
// The staged mapping the text-intake mock answers with, when a test sets one.
let staged: unknown = null;

vi.mock("@/app/(app)/symptom-actions", () => ({
  logSymptom: async (fd: FormData) => {
    record("log")(fd);
    return {
      ok: true as const,
      symptom: String(fd.get("symptom")),
      severity: Number(fd.get("severity")),
    };
  },
  editSymptom: async (fd: FormData) => {
    record("edit")(fd);
    return {
      ok: true as const,
      symptom: String(fd.get("symptom")),
      severity: Number(fd.get("severity")),
    };
  },
  lowerSymptom: async (fd: FormData) => {
    record("lower")(fd);
    return {
      ok: true as const,
      symptom: String(fd.get("symptom")),
      severity: Number(fd.get("severity")),
    };
  },
  setSymptomNote: async (fd: FormData) => {
    record("note")(fd);
    return { ok: true as const };
  },
  removeSymptom: async (fd: FormData) => {
    record("remove")(fd);
    return removeResult;
  },
  logTemperature: async (fd: FormData) => {
    record("temperature")(fd);
    return { ok: true as const, degF: 100.1, flag: null, redFlag: null };
  },
  activateIllnessForSymptoms: async () => ({ ok: true as const }),
  suggestSymptomsFromText: async () =>
    staged
      ? { ok: true as const, mapping: staged }
      : { ok: false as const, reason: "empty" as const },
}));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: async () => ({ ok: true }),
}));

const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// THE PROFILE'S ACTUAL TODAY. `isPrimaryDay` asks the calendar (#4691 review), so a
// fixed literal calling itself "today" is a past day and the time becomes required —
// which is the rule working. Anything asserting the has-a-now behaviour must stand on
// the real one; FOUND_DAY stays a fixed past day, which is what it always was.
const TODAY = new Date().toISOString().slice(0, 10);
const FOUND_DAY = "2026-08-18";
const SUBJECT = 42;
const ROW = {
  symptom: "headache",
  date: FOUND_DAY,
  severity: 3,
  note: "since lunch",
};
const ONE = [{ key: "headache", label: "Headache" }];
const MANY = [...ONE, { key: "cough", label: "Cough" }];

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
  removeResult = { ok: true, undoId: 9 };
  staged = null;
  cleanup();
});

function openForm(
  row?: typeof ROW,
  choices: { key: string; label: string }[] = ONE,
  subjectProfileId?: number
): void {
  render(
    <SymptomForm
      symptoms={choices}
      date={FOUND_DAY}
      row={row}
      subjectProfileId={subjectProfileId}
      onSaved={() => {}}
      onCancel={() => {}}
    />
  );
}

/** Every control the form draws, by its ACCESSIBLE NAME. The field SIGNATURE. */
function fieldSignature(): string[] {
  return [...document.querySelectorAll<HTMLElement>("input, select, textarea")]
    .map((el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
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

function payload(action: string, index = 0): Record<string, string> {
  const all = posted[action] ?? [];
  expect(
    all.length,
    `${action} was handed ${all.length} payloads`
  ).toBeGreaterThan(index);
  return Object.fromEntries(
    [...all[index].entries()].map(([k, v]) => [k, String(v)])
  );
}

async function save(label: string): Promise<void> {
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: label }))
  );
}

describe("SymptomForm is ONE form for add and for edit", () => {
  it("draws the same fields in both modes and differs only in seed and action", async () => {
    openForm();
    const addFields = fieldSignature();
    const addSeed = (
      screen.getByTestId("symptom-form-severity") as HTMLSelectElement
    ).value;
    await save("Add");
    const added = payload("log");

    cleanup();
    openForm(ROW);
    // THE SEAM. Not "both surfaces render a severity box" — the whole named field set,
    // so a field that appears in one mode and not the other reddens this.
    expect(fieldSignature()).toEqual(addFields);
    expect(
      (screen.getByTestId("symptom-form-severity") as HTMLSelectElement).value
    ).toBe(String(ROW.severity));
    expect(addSeed).not.toBe(String(ROW.severity));
    await save("Save");
    const edited = payload("edit");

    // Same wire shape, different action: the symptom-day's address is (profile, date,
    // symptom) in BOTH modes, so unlike the row-id domains there is nothing extra to
    // carry in edit mode.
    expect(Object.keys(edited).sort()).toEqual(Object.keys(added).sort());
    expect(edited.note).toBe(ROW.note);
    expect(added.note).not.toBe(edited.note);
  });

  // THE PICKER COLLAPSES ON THE CHOICE LIST, NOT ON THE MODE. If it collapsed on the
  // mode the seam above would be untestable — add and edit would differ by a field by
  // construction — so this is the property that makes one layout possible.
  it.each([
    ["add", undefined],
    ["edit", ROW],
  ] as const)(
    "adds exactly the picker when the %s mount can choose",
    (_name, row) => {
      openForm(row as typeof ROW | undefined, ONE);
      const collapsed = fieldSignature();
      cleanup();
      openForm(row as typeof ROW | undefined, MANY);
      expect(fieldSignature()).toEqual([...collapsed, "Symptom"].sort());
    }
  );

  // NO DATE FIELD, IN EITHER MODE — `symptom_logs` is UNIQUE(profile_id, date,
  // symptom), so a date field would let a correction merge two days into one. The day
  // is the MOUNT's, and the seeded row's own day wins.
  it.each([
    ["add", undefined, FOUND_DAY],
    ["edit", ROW, ROW.date],
  ] as const)(
    "takes the %s day from the mount rather than from a field",
    async (_n, row, expected) => {
      openForm(row as typeof ROW | undefined);
      expect(document.querySelector('input[type="date"]')).toBeNull();
      await save(row ? "Save" : "Add");
      expect(payload(row ? "edit" : "log").date).toBe(expected);
    }
  );

  it("carries the SUBJECT under ONE name when the mount names one, and neither when it does not", async () => {
    openForm(ROW);
    await save("Save");
    expect(payload("edit").profile_id).toBeUndefined();
    expect(payload("edit").profileId).toBeUndefined();

    cleanup();
    openForm(ROW, ONE, SUBJECT);
    await save("Save");
    const second = payload("edit", 1);
    expect(second.profile_id).toBe(String(SUBJECT));
    // THE RETIRED SPELLING. The defect this leg closes was posting BOTH names at once,
    // so its absence is the assertion — not the presence of the survivor.
    expect(second.profileId).toBeUndefined();
  });
});

describe("SymptomRowControl is ONE row control", () => {
  function control(severity = 2, note = "") {
    const state = { severity, note };
    render(
      <SymptomRowControl
        symptom={ROW.symptom}
        label="Headache"
        date={FOUND_DAY}
        severity={state.severity}
        note={state.note}
        subjectProfileId={SUBJECT}
        onSeverity={() => {}}
        onNote={() => {}}
      />
    );
  }

  const chip = (level: number) =>
    screen.getByTestId(`symptom-${ROW.symptom}-sev-${level}`);

  // ROUTED BY THE RELATIONSHIP, NOT BY THE CHIP. A plain tap can only RAISE (the day
  // keeps its worst severity, server-enforced), so the same chip is a raise from below
  // and a lower from above — which is why the control cannot key on the chip's value.
  it.each([
    [4, "log"],
    [1, "lower"],
  ] as const)(
    "sends severity %i through the %s action",
    async (level, action) => {
      control(2);
      await act(async () => fireEvent.click(chip(level)));
      expect(payload(action).severity).toBe(String(level));
      expect(posted[action === "log" ? "lower" : "log"]).toBeUndefined();
    }
  );

  it.each([
    ["log", async () => fireEvent.click(chip(4))],
    [
      "remove",
      async () =>
        fireEvent.click(screen.getByTestId(`symptom-${ROW.symptom}-clear`)),
    ],
  ] as const)(
    "names the row and its subject on the %s write",
    async (action, tap) => {
      control(2);
      await act(async () => {
        tap();
      });
      const sent = payload(action);
      expect(sent.symptom).toBe(ROW.symptom);
      expect(sent.date).toBe(FOUND_DAY);
      expect(sent.profile_id).toBe(String(SUBJECT));
      expect(sent.profileId).toBeUndefined();
    }
  );

  it("saves the note the row already carried through the note action", async () => {
    control(2, ROW.note);
    await act(async () =>
      fireEvent.click(screen.getByTestId(`symptom-${ROW.symptom}-note-toggle`))
    );
    const input = screen.getByTestId(
      `symptom-${ROW.symptom}-note-input`
    ) as HTMLInputElement;
    expect(input.value).toBe(ROW.note);
    fireEvent.change(input, { target: { value: "worse at night" } });
    await act(async () =>
      fireEvent.click(screen.getByTestId(`symptom-${ROW.symptom}-note-save`))
    );
    expect(payload("note").note).toBe("worse at night");
  });

  // A CLEAR THAT DELETED NOTHING MUST NOT OFFER TO UNDO NOTHING (#2124): the token is
  // the discriminator, so the offer follows it rather than the tap.
  it.each([
    [9, "Symptom removed."],
    [null, undefined],
  ] as const)(
    "offers Undo only when the clear returned a token (%s)",
    async (undoId, expected) => {
      removeResult = { ok: true, undoId };
      control(2);
      await act(async () =>
        fireEvent.click(screen.getByTestId(`symptom-${ROW.symptom}-clear`))
      );
      expect(toasts[0]).toBe(expected);
    }
  );
});

// THE REACH, at the bar — the mount every symptom surface renders. The record's own
// mounts are driven by e2e/history.spec.ts and the illness specs.
describe("SymptomLogBar mounts both pieces", () => {
  function bar(): void {
    render(
      <SymptomLogBar
        date={TODAY}
        initial={{ [ROW.symptom]: 2 }}
        initialNotes={{}}
        symptoms={PICKER_SYMPTOMS}
        customNames={[]}
        suggestActivateIllness={false}
        showTemperature
        temperatureUnit="F"
        profileId={SUBJECT}
        showTitle={false}
      />
    );
  }

  it("routes a logged row's taps through the shared row control", async () => {
    bar();
    await act(async () =>
      fireEvent.click(screen.getByTestId(`symptom-${ROW.symptom}-sev-1`))
    );
    // Below the day's 2, so the narrow lower action — the control's routing, reached
    // through the bar rather than re-decided by it.
    expect(payload("lower").symptom).toBe(ROW.symptom);
    expect(payload("lower").profile_id).toBe(String(SUBJECT));
  });

  it("composes the vitals temperature field, detection and all", async () => {
    bar();
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-toggle"))
    );
    const unit = screen.getByTestId("temp-quick-unit") as HTMLSelectElement;
    expect(unit.value).toBe("F");
    // THE FIELD'S OWN BEHAVIOUR, not the bar's: the unit follows the reading until the
    // user chooses one. A bar that re-drew the field instead of composing it would have
    // to re-implement this, which is the defect the cell named.
    fireEvent.change(screen.getByTestId("temp-quick-input"), {
      target: { value: "37.8" },
    });
    await waitFor(() => expect(unit.value).toBe("C"));
    expect(screen.getByTestId("temp-quick-detected").textContent).toContain(
      "C"
    );
  });

  // THE READING TIME IS THE SHARED CONTROL'S, which is what retires this bar's raw
  // <input type="time"> from the #2236 allowlist. Stated as a wall clock, posted as
  // one — the wire and the core's stated-time path are untouched by the migration.
  it("posts the time the shared when-control states, and none when nothing is stated", async () => {
    bar();
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-toggle"))
    );
    fireEvent.change(screen.getByTestId("temp-quick-input"), {
      target: { value: "101.4" },
    });
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-save"))
    );
    const untimed = payload("temperature");
    expect(untimed.temperature).toBe("101.4");
    expect(untimed.date).toBe(TODAY);
    expect(untimed.time).toBeUndefined();

    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-toggle"))
    );
    fireEvent.change(screen.getByTestId("temp-quick-input"), {
      target: { value: "101.4" },
    });
    fireEvent.change(screen.getByTestId("temp-quick-time"), {
      target: { value: "07:15" },
    });
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-save"))
    );
    expect(payload("temperature", 1).time).toBe("07:15");
  });
});

// ONE DAY CONTEXT PER SURFACE (#4691). The bar renders a Today/Yesterday toggle and
// then bound three things to three different days: the severity taps followed it, the
// temperature fold hard-set the primary date under a comment that said so, and the
// staged-sentence composite split the difference. The claim is a RELATIONSHIP — what
// the fold DISPLAYS is what it WRITES — so it is asserted through the control's own
// rendered day and the posted `date` together, on both sides of the toggle.
describe("the day the bar shows is the day it writes (#4691)", () => {
  // THE TOGGLE IS THE CARD'S (#4691), so the fixture supplies the card. A bar rendered
  // WITHOUT a provider is a single-day surface with no toggle at all, which is the
  // Timeline/cycles/quick-entry shape and is covered by the mounts above.
  function toggledBar(): void {
    render(
      <CockpitDayProvider date={TODAY} altDate={FOUND_DAY}>
        <SymptomLogBar
          date={TODAY}
          altDate={FOUND_DAY}
          initial={{}}
          initialAlt={{}}
          initialNotes={{}}
          symptoms={PICKER_SYMPTOMS}
          customNames={[]}
          suggestActivateIllness={false}
          showTemperature
          temperatureUnit="F"
          timeZone="UTC"
          profileId={SUBJECT}
          showTitle={false}
          textIntakeEnabled
        />
      </CockpitDayProvider>
    );
  }

  async function openTemp(value: string): Promise<void> {
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-toggle"))
    );
    fireEvent.change(screen.getByTestId("temp-quick-input"), {
      target: { value },
    });
  }

  async function saveTemp(): Promise<void> {
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-save"))
    );
  }

  // A PAST DAY HAS NO "NOW" (#4685). The action stores an untimed reading honestly
  // rather than stamping the current clock onto a day that has ended, and an untimed
  // reading is anchored at noon — which cannot say whether it came before or after an
  // evening fever. So the alt day asks for the minute, and refuses without it.
  it("refuses a reading on the alt day until a time is stated", async () => {
    toggledBar();
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-day-alt"))
    );
    await openTemp("98.6");
    // The control carries the requirement natively, so the browser refuses the
    // submission before the handler runs — which is what the user meets. The
    // handler's own guard is the belt beneath it, for a programmatic submit.
    expect(
      (screen.getByTestId("temp-quick-time") as HTMLInputElement).required
    ).toBe(true);
    await saveTemp();
    expect(posted.temperature).toBeUndefined();
  });

  it("does NOT require a time on the primary day — thermometer-to-phone is one step", async () => {
    toggledBar();
    await openTemp("101.4");
    expect(
      (screen.getByTestId("temp-quick-time") as HTMLInputElement).required
    ).toBe(false);
    await saveTemp();
    expect(payload("temperature").date).toBe(TODAY);
    expect(payload("temperature").time).toBeUndefined();
  });

  it("accepts it once the minute is stated, and posts both halves", async () => {
    toggledBar();
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-day-alt"))
    );
    await openTemp("98.6");
    fireEvent.change(screen.getByTestId("temp-quick-time"), {
      target: { value: "23:00" },
    });
    await saveTemp();
    expect(payload("temperature").date).toBe(FOUND_DAY);
    expect(payload("temperature").time).toBe("23:00");
  });

  it.each([
    ["primary", TODAY],
    ["alt", FOUND_DAY],
  ])("the temperature fold on %s writes that day", async (side, day) => {
    toggledBar();
    await act(async () =>
      fireEvent.click(screen.getByTestId(`symptom-day-${side}`))
    );
    await openTemp("101.4");
    if (side === "alt") {
      fireEvent.change(screen.getByTestId("temp-quick-time"), {
        target: { value: "19:10" },
      });
    }
    // What the fold DISPLAYS: the shared control is pinned to the bar's day, so it
    // draws it as text rather than a picker and the pair rule holds by construction.
    // The control renders the primary day as "Today" (it IS today now) and the alt
    // day as its date — either way, the day it SHOWS is the day it writes below.
    expect(screen.getByTestId("temp-quick-date").textContent).toContain(
      day === TODAY ? "Today" : day
    );
    // …and what it WRITES is that same day.
    await saveTemp();
    expect(payload("temperature").date).toBe(day);
  });

  it("switching days re-anchors the stated reading time instead of carrying it over", async () => {
    toggledBar();
    await act(async () =>
      fireEvent.click(screen.getByTestId("temp-quick-toggle"))
    );
    fireEvent.change(screen.getByTestId("temp-quick-time"), {
      target: { value: "19:10" },
    });
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-day-alt"))
    );
    expect(
      (screen.getByTestId("temp-quick-time") as HTMLInputElement).value
    ).toBe("");
  });

  // THE COMPOSITE, driven through `confirmIntake` rather than through the fold — the
  // test that used to carry this name drove the temperature fold and was byte-identical
  // to the case above it, so the composite had NO coverage at all while being the only
  // producer of an untimed reading on a past day.
  //
  // It sets no `time`: a typed sentence carries a day at best, and the action stamps
  // the minute only for a day that has a now. So the assertion is the ABSENCE — the
  // composite must not invent one — beside the day it did state.
  it("a confirmed sentence posts a day and states no time", async () => {
    staged = {
      symptoms: [{ slug: "headache", severity: 2, note: null }],
      temperature: { value: 99.2, unit: "F" },
      unmapped: [],
      dayOffset: -1,
    };
    toggledBar();
    // The text intake lives inside the add picker, which is collapsed by default.
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-add-picker-toggle"))
    );
    fireEvent.change(screen.getByTestId("symptom-text-input"), {
      target: { value: "headache and 99.2 since yesterday" },
    });
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-text-suggest"))
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-text-confirm"))
    );
    // The sentence said "yesterday" and the card offers that day, so both halves land
    // there — the symptom and the reading, together.
    expect(payload("log").date).toBe(FOUND_DAY);
    const temp = payload("temperature");
    expect(temp.date).toBe(FOUND_DAY);
    expect(temp.time).toBeUndefined();
  });
});
