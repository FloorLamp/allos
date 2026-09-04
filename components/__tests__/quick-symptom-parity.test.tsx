import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import { ToastProvider } from "@/components/Toast";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import QuickSymptomPanel from "@/components/quick-entry/QuickSymptomPanel";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";
import { dateStrInTz } from "@/lib/date";

// NO SECOND WRITE PATH, ASSERTED RATHER THAN PROMISED (#4064/#1633).
//
// The quick logger's Care segment gained symptom capture, the well-day capture and the
// mark-as-illness bridge so the #3366 ruling could retire the dashboard tail's card
// that carried them. That card is gone; the mount below is kept as the RETIRED SHAPE
// the sheet has to keep matching, which is the whole point of having landed the sheet
// row first. The claim is that the sheet REACHES those controls rather than
// reproducing them — and the only place that claim can be checked is a mounted
// tree, because what a control posts is assembled in its click handler
// (docs/internals/component-tests.md).
//
// SO THIS COMPARES TWO REAL MOUNTS, not one helper called twice. Each row below builds
// the tree its surface renders — the retired dashboard card's JSX, the sheet's panel,
// the illness cockpit's, the Cycles page's —
// drives the SAME tap through it, and captures the FormData that reached `logSymptom`.
// Two calls into `withTarget` would prove nothing about any of them.

const actions = vi.hoisted(() => ({
  // Answers from the payload it was handed, the way the real action does, so the
  // optimistic ledger reconciles to the severity that was actually posted.
  logSymptom: vi.fn(async (formData: FormData) => ({
    ok: true as const,
    severity: Number(formData.get("severity")),
  })),
  lowerSymptom: vi.fn(async () => ({ ok: true as const, severity: 1 })),
  setSymptomNote: vi.fn(async () => ({ ok: true as const })),
  removeSymptom: vi.fn(async () => ({ ok: true as const })),
  // Answers from the posted reading, so the fever branch this file now drives is
  // reachable rather than mocked into existence: >= 100.4 °F is the flag the store
  // derives.
  logTemperature: vi.fn(async (formData: FormData) => {
    const degF = Number(formData.get("temperature"));
    return {
      ok: true as const,
      degF,
      flag: degF >= 100.4 ? ("high" as const) : null,
      redFlag: null,
    };
  }),
  activateIllnessForSymptoms: vi.fn(async () => ({
    ok: true as const,
    episodeId: 900,
  })),
  suggestSymptomsFromText: vi.fn(async () => ({
    ok: false as const,
    reason: "empty" as const,
  })),
}));
vi.mock("@/app/(app)/symptom-actions", () => actions);
vi.mock("@/app/(app)/undo-actions", () => ({ undoDelete: vi.fn() }));
vi.mock("@/lib/offline/snapshot-db", () => ({ clearSnapshots: vi.fn() }));

// One day's already-logged state, shared by every mount so a payload difference can
// only come from the MOUNT and never from the data it was handed.
const TODAY = "2026-08-29";
const SEVERITIES = { fatigue: 2 };
const NOTES = { fatigue: "since lunch" };
const CUSTOMS = ["shoulder ache"];
const RANKED = ["headache", "fatigue"];
const COCKPIT_PROFILE = 42;
const COCKPIT_EPISODE = 7;
// The household member the sheet's title-row chip can name (#4932), and the zone the
// gather resolves for THEM — deliberately not the browser's.
const SHEET_SUBJECT = 77;
const SUBJECT_TZ = "Pacific/Auckland";
// The subject's own today. The fold requires a stated minute on any day that has
// ended (#4685), so a reading logged without one only goes through when the bar is
// standing on the day the SUBJECT is having — which is the zone the gather resolves
// and the panel now passes, not the browser's.
const SUBJECT_TODAY = dateStrInTz(SUBJECT_TZ);

/**
 * The dashboard's well-day card, exactly as app/(app)/page.tsx rendered it until
 * #3366 retired the mount. Kept: it is the payload the sheet inherited, so this is
 * what "no coverage gap" means in bytes.
 */
function dashboardMount() {
  return (
    <LoggedViaSurface value="dashboard-widget">
      <SymptomLogBar
        date={TODAY}
        initial={SEVERITIES}
        initialNotes={NOTES}
        symptoms={PICKER_SYMPTOMS}
        customNames={CUSTOMS}
        rankedKeys={RANKED}
        suggestActivateIllness
        temperatureUnit="F"
        textIntakeEnabled={false}
      />
    </LoggedViaSurface>
  );
}

