import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import IllnessCockpitBody from "@/components/illness/IllnessCockpitBody";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import type { PrnMedForQuickLog } from "@/lib/queries/intake/adherence";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import type { AssembledEpisode } from "@/lib/illness-episode-format";
import type { DashboardIllnessCockpitModel } from "@/lib/dashboard-illness-cockpit";

// THE FOLD'S INLINE FEVER OFFER (#4712 judgement 1, owner ruling 2026-09-03 15:40 UTC,
// option A). Three things the ruling states that a test can see:
//
//   1. THE BLOCK LIVES IN THE FOLD — a LIFETIME claim: closing the fold takes the
//      confirmation with it, not merely "it rendered once".
//   2. NO TOAST, NO PERSISTENT NUDGE — both exclusions named explicitly. The toast
//      mock records every call's OPTIONS, so an `action` slipping onto the fever toast
//      reds here; StaleEpisodeNudge's own testid is asserted absent.
//   3. "Open an episode" is PRIMARY, the dose sits BESIDE it (reusing
//      IllnessMedicationLogger per the 08:24 audit — no second dose control), and
//      "Not now" is a LINK, not a third button.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

vi.mock("@/app/(app)/symptom-actions", () => ({
  logSymptom: async (fd: FormData) => {
    record("log")(fd);
    return {
      ok: true as const,
      symptom: String(fd.get("symptom")),
      severity: 1,
    };
  },
  lowerSymptom: async () => ({ ok: true as const, symptom: "x", severity: 0 }),
  setSymptomNote: async () => ({ ok: true as const }),
  removeSymptom: async () => ({ ok: true as const }),
  // The fever line is drawn purely from the posted temperature: >= 100.4 is the
  // fever-range reading every test that wants the offer sends.
  logTemperature: async (fd: FormData) => {
    record("temperature")(fd);
    const degF = Number(fd.get("temperature"));
    return {
      ok: true as const,
      degF,
      flag: degF >= 100.4 ? "high" : null,
      redFlag: null,
    };
  },
  activateIllnessForSymptoms: async (fd?: FormData) => {
    record("activate")(fd ?? new FormData());
    return { ok: true as const, episodeId: 900 };
  },
  suggestSymptomsFromText: async () => ({
    ok: false as const,
    reason: "empty" as const,
  }),
}));

vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: async (fd: FormData) => {
    record("dose")(fd);
    return { ok: true as const, outcome: "logged" as const };
  },
}));

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  addIntakeItem: async () => ({ ok: true as const }),
}));

// Every toast call, MESSAGE AND OPTIONS both — an `action` hiding in the options is
// exactly what "no toast carries the offer" forbids, and a message-only recorder
// cannot see it.
const toasts: { message: string; options?: Record<string, unknown> }[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (message: string, options?: Record<string, unknown>) => {
    toasts.push({ message, options });
  },
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const TODAY = new Date().toISOString().slice(0, 10);
const SUBJECT = 42;

const ANTIPYRETIC: PrnMedForQuickLog = {
  id: 501,
  name: "Ibuprofen",
  kind: "medication",
  product: null,
  amount: "200 mg",
  count: 0,
  lastGivenAt: null,
  minIntervalHours: 6,
  maxDailyCount: 4,
  familyCount: 0,
  familyLastGivenAt: null,
  familyMaxDailyCount: 4,
  familyExposure: null,
  familyMemberCount: 1,
};

const INTAKE_CONTEXT: IntakeFormContext = {
  allIntakeItems: [],
  stackItems: [],
  pgxVariants: [],
  conditions: [],
  pediatric: {
    ageMonths: 48,
    weightKg: null,
    weightDate: null,
    weightUnit: "kg",
    today: TODAY,
  },
  todayStr: TODAY,
};

function bar(
  props: Partial<{
    hasOpenEpisode: boolean;
    antipyreticMeds: PrnMedForQuickLog[];
    intakeContext: IntakeFormContext;
    nowIso: string;
  }> = {}
): void {
  render(
    <SymptomLogBar
      date={TODAY}
      initial={{}}
      initialNotes={{}}
      symptoms={PICKER_SYMPTOMS}
      customNames={[]}
      suggestActivateIllness={false}
      showTemperature
      temperatureUnit="F"
      profileId={SUBJECT}
      showTitle={false}
      hasOpenEpisode={props.hasOpenEpisode ?? false}
      antipyreticMeds={props.antipyreticMeds ?? [ANTIPYRETIC]}
      intakeContext={props.intakeContext ?? INTAKE_CONTEXT}
      nowIso={props.nowIso ?? new Date().toISOString()}
    />
  );
}

async function openFold(): Promise<void> {
  await act(async () =>
    fireEvent.click(screen.getByTestId("temp-quick-toggle"))
  );
}

async function logReading(value: string): Promise<void> {
  fireEvent.change(screen.getByTestId("temp-quick-input"), {
    target: { value },
  });
  await act(async () => fireEvent.click(screen.getByTestId("temp-quick-save")));
}

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
});
afterEach(() => cleanup());

