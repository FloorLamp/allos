import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import { ToastProvider } from "@/components/Toast";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import QuickSymptomPanel from "@/components/quick-entry/QuickSymptomPanel";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";

// NO SECOND WRITE PATH, ASSERTED RATHER THAN PROMISED (#4064/#1633).
//
// The quick logger's Care segment gains symptom capture, the well-day capture and the
// mark-as-illness bridge so the #3366 ruling can retire the dashboard tail's card that
// carries them today. The whole claim is that the sheet REACHES those controls rather
// than reproducing them — and the only place that claim can be checked is a mounted
// tree, because what a control posts is assembled in its click handler
// (docs/internals/component-tests.md).
//
// SO THIS COMPARES TWO REAL MOUNTS, not one helper called twice. Each row below builds
// the tree its surface actually renders — the dashboard's own JSX from
// app/(app)/page.tsx, the sheet's panel, the illness cockpit's, the Cycles page's —
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
  logTemperature: vi.fn(async () => ({ ok: true as const })),
  activateIllnessForSymptoms: vi.fn(async () => ({ ok: true as const })),
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

/** The dashboard's well-day card, exactly as app/(app)/page.tsx renders it. */
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
function sheetMount(trackingIllness: string[] = []) {
  return (
    <LoggedViaSurface value="quick-log">
      <QuickSymptomPanel
        today={TODAY}
        severities={SEVERITIES}
        notes={NOTES}
        customNames={CUSTOMS}
        rankedKeys={RANKED}
        temperatureUnit="F"
        textIntakeEnabled={false}
        trackingIllness={trackingIllness}
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

describe("the sheet's symptom row posts what the dashboard card posts", () => {
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
        profileId: String(COCKPIT_PROFILE),
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
