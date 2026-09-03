import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CockpitRecoveryHeader from "@/components/illness/CockpitRecoveryHeader";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import type { EpisodeCollapsedStatus } from "@/lib/illness-episode-format";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import type { PrnMedForQuickLog } from "@/lib/queries";

vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "12h" }),
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (o: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: vi.fn(async () => ({
    ok: true as const,
    outcome: "logged" as const,
  })),
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  addIntakeItem: vi.fn(async () => ({ ok: true })),
}));

afterEach(cleanup);

// ── THE RECOVERY-LED COMPACT COCKPIT, REGION BY REGION (#4752) ──────────────
//
// The cockpit was a phone layout stretched across a monitor: three stat headings
// spread across gulfs, six lines of "None · Redose OK" above three taps, and
// the headline recovery fact at footnote weight on the far right. These are the
// claims the rebuild makes about what a caregiver now sees.

const STATUS: EpisodeCollapsedStatus = {
  dayLabel: "Illness · Day 3",
  dayOnlyLabel: "Day 3",
  temperature: { id: 1, value: "97.5 °F", when: "13h ago", high: false },
  lastMeds: {
    id: 2,
    name: "Ibuprofen",
    dose: "160 mg",
    when: "yesterday 11:30 PM",
  },
  worsening: false,
};

const RECOVERY = {
  clearedForHours: 22,
  thresholdHours: 24,
  met: false,
  label: "Fever-free 22h of 24",
};

describe("the recovery header IS the status (#4752 item 1)", () => {
  it("leads with the ring, the sentence, the day tag, one summary line and the promoted action", () => {
    render(
      <CockpitRecoveryHeader
        name="Dune"
        status={STATUS}
        recovery={RECOVERY}
        action={<button type="button">Feeling better</button>}
      />
    );
    const header = screen.getByTestId("cockpit-recovery-header");
    expect(screen.getByTestId("cockpit-headline").textContent).toBe(
      "Dune is nearly there"
    );
    expect(screen.getByTestId("cockpit-day-tag").textContent).toBe(
      "Illness · Day 3"
    );
    // The ring draws the countdown and speaks the shared compact clause, so a
    // screen reader hears the sentence rather than a number with no unit.
    const ring = screen.getByTestId("cockpit-recovery-ring");
    expect(ring.getAttribute("data-fraction")).toBe("0.92");
    expect(ring.textContent).toContain("22h");
    expect(ring.textContent).toContain("Fever-free 22h of 24");
    // ONE line, not three stat headings. `textContent` reads the separators too,
    // which is the sentence a person sees.
    expect(screen.getByTestId("cockpit-summary-line").textContent).toBe(
      "Fever-free 22h of 24 · last reading 97.5 °F 13h ago · last med Ibuprofen yesterday 11:30 PM"
    );
    // PROMOTED: the action the state ripens toward sits inside the header, beside
    // the countdown — not at the card's bottom edge, which is where it used to be.
    expect(
      within(header).getByRole("button", { name: "Feeling better" })
    ).toBeTruthy();
  });

  it("draws no ring when nothing has been measured", () => {
    render(
      <CockpitRecoveryHeader name="Dune" status={STATUS} recovery={null} />
    );
    // A ring at zero and a ring that does not apply look identical, and only one
    // of them is true.
    expect(screen.queryByTestId("cockpit-recovery-ring")).toBeNull();
    expect(screen.getByTestId("cockpit-headline").textContent).toBe("Dune");
  });
});

function med(over: Partial<PrnMedForQuickLog> & { id: number; name: string }) {
  return {
    kind: "medication" as const,
    product: null,
    amount: "160 mg",
    count: 0,
    lastGivenAt: null,
    minIntervalHours: 6,
    maxDailyCount: 4,
    familyCount: 0,
    familyLastGivenAt: null,
    familyMaxDailyCount: 4,
    familyExposure: null,
    familyMemberCount: 1,
    ...over,
  } satisfies PrnMedForQuickLog;
}

const MEDS = [
  med({ id: 31, name: "Ibuprofen" }),
  med({ id: 32, name: "Acetaminophen", amount: "160 mg" }),
  med({ id: 33, name: "Cetirizine", amount: "5 mg" }),
  med({ id: 34, name: "Saline spray", amount: null }),
];

const INTAKE_CONTEXT: IntakeFormContext = {
  allIntakeItems: [],
  stackItems: [],
  pgxVariants: [],
  conditions: [],
  pediatric: {
    ageMonths: 72,
    weightKg: 12,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-02",
  },
  todayStr: "2026-09-02",
};

function meds(props: { profileId?: number } = {}) {
  render(
    <IllnessMedicationLogger
      meds={MEDS}
      tz="UTC"
      intakeContext={INTAKE_CONTEXT}
      canAdd
      nowIso="2026-09-02T12:00:00.000Z"
      {...props}
    />
  );
}

describe("meds are labeled-verb chips, detail only when acting (#4752 item 4)", () => {
  it("collapses to named chips under ONE status line, with the tail behind N more", () => {
    meds();
    const row = screen.getByTestId("cockpit-med-chips");
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual([
      "Ibuprofen",
      "Acetaminophen",
      "Cetirizine",
      "1 more",
      "Add medication",
    ]);
    // ONE sentence about the whole row, replacing six lines of per-row boilerplate.
    expect(screen.getByTestId("cockpit-med-status").textContent).toBe(
      "Nothing given in 24h"
    );
    // A COLLAPSED CHIP SHOWS NEITHER (#4752's acceptance criterion): no per-med day
    // label and no per-med redose line until somebody opens the med.
    expect(screen.queryByTestId("prn-day-label")).toBeNull();
    expect(screen.queryByTestId("prn-redose-line")).toBeNull();
    fireEvent.click(screen.getByTestId("cockpit-med-more"));
    expect(screen.getByTestId("cockpit-med-chip-34")).toBeTruthy();
  });

  it("opens the full statement in place, and a chip opens the med rather than giving it", () => {
    meds({ profileId: 9 });
    const chip = screen.getByTestId("cockpit-med-chip-31");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    const panel = screen.getByTestId("cockpit-med-panel");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.getAttribute("aria-controls")).toBe(panel.id);
    // THE PANEL IS THE TAP THAT WRITES, and its label is the dose. A cross-profile
    // mount says "Give" because "Take" would be addressed to the wrong person.
    const give = within(panel).getByTestId("prn-log-now");
    expect(give.textContent).toBe("160 mgGive");
    expect(give.getAttribute("aria-label")).toBe("Give Ibuprofen · 160 mg");
    // The clock door, in its seat and spelled only as the glyph (#4752 item 8).
    const door = within(panel).getByTestId("prn-log-when-toggle");
    expect(door.getAttribute("aria-label")).toBe("Happened earlier?");
    expect(door.querySelector("span")?.className).toContain("sr-only");
    // Per-med detail lives HERE and only here.
    expect(within(panel).getByTestId("prn-day-label").textContent).toBe(
      "None today"
    );
    // The card never navigates: opening a second med swaps the panel in place.
    fireEvent.click(screen.getByTestId("cockpit-med-chip-32"));
    expect(screen.getAllByTestId("cockpit-med-panel")).toHaveLength(1);
    expect(
      screen.getByTestId("cockpit-med-panel").getAttribute("data-item-id")
    ).toBe("32");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("says Take on the viewer's own meds", () => {
    meds();
    fireEvent.click(screen.getByTestId("cockpit-med-chip-31"));
    expect(screen.getByTestId("prn-log-now").getAttribute("aria-label")).toBe(
      "Take Ibuprofen · 160 mg"
    );
  });
});
