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
import IllnessNowGroup, {
  type IllnessContextCockpit,
} from "@/components/dashboard/IllnessNowGroup";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import { CockpitPanelProvider } from "@/components/illness/CockpitPanelContext";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import { episodeHref } from "@/lib/hrefs";
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
vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: vi.fn(async () => []),
  createPoolAction: vi.fn(async () => ({ ok: true })),
  linkItemAction: vi.fn(async () => ({ ok: true })),
  unlinkItemAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/symptom-actions", () => ({
  logSymptom: vi.fn(async () => ({
    ok: true as const,
    symptom: "cough",
    severity: 1,
  })),
  editSymptom: vi.fn(async () => ({ ok: true as const })),
  lowerSymptom: vi.fn(async () => ({ ok: true as const })),
  setSymptomNote: vi.fn(async () => ({ ok: true as const })),
  removeSymptom: vi.fn(async () => ({ ok: true as const })),
  logTemperature: vi.fn(async () => ({
    ok: true as const,
    degF: 100.1,
    flag: null,
    redFlag: null,
  })),
  activateIllnessForSymptoms: vi.fn(async () => ({ ok: true as const })),
  suggestSymptomsFromText: vi.fn(async () => ({
    ok: false as const,
    reason: "empty" as const,
  })),
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
  worsening: null,
};

const RECOVERY = {
  clearedForHours: 22,
  thresholdHours: 24,
  met: false,
  label: "Fever-free 22h of 24",
  lastFeverLabel: "101.9 °F",
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
    // THE NAME AND THE DAY TAG STAY (owner, 2026-09-06). Both also appear on the
    // accordion row this body expands from, and a pass removing them from here as
    // duplicates was reverted: #4752 §1 approved a header that carries them.
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

function meds(props: { profileId?: number; canAdd?: boolean } = {}) {
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

  it("omits the add door when the viewer cannot add", () => {
    meds({ canAdd: false });
    expect(screen.queryByTestId("illness-add-medication")).toBeNull();
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
    // AND THE PANEL STATES WHAT THE LABEL SAYS (#4713), without changing that dose.
    // This subject is 26.5 lb, whose ibuprofen band is 100 mg; the item still carries
    // the 160 mg it was saved with, and only a person may reconcile the two.
    expect(within(panel).getByTestId("prn-band-basis").textContent).toContain(
      "Label band for this weight is 100 mg · 24–35 lb band"
    );
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

  // THE PANEL'S EYEBROW IS THE CARD'S DAY (#5489 fix 4). It was the literal "Today",
  // so a panel opened on a cockpit standing on Yesterday was headed TODAY above a tap
  // that writes yesterday — the card's own day context was one line away.
  it("heads the dose block with the card's day, not the word Today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    render(
      <CockpitDayProvider date={yesterday} tz="UTC">
        <IllnessMedicationLogger
          meds={MEDS}
          tz="UTC"
          intakeContext={INTAKE_CONTEXT}
          canAdd
          nowIso="2026-09-02T12:00:00.000Z"
        />
      </CockpitDayProvider>
    );
    fireEvent.click(screen.getByTestId("cockpit-med-chip-31"));
    const eyebrow = within(screen.getByTestId("cockpit-med-panel")).getByRole(
      "heading"
    );
    expect(eyebrow.textContent).not.toBe("Today");
    expect(eyebrow.textContent).not.toBe(yesterday);
    cleanup();

    // …and the same panel on the card's today still reads Today, so this is the day
    // context reaching the eyebrow rather than the word being replaced.
    render(
      <CockpitDayProvider date={today} tz="UTC">
        <IllnessMedicationLogger
          meds={MEDS}
          tz="UTC"
          intakeContext={INTAKE_CONTEXT}
          canAdd
          nowIso="2026-09-02T12:00:00.000Z"
        />
      </CockpitDayProvider>
    );
    fireEvent.click(screen.getByTestId("cockpit-med-chip-31"));
    expect(
      within(screen.getByTestId("cockpit-med-panel")).getByRole("heading")
        .textContent
    ).toBe("Today");
  });

  it("says Take on the viewer's own meds", () => {
    meds();
    fireEvent.click(screen.getByTestId("cockpit-med-chip-31"));
    expect(screen.getByTestId("prn-log-now").getAttribute("aria-label")).toBe(
      "Take Ibuprofen · 160 mg"
    );
  });
});