describe("the fever offer's lifetime is the fold's (#4712 judgement 1)", () => {
  it("renders after a fever-range reading and survives while the fold stays open", async () => {
    bar();
    await openFold();
    await logReading("101.4");
    expect(screen.getByTestId("fever-offer")).toBeTruthy();
    expect(screen.getByTestId("fever-offer-sentence").textContent).toContain(
      "101.4"
    );
  });

  // THE CONVERSE, not just "it renders": closing the fold must remove it from the
  // DOM, not merely hide it — queryByTestId returns null on removal and a truthy
  // (possibly hidden) node on a mere paint change, so this distinguishes the two.
  it("goes when the fold closes, not merely on the next render", async () => {
    bar();
    await openFold();
    await logReading("101.4");
    expect(screen.queryByTestId("fever-offer")).toBeTruthy();

    await openFold(); // the same toggle, now closing the fold
    expect(screen.queryByTestId("temp-quick-entry")).toBeNull();
    expect(screen.queryByTestId("fever-offer")).toBeNull();
  });

  // A NON-FEVER READING OFFERS NOTHING, and the fold closes exactly as it always
  // did — the positive control that proves the fixture CAN produce the fever branch
  // is the case above; this is the fixture that must NOT.
  it("offers nothing and closes the fold on an ordinary reading", async () => {
    bar();
    await openFold();
    await logReading("98.6");
    expect(screen.queryByTestId("fever-offer")).toBeNull();
    expect(screen.queryByTestId("temp-quick-entry")).toBeNull();
  });
});

describe("no toast, no persistent nudge carries the offer (#4712 judgement 1)", () => {
  it("the fever toast is message-only — no `action`, ever", async () => {
    bar();
    await openFold();
    await logReading("103.4");
    const feverToasts = toasts.filter((t) => t.message.includes("fever"));
    expect(feverToasts.length).toBeGreaterThan(0);
    for (const t of feverToasts) {
      expect(t.options?.action).toBeUndefined();
    }
  });

  it("StaleEpisodeNudge never mounts on this path", async () => {
    bar();
    await openFold();
    await logReading("103.4");
    expect(screen.getByTestId("fever-offer")).toBeTruthy();
    expect(screen.queryByTestId("stale-episode-nudge")).toBeNull();
  });
});

