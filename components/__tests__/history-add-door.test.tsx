import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HistoryAddDoor, {
  type HistoryAddKind,
} from "@/app/(app)/history/HistoryAddDoor";

// WHAT THE RECORD'S ADD DOOR POSTS (#4045 §1).
//
// The door shipped as four redirect links, so there was nothing to post and nothing to
// test. Now each kind mounts that kind's backfill form in place, and the claim that
// matters is the same one `history-row-writes.test.tsx` makes about the ⋯: the payload
// reaches THE DOMAIN'S OWN CREATE ACTION, carrying the day the reader was looking at.
//
// NO SIXTH WRITE CORE, asserted structurally: the four mocks below are the four create
// actions those domains already had. A door that reached for anything else would post
// to something unmocked and fail here rather than quietly ship a fifth write path.
//
// THE DATE IS THE WHOLE POINT. "Losing the found context (the day you were looking at)"
// is the defect in the owner's own words, so every case asserts the posted `date` and
// not merely that something was posted.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

vi.mock("@/app/(app)/nutrition/actions", () => ({
  logFoodServing: async (fd: FormData) => {
    record("logFoodServing")(fd);
    return { ok: true, servings: 1 };
  },
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: async (fd: FormData) => {
    record("logPractice")(fd);
    return { kind: "logged" };
  },
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  addSubstanceDailyTotalAction: async (fd: FormData) => {
    record("addSubstanceDailyTotalAction")(fd);
    return { kind: "added" };
  },
}));
vi.mock("@/app/(app)/trends/body-actions", () => ({
  addBodyMetric: async (fd: FormData) => {
    record("addBodyMetric")(fd);
  },
}));

const refreshed: number[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => refreshed.push(1) }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  refreshed.length = 0;
  cleanup();
});

/** The day the reader is looking at, and the bound every door here is under. */
const FOUND_DAY = "2026-08-18";
const TODAY = "2026-08-29";

const VOCABULARY = {
  practices: ["Rowing", "Sauna"],
  substances: [
    { key: "nicotine", label: "Nicotine" },
    { key: "cannabis", label: "Cannabis" },
  ],
  weightUnit: "lb" as const,
};

function open(kind: HistoryAddKind): void {
  render(
    <HistoryAddDoor
      kind={kind}
      date={FOUND_DAY}
      maxDate={TODAY}
      vocabulary={VOCABULARY}
    />
  );
  fireEvent.click(screen.getByTestId(`history-add-open-${kind}`));
}

async function submit(kind: HistoryAddKind): Promise<void> {
  const panel = screen.getByTestId(`history-add-panel-${kind}`);
  const form = panel.querySelector("form")!;
  await act(async () => fireEvent.submit(form));
}

function only(action: string): Record<string, string> {
  const all = posted[action] ?? [];
  expect(all, `${action} was handed ${all.length} payloads`).toHaveLength(1);
  return Object.fromEntries(
    [...all[0].entries()].map(([k, v]) => [k, String(v)])
  );
}

describe("the record's Add door posts to the domain's own create action", () => {
  // Each kind, the action it must reach, and the fields that make its write mean what
  // the door says it means. A table because the cases differ only in inputs and
  // expectations; what they share — the found day, the in-place resolution, the
  // re-read — is asserted for all four below the switch.
  it.each([
    [
      "food",
      "logFoodServing",
      { group_key: "leafy_greens", meal_slot: "Morning" },
    ],
    ["practice", "logPractice", { practice: "Rowing", time: "" }],
    [
      "substance",
      "addSubstanceDailyTotalAction",
      { substance: "nicotine", amount: "1" },
    ],
    ["body", "addBodyMetric", {}],
  ] as [HistoryAddKind, string, Record<string, string>][])(
    "%s writes on the day the reader was looking at, through %s",
    async (kind, action, fields) => {
      open(kind);
      if (kind === "food") {
        fireEvent.change(
          screen.getByRole("combobox", { name: /food group/i }),
          { target: { value: "leafy_greens" } }
        );
      }
      if (kind === "body") {
        fireEvent.change(screen.getByRole("spinbutton", { name: /weight/i }), {
          target: { value: "154" },
        });
      }
      await submit(kind);
      const sent = only(action);
      expect(sent.date).toBe(FOUND_DAY);
      for (const [key, value] of Object.entries(fields)) {
        expect(sent[key], `${action} posted ${key}=${sent[key]}`).toBe(value);
      }
      // RESOLVED IN PLACE, WITH THE RESULT VISIBLE: the panel closes and the feed is
      // re-read. Without the re-read the door writes silently and reads as dead — the
      // same complaint as the redirect it replaces.
      expect(screen.queryByTestId(`history-add-panel-${kind}`)).toBeNull();
      expect(refreshed).toHaveLength(1);
    }
  );

  it("will not carry a date past today out of any kind's door", async () => {
    // NEVER THE FUTURE is the record's own rule and it is the one bound these four
    // doors share, so it is asked of the FIELD'S OWN VERDICT rather than of a `max`
    // attribute: `DateField` posts through a hidden input and enforces its range
    // through the Constraint Validation API, so an attribute assertion would read
    // `null` on a door that still had the bound and pass on one that had lost it.
    for (const kind of [
      "food",
      "practice",
      "substance",
      "body",
    ] as HistoryAddKind[]) {
      cleanup();
      open(kind);
      const panel = screen.getByTestId(`history-add-panel-${kind}`);
      const form = panel.querySelector("form")!;
      const typed = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
      // The converse in the same assertion: the found day itself must pass, or
      // "refuses 2099" would also be satisfied by a field that refuses everything.
      expect(form.checkValidity(), `${kind} refuses the found day`).toBe(true);
      await act(async () => {
        fireEvent.change(typed, { target: { value: "2099-01-01" } });
      });
      expect(form.checkValidity(), `${kind} accepts a future day`).toBe(false);
    }
  });

  it("keeps ONE identity while its form is open, and offers nothing it cannot write", () => {
    // #3911's defect, not inherited (#2816): the dose launcher swaps its label to
    // "Cancel" while open. Dismissal belongs to the form these doors open.
    open("practice");
    expect(screen.getByTestId("history-add-open-practice").textContent).toBe(
      "Log a practice"
    );
    // And a profile with no practices gets no door at all rather than a select with
    // nothing in it — the same rule the dose door applies to items with no live dose.
    cleanup();
    render(
      <HistoryAddDoor
        kind="practice"
        date={FOUND_DAY}
        maxDate={TODAY}
        vocabulary={{ ...VOCABULARY, practices: [] }}
      />
    );
    expect(screen.queryByTestId("history-add-open-practice")).toBeNull();
  });

  it("refuses an out-of-range body reading inline instead of closing over nothing", async () => {
    // `addBodyMetric` SILENTLY SKIPS a number outside its range, so a door that just
    // posted would close on a write that never happened. The refusal is the one case
    // where the panel must stay open.
    open("body");
    fireEvent.change(screen.getByRole("spinbutton", { name: /weight/i }), {
      target: { value: "9999" },
    });
    await submit("body");
    expect(posted.addBodyMetric ?? []).toHaveLength(0);
    expect(screen.getByTestId("history-add-panel-body")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect(refreshed).toHaveLength(0);
  });
});
