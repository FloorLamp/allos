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

// A REGRESSION FOUND IN CI (#4712, e2e `dashboard-illness-phase5.spec.ts:84`): the
// cockpit's own persistent Meds section (`cockpit-prn`) already renders a
// `cockpit-med-chip-<id>` for every active PRN, including any antipyretic. Feeding
// that SAME list to the fold's dose offer put a second chip for one medication inside
// one situation group. The ruling offers what is not already on screen; it does not
// re-offer what the group already has — so `IllnessCockpitBody` no longer threads its
// PRN data into the fold at all (see the code comment there), and this proves it stays
// that way: the persistent section renders the chip, the fold offers only the
// episode, and the medication's testid resolves to exactly one element throughout.
describe("the offer never duplicates a chip the cockpit's own Meds section already shows (#4712)", () => {
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

  function cockpitModel(): DashboardIllnessCockpitModel {
    return {
      date: TODAY,
      temperatureUnit: "F",
      timeZone: "UTC",
      nowIso: new Date().toISOString(),
      feverFree: null,
      controls: {
        staleNudge: null,
        medReconciliation: [],
        prnMeds: [ANTIPYRETIC],
        antipyreticPrnMeds: [ANTIPYRETIC],
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

  function renderCockpit(episodeId: number | null = EPISODE.id): void {
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
          model={cockpitModel()}
        />
      </ConfirmProvider>
    );
  }

  it("the Meds section alone renders the medication's chip", () => {
    renderCockpit();
    expect(
      screen.getAllByTestId(`cockpit-med-chip-${ANTIPYRETIC.id}`)
    ).toHaveLength(1);
  });

  it("logging a fever here offers NOTHING — not a block with an empty dose side", async () => {
    renderCockpit();
    await openFold();
    await logReading("102.1");
    // Both halves are already answered by the surfaces around this fold: the
    // episode is open (this cockpit only exists because one is), and the
    // medication is already a chip a few px below. The fold closes exactly as an
    // ordinary reading would rather than opening an offer with nothing left to
    // offer — the fix is NOT "show the block with both actions hidden".
    expect(screen.queryByTestId("fever-offer")).toBeNull();
    expect(screen.queryByTestId("temp-quick-entry")).toBeNull();
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG: one chip, not two,
    // for the same medication inside this one cockpit.
    expect(
      screen.getAllByTestId(`cockpit-med-chip-${ANTIPYRETIC.id}`)
    ).toHaveLength(1);
  });

  // THE EPISODE HALF STILL WORKS on this same mount, on its own — the fix
  // suppresses only the DOSE side (always redundant here), never the episode
  // question when there genuinely is none known yet.
  it("still offers the episode alone when this write has none, without touching the chip count", async () => {
    renderCockpit(null);
    await openFold();
    await logReading("102.1");
    expect(screen.getByTestId("fever-offer-open-episode")).toBeTruthy();
    expect(screen.queryByTestId("fever-offer-dose")).toBeNull();
    expect(
      screen.getAllByTestId(`cockpit-med-chip-${ANTIPYRETIC.id}`)
    ).toHaveLength(1);
  });
});