describe("the row grammar: primary episode action, dose beside it, Not now as a link (#4712 judgement 1)", () => {
  it("Open an episode is primary; Not now carries no button-control class", async () => {
    bar({ hasOpenEpisode: false });
    await openFold();
    await logReading("102.1");

    const openEpisode = screen.getByTestId("fever-offer-open-episode");
    expect(openEpisode.className).toContain("button-control-primary");

    const notNow = screen.getByTestId("fever-offer-dismiss");
    expect(notNow.className).not.toContain("button-control");
  });

  it("the dose offer reuses IllnessMedicationLogger, beside Open an episode, never a second control", async () => {
    bar({ hasOpenEpisode: false });
    await openFold();
    await logReading("102.1");

    const row = screen.getByTestId("fever-offer-open-episode").parentElement!;
    const dose = screen.getByTestId("fever-offer-dose");
    // SIDE BY SIDE: the same row contains both.
    expect(row.contains(dose)).toBe(true);
    // IllnessMedicationLogger's own chip, not a hand-rolled dose button — the chip
    // names the antipyretic, exactly as the cockpit's own meds section would.
    expect(
      screen.getByTestId(`cockpit-med-chip-${ANTIPYRETIC.id}`).textContent
    ).toBe("Ibuprofen");
  });

  // WITH NO OPEN EPISODE: the AC's own words. Accepting posts the reading's subject
  // through the SAME door #4922 wired (activateIllnessForSymptoms), and dismisses
  // the block — the durable surface is the episode it just opened, not this block.
  it("accepting opens the episode for the reading's subject and dismisses the offer", async () => {
    bar({ hasOpenEpisode: false });
    await openFold();
    await logReading("102.1");

    await act(async () =>
      fireEvent.click(screen.getByTestId("fever-offer-open-episode"))
    );
    expect(String(posted.activate[0].get("profile_id"))).toBe(String(SUBJECT));
    expect(screen.queryByTestId("fever-offer")).toBeNull();
  });

  // DECLINING WRITES NOTHING EPISODE-SHAPED (the AC's own words): the reading already
  // landed (the temperature POST above), and "Not now" adds no further write.
  it("Not now dismisses without opening an episode or logging a dose", async () => {
    bar({ hasOpenEpisode: false });
    await openFold();
    await logReading("102.1");

    await act(async () =>
      fireEvent.click(screen.getByTestId("fever-offer-dismiss"))
    );
    expect(screen.queryByTestId("fever-offer")).toBeNull();
    expect(posted.activate).toBeUndefined();
    expect(posted.dose).toBeUndefined();
  });

  // WITH AN OPEN EPISODE ALREADY KNOWN: the offer does not ask to open the one it is
  // already in — the AC's "with no open episode" condition, the other side of it.
  it("omits the episode action when the write already names an open episode", async () => {
    bar({ hasOpenEpisode: true });
    await openFold();
    await logReading("102.1");
    expect(screen.getByTestId("fever-offer")).toBeTruthy();
    expect(screen.queryByTestId("fever-offer-open-episode")).toBeNull();
    // The dose offer is independent of the episode question — still there.
    expect(screen.getByTestId("fever-offer-dose")).toBeTruthy();
  });

  // NO ELIGIBLE PRN: the dose side is skipped rather than rendering an empty logger.
  it("omits the dose offer when no eligible PRN exists", async () => {
    bar({ hasOpenEpisode: false, antipyreticMeds: [] });
    await openFold();
    await logReading("102.1");
    expect(screen.getByTestId("fever-offer")).toBeTruthy();
    expect(screen.getByTestId("fever-offer-open-episode")).toBeTruthy();
    expect(screen.queryByTestId("fever-offer-dose")).toBeNull();
  });
});