/** The quick-log sheet's Care row, exactly as QuickEntryProvider mounts it. */
function sheetMount(
  trackingIllness: string[] = [],
  subjectProfileId?: number,
  today: string = TODAY
) {
  return (
    <LoggedViaSurface value="quick-log">
      <QuickSymptomPanel
        today={today}
        severities={SEVERITIES}
        notes={NOTES}
        customNames={CUSTOMS}
        rankedKeys={RANKED}
        temperatureUnit="F"
        timeZone={SUBJECT_TZ}
        textIntakeEnabled={false}
        trackingIllness={trackingIllness}
        subjectProfileId={subjectProfileId}
      />
    </LoggedViaSurface>
  );
}

/** The illness Now cockpit, which logs for a TARGET profile inside an episode. */
function cockpitMount() {
  return (
    <LoggedViaSurface value="dashboard-widget">
      <SymptomLogBar
        date={TODAY}
        initial={SEVERITIES}
        initialNotes={NOTES}
        symptoms={PICKER_SYMPTOMS}
        customNames={CUSTOMS}
        rankedKeys={RANKED}
        suggestActivateIllness={false}
        temperatureUnit="F"
        profileId={COCKPIT_PROFILE}
        episodeId={COCKPIT_EPISODE}
        showTitle={false}
      />
    </LoggedViaSurface>
  );
}

/** The Cycles page's symptom section — a page mount, so it declares no region. */
function cyclesMount() {
  return (
    <SymptomLogBar
      date={TODAY}
      initial={SEVERITIES}
      initialNotes={NOTES}
      symptoms={PICKER_SYMPTOMS}
      customNames={CUSTOMS}
      rankedKeys={RANKED}
      suggestActivateIllness={false}
      temperatureUnit="F"
      showTitle={false}
    />
  );
}

/** Log headache at severity 3 through whichever tree is mounted, and read the post. */
async function tapHeadache(
  tree: React.ReactElement
): Promise<Record<string, string>> {
  actions.logSymptom.mockClear();
  const view = render(<ToastProvider>{tree}</ToastProvider>);
  fireEvent.click(screen.getByTestId("symptom-add-picker-toggle"));
  fireEvent.click(await screen.findByTestId("symptom-pick-headache"));
  await waitFor(() => expect(actions.logSymptom).toHaveBeenCalled());
  actions.logSymptom.mockClear();
  fireEvent.click(await screen.findByTestId("symptom-headache-sev-3"));
  await waitFor(() => expect(actions.logSymptom).toHaveBeenCalled());
  const posted = actions.logSymptom.mock.calls.at(-1)![0];
  view.unmount();
  return Object.fromEntries(
    [...posted.entries()].map(([k, v]) => [k, String(v)])
  );
}

describe("the sheet's symptom row posts what the retired dashboard card posted", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is byte-identical apart from the surface each mounting declares", async () => {
    const dashboard = await tapHeadache(dashboardMount());
    const sheet = await tapHeadache(sheetMount());

    // The positive control FIRST: an empty payload, or one that lost the symptom, would
    // satisfy every equality below while proving nothing. This is what stops a mount
    // that posts nothing from reading as parity.
    expect(dashboard).toMatchObject({
      symptom: "headache",
      severity: "3",
      date: TODAY,
    });

    // The comparison, as a DIFF rather than a pair of expectations: every key whose
    // value differs between the two real posts, named. Exactly one may.
    const differing = [
      ...new Set([...Object.keys(dashboard), ...Object.keys(sheet)]),
    ].filter((key) => dashboard[key] !== sheet[key]);
    expect(differing).toEqual([LOGGED_VIA_FIELD]);
    expect(dashboard[LOGGED_VIA_FIELD]).toBe("dashboard-widget");
    expect(sheet[LOGGED_VIA_FIELD]).toBe("quick-log");
  });

  // AC3: the two SITUATIONAL mounts are untouched. Asserted by driving them, not by
  // reading the diff — a change to the shared bar would reach them without touching
  // their own call sites, which is precisely the risk of adding a fifth mounting.
  it.each([
    [
      "the illness cockpit still targets its profile and episode",
      cockpitMount,
      {
        symptom: "headache",
        severity: "3",
        date: TODAY,
        profile_id: String(COCKPIT_PROFILE),
        episodeId: String(COCKPIT_EPISODE),
        [LOGGED_VIA_FIELD]: "dashboard-widget",
      },
    ],
    [
      "the Cycles page still posts a plain page write",
      cyclesMount,
      {
        symptom: "headache",
        severity: "3",
        date: TODAY,
        [LOGGED_VIA_FIELD]: "page",
      },
    ],
  ] as const)("%s", async (_name, mount, expected) => {
    expect(await tapHeadache(mount())).toEqual(expected);
  });

  // The illness verb renders from state (docs/internals/stateful-affordances.md). The
  // bar's own bridge is the "nothing tracked" arm and is unchanged in every mounting;
  // the panel supplies the other arm, so the sheet never offers to start something that
  // is already running — and never goes silent about it either.
  it.each([
    ["offers the bridge when nothing is tracked", [] as string[], null],
    ["names what is tracked instead", ["Illness"], "Tracking: Illness"],
  ])("%s", async (_name, tracking, line) => {
    const view = render(<ToastProvider>{sheetMount(tracking)}</ToastProvider>);
    expect(Boolean(screen.queryByTestId("symptom-illness-bridge"))).toBe(
      line == null
    );
    expect(
      screen.queryByTestId("quick-symptom-tracking")?.textContent ?? null
    ).toBe(line);
    view.unmount();
  });
});