// ── ONE PANEL OPEN PER CARD (#5487 fix 1) ───────────────────────────────────
//
// Six `useState` booleans in two children each held a private claim on this card's
// height, so a production screenshot carried the med detail panel and the whole
// add-medication form open at once, and another carried the temperature fold, the
// fever offer and a dose panel nested inside it. Every one of #4752's approved
// boards shows exactly one thing open, or none.
//
// EVERY PAIR, not one representative: four disclosures in two components is six
// pairs and twelve orders, and the shape that regresses is precisely the one nobody
// wrote a case for.
const PANELS = {
  "symptom picker": {
    control: "symptom-add-picker-toggle",
    panel: "symptom-add-picker",
  },
  "temperature fold": {
    control: "temp-quick-toggle",
    panel: "temp-quick-entry",
  },
  "med panel": { control: "cockpit-med-chip-31", panel: "cockpit-med-panel" },
  "add-medication fold": {
    control: "illness-add-medication",
    panel: "illness-medication-quick-add",
  },
} as const;
type PanelName = keyof typeof PANELS;
const PANEL_NAMES = Object.keys(PANELS) as PanelName[];
const PANEL_PAIRS = PANEL_NAMES.flatMap((open) =>
  PANEL_NAMES.filter((then) => then !== open).map(
    (then) => [open, then] as const
  )
);

function card(): void {
  const today = new Date().toISOString().slice(0, 10);
  render(
    // The add-medication fold mounts the shared item form, which asks for the app's
    // confirmation surface.
    <ConfirmProvider>
      <CockpitPanelProvider>
        <SymptomLogBar
          date={today}
          initial={{}}
          initialNotes={{}}
          symptoms={PICKER_SYMPTOMS}
          customNames={[]}
          suggestActivateIllness={false}
          showTemperature
          temperatureUnit="F"
          showTitle={false}
        />
        <IllnessMedicationLogger
          meds={MEDS}
          tz="UTC"
          intakeContext={INTAKE_CONTEXT}
          canAdd
          nowIso="2026-09-02T12:00:00.000Z"
        />
      </CockpitPanelProvider>
    </ConfirmProvider>
  );
}

describe("the card opens one panel at a time (#5487 fix 1)", () => {
  it.each(PANEL_PAIRS)("opening the %s closes the %s", (open, then) => {
    card();
    fireEvent.click(screen.getByTestId(PANELS[then].control));
    expect(screen.getByTestId(PANELS[then].panel)).toBeTruthy();
    fireEvent.click(screen.getByTestId(PANELS[open].control));
    expect(screen.getByTestId(PANELS[open].panel)).toBeTruthy();
    expect(screen.queryByTestId(PANELS[then].panel)).toBeNull();
  });

  // The rule is one OPEN panel, not a panel that can never close: the control that
  // opened it still puts it away.
  it("closes the open panel when its own control is tapped again", () => {
    card();
    fireEvent.click(screen.getByTestId("temp-quick-toggle"));
    expect(screen.getByTestId("temp-quick-entry")).toBeTruthy();
    fireEvent.click(screen.getByTestId("temp-quick-toggle"));
    expect(screen.queryByTestId("temp-quick-entry")).toBeNull();
  });

  // FALLBACK, NOT A FLAG. A bar mounted outside a card (the quick-entry sheet, the
  // cycles page) keeps the same rule over its own state rather than losing it.
  it("keeps the rule on a mount with no card around it", () => {
    const today = new Date().toISOString().slice(0, 10);
    render(
      <SymptomLogBar
        date={today}
        initial={{}}
        initialNotes={{}}
        symptoms={PICKER_SYMPTOMS}
        customNames={[]}
        suggestActivateIllness={false}
        showTemperature
        temperatureUnit="F"
        showTitle={false}
      />
    );
    fireEvent.click(screen.getByTestId("temp-quick-toggle"));
    fireEvent.click(screen.getByTestId("symptom-add-picker-toggle"));
    expect(screen.getByTestId("symptom-add-picker")).toBeTruthy();
    expect(screen.queryByTestId("temp-quick-entry")).toBeNull();
  });
});