// ONE DOSE PROMPT AT A TIME (#4712, owner ruling 2026-09-04 11:20 UTC part 2).
//
// The cockpit's persistent Meds section (`cockpit-prn`) renders a
// `cockpit-med-chip-<id>` for every active PRN, and `antipyreticPrnMeds` is that same
// list narrowed — so the fold's dose offer could only ever re-show a chip already on
// screen. CI found it as a strict-mode violation (`dashboard-illness-phase5.spec.ts`):
// two elements for one medication inside one situation group. It was fixed by
// suppressing the DOSE half, which left the ruled block's dose side rendering nowhere
// at all; the ruling resolves it the other way — the PERSISTENT SECTION YIELDS while
// the offer is live.
//
// The chip count is the assertion either way, and it is the one that would have caught
// the original defect: exactly ONE `cockpit-med-chip-501` at every moment, moving
// between the two surfaces rather than appearing on both.
describe("the Meds section yields to the fold's dose offer (#4712 ruling part 2)", () => {
  const EPISODE: AssembledEpisode = {
    id: 900,
    situation: "Stomach bug",
    start: TODAY,
    end: null,
    ongoing: true,
    firstDay: TODAY,
    lastActiveDay: TODAY,
    asOf: TODAY,
    dayCount: 1,
    symptoms: [],
    distinctSymptomCount: 0,
    temperatures: [],
    maxTempF: null,
    latestTemp: null,
    medications: [],
    totalAdministrations: 0,
    conditions: [],
    notes: [],
  };

  const STATUS = {
    dayLabel: "Day 1",
    dayOnlyLabel: null,
    temperature: null,
    lastMeds: null,
    worsening: false,
  };

  // A PRN that is NOT a fever reducer, so the fold has no dose to offer for it — the
  // fixture that must NOT reach the yielding state the assertions above forbid.
  const ANTACID: PrnMedForQuickLog = {
    ...ANTIPYRETIC,
    id: 502,
    name: "Antacid",
  };

  function cockpitModel(
    prnMeds: PrnMedForQuickLog[],
    antipyreticPrnMeds: PrnMedForQuickLog[]
  ): DashboardIllnessCockpitModel {
    return {
      date: TODAY,
      temperatureUnit: "F",
      timeZone: "UTC",
      nowIso: new Date().toISOString(),
      feverFree: null,
      controls: {
        staleNudge: null,
        medReconciliation: [],
        prnMeds,
        antipyreticPrnMeds,
        intakeOptions: {
          medications: [],
          medicationBrands: [],
          supplements: [],
          stacks: [],
        },
        intakeForm: INTAKE_CONTEXT,
        initial: {},
        initialNotes: {},
        customNames: [],
        rankedKeys: [],
      },
    };
  }

  function renderCockpit(
    episodeId: number | null = EPISODE.id,
    model = cockpitModel([ANTIPYRETIC], [ANTIPYRETIC])
  ): void {
    render(
      <ConfirmProvider>
        <IllnessCockpitBody
          profileId={SUBJECT}
          episode={{ ...EPISODE, id: episodeId }}
          status={STATUS}
          crossProfile={false}
          canWrite
          ownsSharedProfileControls
          hasPluralOpenEpisodes={false}
          profileDisplayName="Kid"
          model={model}
        />
      </ConfirmProvider>
    );
  }

  const chips = () =>
    screen.queryAllByTestId(`cockpit-med-chip-${ANTIPYRETIC.id}`);

  it("moves the antipyretic's chip into the offer rather than showing a second one", async () => {
    renderCockpit();
    // Before the reading: the persistent section owns the chip.
    expect(chips()).toHaveLength(1);
    expect(screen.getByTestId("cockpit-prn")).toBeTruthy();

    await openFold();
    await logReading("102.1");
    // The dose half is now reachable — the thing that rendered nowhere before this
    // ruling — and the persistent section has stepped aside for it.
    expect(screen.getByTestId("fever-offer-dose")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-prn")).toBeNull();
    expect(chips()).toHaveLength(1);
    expect(screen.getByTestId("fever-offer").contains(chips()[0])).toBe(true);
  });

  it("gives the section back when the offer is dismissed", async () => {
    renderCockpit();
    await openFold();
    await logReading("102.1");
    await act(async () =>
      fireEvent.click(screen.getByTestId("fever-offer-dismiss"))
    );
    expect(screen.getByTestId("cockpit-prn")).toBeTruthy();
    expect(chips()).toHaveLength(1);
  });

  it("gives the section back when the fold closes", async () => {
    renderCockpit();
    await openFold();
    await logReading("102.1");
    expect(screen.queryByTestId("cockpit-prn")).toBeNull();
    await openFold(); // the same toggle, now closing the fold
    expect(screen.getByTestId("cockpit-prn")).toBeTruthy();
    expect(chips()).toHaveLength(1);
  });

  // THE SECTION YIELDS TO A DOSE, NEVER TO THE EPISODE HALF ALONE. With no eligible
  // antipyretic the offer takes nothing off the screen — otherwise a fever reading
  // would hide the meds a caregiver came for and offer nothing in their place.
  it("does not yield when the offer carries no dose", async () => {
    renderCockpit(null, cockpitModel([ANTACID], []));
    await openFold();
    await logReading("102.1");
    expect(screen.getByTestId("fever-offer-open-episode")).toBeTruthy();
    expect(screen.queryByTestId("fever-offer-dose")).toBeNull();
    expect(screen.getByTestId("cockpit-prn")).toBeTruthy();
    expect(
      screen.getAllByTestId(`cockpit-med-chip-${ANTACID.id}`)
    ).toHaveLength(1);
  });

  // BOTH HALVES AT ONCE, on one surface, for the first time: the 16:47Z comment
  // recorded that the ruled block had no mount where it rendered whole.
  it("offers the episode and the dose side by side when this write names no episode", async () => {
    renderCockpit(null);
    await openFold();
    await logReading("102.1");
    const row = screen.getByTestId("fever-offer-open-episode").parentElement!;
    expect(row.contains(screen.getByTestId("fever-offer-dose"))).toBe(true);
    expect(screen.queryByTestId("cockpit-prn")).toBeNull();
    expect(chips()).toHaveLength(1);
  });
});