// ONE ILLNESS PANEL (#4712 item 2). The bar could always draw the temperature fold;
// every mount that asked for it was episode-gated, so the sheet's Care segment carried
// half the illness statement and a feverish child's reading went through the Body
// segment's measurements form — which renders `unavailable` for a non-acting subject
// (#4932 invariant 2), i.e. it needed a profile switch first.
//
// The claims a mounted tree can see: the fold IS there, what it posts carries the
// SUBJECT the sheet's chip named and the surface the sheet declares, and the fever
// offer resolves its episode half from the same tracked-illness list the bridge above
// it resolves from — never offering to open the episode already running.
describe("the sheet's symptom row takes a temperature too (#4712 item 2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts the reading for the chip's subject, on the quick-log surface", async () => {
    const view = render(
      <ToastProvider>
        {sheetMount([], SHEET_SUBJECT, SUBJECT_TODAY)}
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId("temp-quick-toggle"));
    fireEvent.change(await screen.findByTestId("temp-quick-input"), {
      target: { value: "101.4" },
    });
    fireEvent.click(screen.getByTestId("temp-quick-save"));
    await waitFor(() => expect(actions.logTemperature).toHaveBeenCalled());

    const posted = Object.fromEntries(
      [...actions.logTemperature.mock.calls.at(-1)![0].entries()].map(
        ([k, v]) => [k, String(v)]
      )
    );
    expect(posted).toMatchObject({
      temperature: "101.4",
      date: SUBJECT_TODAY,
      profile_id: String(SHEET_SUBJECT),
      [LOGGED_VIA_FIELD]: "quick-log",
    });
    view.unmount();
  });

  // The offer's episode half reads the SAME tracked-illness list the bridge above it
  // reads, so the two cannot disagree about whether this subject is already sick. An
  // active illness situation IS an open episode, so with one running the sheet has
  // nothing to offer and the fold closes exactly as it did before this change — the
  // fold's own `offers` rule, not a second opinion about it.
  it.each([
    ["offers the episode when nothing is tracked", [] as string[], true],
    ["offers nothing while an episode is already running", ["Illness"], false],
  ])("%s", async (_name, tracking, offered) => {
    const view = render(
      <ToastProvider>
        {sheetMount(tracking, undefined, SUBJECT_TODAY)}
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId("temp-quick-toggle"));
    fireEvent.change(await screen.findByTestId("temp-quick-input"), {
      target: { value: "101.4" },
    });
    fireEvent.click(screen.getByTestId("temp-quick-save"));
    // The reading LANDS either way — the offer is what differs, never the write.
    await waitFor(() => expect(actions.logTemperature).toHaveBeenCalled());
    await waitFor(() =>
      expect(Boolean(screen.queryByTestId("fever-offer-open-episode"))).toBe(
        offered
      )
    );
    expect(Boolean(screen.queryByTestId("fever-offer"))).toBe(offered);
    view.unmount();
  });
});