// ── THE LAST-DOSE LINE CANNOT ASK FOR A DAY IT DOES NOT RENDER (#5488 fix 3) ─
//
// The screenshot's own case: the last Ibuprofen was 17:44 yesterday, two doses sit
// in the trailing 24h, and the panel is read at 06:00. It led with "None today" —
// a day-scoped count answering under an eyebrow that had just said the same word,
// with the one useful fact (the dose, and which day it was on) discarded.
describe("the open med panel states the last dose and its day (#5488 fix 3)", () => {
  it("names the overnight dose instead of reading None today", () => {
    render(
      <IllnessMedicationLogger
        meds={[
          med({
            id: 31,
            name: "Ibuprofen",
            // The item's OWN day count is zero at 06:00 — the day-scoped figure the
            // retired signature asked for — while two doses sit in the trailing 24h.
            count: 0,
            lastGivenAt: "2026-09-05 17:44:00",
            familyCount: 2,
            familyLastGivenAt: "2026-09-05 17:44:00",
          }),
        ]}
        tz="UTC"
        intakeContext={INTAKE_CONTEXT}
        canAdd={false}
        nowIso="2026-09-06T06:00:00.000Z"
      />
    );
    fireEvent.click(screen.getByTestId("cockpit-med-chip-31"));
    const line = within(screen.getByTestId("cockpit-med-panel")).getByTestId(
      "prn-day-label"
    );
    expect(line.textContent).not.toBe("None today");
    expect(line.textContent).toContain("Last dose");
    // AND ITS DAY. The panel renders no date of its own, so a bare "5:44pm" here
    // reads as this morning — the overnight blind spot #4686 was filed for,
    // surviving in the copy after the counting was fixed.
    expect(line.textContent).toContain("5:44pm");
    expect(line.textContent).not.toBe("Last dose 5:44pm");
  });
});

// ── EXPANDED, THE ROW IS IDENTITY AND A COLLAPSE CONTROL (#5488 fix 1) ──────
//
// The accordion row restated four facts the header ~100px below it already states,
// and two of the pairs had drifted. Three of its six clauses already carried their
// own `&& !expanded`; the rule is about the ROW, so it is asserted over the row.
const ROW_COCKPIT: IllnessContextCockpit = {
  episodeKey: "e1",
  episodeOrder: 0,
  profileId: 4,
  profile: { id: 4, name: "Dune", photo_path: null, photo_version: 0 },
  displayName: "Dune",
  situation: "Illness",
  isActive: true,
  canWrite: true,
  status: {
    dayLabel: "Illness · Day 2",
    dayOnlyLabel: "Day 2",
    temperature: {
      id: 1,
      value: "98 °F",
      when: "yesterday 8:20 PM",
      high: false,
    },
    lastMeds: {
      id: 2,
      name: "Ibuprofen",
      dose: "160 mg",
      when: "yesterday 5:44 PM",
    },
    worsening: { driver: "symptom", label: "Cough" },
  },
  feverFree: { label: "Fever-free 10h of 24", met: false },
  episodeHref: episodeHref(1),
  body: <p data-testid="row-body">body</p>,
  stateIdentity: null,
  temperatureIdentity: null,
  medicationIdentity: null,
};

function row(expanded: boolean) {
  render(
    <IllnessNowGroup
      cockpits={[ROW_COCKPIT]}
      initialCollapsedActive={!expanded}
      initialOpenOtherKey={null}
      saveState={async () => {}}
    />
  );
}

describe("the accordion row goes quiet when it is expanded (#5488 fix 1)", () => {
  it("states the episode's facts collapsed", () => {
    row(false);
    const line = screen.getByTestId("illness-cockpit-status-row");
    expect(line.textContent).toContain("Day 2");
    expect(line.textContent).toContain("98 °F");
    expect(line.textContent).toContain("Ibuprofen");
    expect(line.textContent).toContain("Fever-free 10h of 24");
    // AND THE ARROW NAMES ITS DRIVER (#5488 fix 2), collapsed as well as expanded.
    expect(line.textContent).toContain("Cough worsening ↑");
    expect(
      screen.getByTestId("illness-cockpit-name-e1").parentElement
    ).toHaveProperty("textContent", expect.stringContaining("Illness"));
  });

  it("renders no fact at all expanded, and keeps the name and avatar", () => {
    row(true);
    // ONE rule over the ROW, not six clause rules: nothing the body restates paints.
    expect(screen.queryByTestId("illness-cockpit-status-row")).toBeNull();
    const header = screen.getByTestId("illness-cockpit-header-row");
    expect(header.textContent).not.toContain("Illness");
    // #531/#534's safety identity stays: which person a control writes to is never
    // a matter of screen position.
    expect(screen.getByTestId("illness-cockpit-name-e1").textContent).toBe(
      "Dune"
    );
    expect(screen.getByTestId("row-body")).toBeTruthy();
    // …and the toggle still names the situation and the person, so the row painting
    // neither does not take them off the accessible name.
    const toggle = screen.getByTestId("illness-cockpit-toggle-e1");
    expect(toggle.getAttribute("aria-label")).toContain("Illness episode 1");
    expect(toggle.getAttribute("aria-label")).toContain("Dune");
  });
});
