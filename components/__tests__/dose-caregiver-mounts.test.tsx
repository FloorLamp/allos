import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeItem } from "@/lib/types";
import type { SubjectInfo } from "@/lib/scope";
import type { MedStripMember } from "@/lib/medication-multi-view";
import MedicationCard from "@/app/(app)/medications/MedicationCard";
import MedicationsTodayPanel from "@/app/(app)/medications/MedicationsTodayPanel";
import MedicationTodayStrip from "@/app/(app)/medications/MedicationTodayStrip";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";

// A CAREGIVER'S DOSE WRITE REACHES THE MEDICATION CARD AND THE EVERYONE STRIP (#4429).
//
// The write path itself is old and gated: `setDoseStatus` takes an explicit `profileId`
// and gates it on the TARGET through requireProfileWriteAccess, which
// lib/__action_tests__/medications-multi-view.actions.test.ts pins in both directions
// (a granted member lands, an ungranted and a read-only one are refused before any
// write). What was missing was the OFFER — two surfaces that never handed the control
// a target, so a caregiver could confirm a member's dose from the multi-view board and
// from nowhere else.
//
// So this tier asserts what the action tier structurally cannot see: which id each
// mount POSTS, and whether it renders a write control at all. Both halves matter and
// the second is the boundary — a surface that offers a control it has no grant for is
// how a capability gap becomes a leak, so every render claim below is paired with the
// grant that must turn it OFF.

const mocks = vi.hoisted(() => ({
  setDoseStatus: vi.fn(),
  logMedicationAdministration: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/medications/41",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
// The ledger stands in for the real one, but its `tap` RUNS the write and settles it —
// a `tap: vi.fn()` stub would make every click a no-op and quietly pass any assertion
// about what a click posts.
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (outcome: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));
vi.mock("@/components/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  setDoseStatus: mocks.setDoseStatus,
  updateIntakeItem: vi.fn(),
  deleteIntakeItem: vi.fn(),
  deleteAdministration: vi.fn(),
}));
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: mocks.logMedicationAdministration,
  stopMedication: vi.fn(),
  restartMedication: vi.fn(),
  addSideEffect: vi.fn(),
  setSideEffectResolved: vi.fn(),
  deleteSideEffect: vi.fn(),
  promoteSideEffectToIntolerance: vi.fn(),
}));

const SUBJECT = 42;
const ACTOR = 7;
const DOSE_ID = 501;
const MED_ID = 41;

const MED = {
  id: MED_ID,
  name: "Lisinopril",
  notes: null,
  active: 1,
  created_at: "2026-01-04T09:00:00Z",
  condition: "daily",
  obligation: "should",
  brand: null,
  product: null,
  situation: null,
  situation_id: null,
  pause_situation: null,
  pause_situation_id: null,
  stack: null,
  critical: 0,
  escalate_after_min: null,
  escalate_chat_id: null,
  quantity_on_hand: null,
  qty_per_dose: 1,
  supply_id: null,
  kind: "medication",
} as unknown as IntakeItem;

const PRN_MED = { ...MED, obligation: "may" } as IntakeItem;

const DOSE = {
  id: DOSE_ID,
  item_id: MED_ID,
  amount: "10 mg",
  time_of_day: "08:00",
  food_timing: "any",
  sort: 0,
} as unknown as Parameters<typeof MedicationCard>[0]["doses"][number];

// jsdom has no media-query engine, and the toast provider asks it about reduced motion
// the moment it mounts.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setDoseStatus.mockResolvedValue({ ok: true, outcome: "logged" });
  mocks.logMedicationAdministration.mockResolvedValue({
    ok: true,
    outcome: "logged",
  });
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
});

/** What the one mocked write was actually posted, as a plain object. */
function postedTo(fn: { mock: { calls: unknown[][] } }): Record<string, string> {
  expect(fn.mock.calls).toHaveLength(1);
  const body = fn.mock.calls[0]![0] as FormData;
  return Object.fromEntries(
    [...body.entries()].map(([k, v]) => [k, String(v)])
  );
}

function renderCard(props: {
  medication?: IntakeItem;
  canWrite?: boolean;
  subjectProfileId?: number;
}) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <MedicationCard
          medication={props.medication ?? MED}
          doses={[DOSE]}
          allIntakeItems={[]}
          stackItems={[]}
          pgxVariants={[]}
          pairs={[]}
          takenDoseIds={new Set<number>()}
          skippedDoseIds={new Set<number>()}
          due
          courses={[]}
          sideEffects={[]}
          strip={[]}
          refillRate={null}
          todayStr="2026-03-02"
          nowIso="2026-03-02T13:20:00Z"
          timezone="UTC"
          historyMaxDate="2026-03-02"
          defaultHistoryTime="13:20"
          canWrite={props.canWrite ?? true}
          subjectProfileId={props.subjectProfileId}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function renderPanel(profileId: number | undefined) {
  return render(
    <ToastProvider>
      <MedicationsTodayPanel
        scheduled={[
          {
            med: MED,
            doses: [DOSE],
            due: true,
            takenDoseTimes: {},
          },
        ] as unknown as Parameters<typeof MedicationsTodayPanel>[0]["scheduled"]}
        prnToday={[]}
        taken={new Set<number>()}
        skipped={new Set<number>()}
        nowHhmm="09:00"
        nowIso="2026-03-02T13:20:00Z"
        timeFormat="24h"
        timezone="UTC"
        profileId={profileId}
      />
    </ToastProvider>
  );
}

function subject(access: "read" | "write"): SubjectInfo {
  return {
    profileId: SUBJECT,
    name: "Mia",
    photoPath: null,
    photoVersion: 0,
    access,
  };
}

function strip(doseId: number | null): MedStripMember {
  return {
    profileId: SUBJECT,
    dueDoses: [
      {
        key: `dose:${doseId ?? 0}`,
        title: "Lisinopril",
        detail: null,
        dueText: "Morning",
        doseId,
      },
    ],
    lowRefills: [
      {
        key: "refill:9",
        title: "Metformin",
        detail: "4 days left",
        dueText: null,
        // A refill row has no dose to resolve — the ONE shape on this strip that must
        // never grow a control however the member is granted.
        doseId: null,
      },
    ],
  };
}

function renderStrip(access: "read" | "write", doseId: number | null = DOSE_ID) {
  return render(
    <ToastProvider>
      <MedicationTodayStrip
        members={[{ subject: subject(access), strip: strip(doseId) }]}
        actingProfileId={ACTOR}
      />
    </ToastProvider>
  );
}

async function takeDose(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("dose-take"));
  });
}

describe("the medication card's dose controls follow the surface's subject (#4429)", () => {
  // THE PARITY CRITERION, as one comparison rather than two spellings of a body: the
  // card and the board panel mount the SAME control, so the only way they can disagree
  // about a member's dose is by handing it different props — which is exactly the
  // defect, and exactly what a body-to-body equality can see.
  it("posts the same body the board's Today panel posts for that member's dose", async () => {
    renderCard({ canWrite: false, subjectProfileId: SUBJECT });
    await takeDose();
    const fromCard = postedTo(mocks.setDoseStatus);

    mocks.setDoseStatus.mockClear();
    cleanup();
    renderPanel(SUBJECT);
    await takeDose();
    const fromPanel = postedTo(mocks.setDoseStatus);

    expect(fromCard).toEqual(fromPanel);
    expect(fromCard).toMatchObject({
      dose_id: String(DOSE_ID),
      status: "taken",
      profileId: String(SUBJECT),
    });
  });

  // THE ACTING MOUNT DID NOT MOVE: no subject, no target, byte-identical to what the
  // card posted before this issue.
  it("posts no target on the acting profile's own card", async () => {
    renderCard({ canWrite: true });
    await takeDose();
    expect(postedTo(mocks.setDoseStatus).profileId).toBeUndefined();
  });

  // THE BOUNDARY. A cross-profile card the login may NOT write reaches this component
  // with no subject and no `canWrite` — the detail page resolves the subject only after
  // asking for write access on it — and there must then be nothing to tap. Asserted as
  // the row's read-only receipt AND the absence of the control, because an absence
  // alone also passes on a card that failed to render its Today block at all.
  it("offers no dose control at all when the login may not write the subject", () => {
    renderCard({ canWrite: false });
    expect(screen.getByTestId("scheduled-dose-readonly")).toBeTruthy();
    expect(screen.queryByTestId("dose-take")).toBeNull();
    expect(mocks.setDoseStatus).not.toHaveBeenCalled();
  });

  // The PRN half of the same widening: a log button that exists only for a subject the
  // login may write, and that names its target when it does.
  it.each([
    [
      "a writable subject",
      { canWrite: false, subjectProfileId: SUBJECT } as const,
      true,
    ],
    ["the acting profile", { canWrite: true } as const, true],
    ["a read-only cross-profile card", { canWrite: false } as const, false],
  ] as [string, { canWrite: boolean; subjectProfileId?: number }, boolean][])(
    "%s: PRN log offered = %s",
    async (_case, props, offered) => {
      renderCard({ ...props, medication: PRN_MED });
      const button = screen.queryByTestId("prn-log-now");
      expect(button != null).toBe(offered);
      if (!button) return;
      await act(async () => fireEvent.click(button));
      expect(postedTo(mocks.logMedicationAdministration).profileId).toBe(
        props.subjectProfileId != null ? String(SUBJECT) : undefined
      );
    }
  );
});

describe("the everyone strip's due rows carry the tri-state (#4429)", () => {
  it("mounts the control on a write-granted member's due dose and targets them", async () => {
    renderStrip("write");
    // The jump link the strip already had is still the row's navigation.
    expect(screen.getByTestId("med-everyone-due").getAttribute("href")).toBe(
      `#med-board-${SUBJECT}`
    );
    await takeDose();
    expect(postedTo(mocks.setDoseStatus)).toMatchObject({
      dose_id: String(DOSE_ID),
      status: "taken",
      profileId: String(SUBJECT),
    });
  });

  // THE BOUNDARY, on the strip's own gate. Same member, same due dose, one grant
  // different — so a control that appeared here would be an offer the login has no
  // access for, and the link must survive either way (the row is still a jump).
  it("offers a read-only-granted member the link and no control", () => {
    renderStrip("read");
    expect(screen.getByTestId("med-everyone-due")).toBeTruthy();
    expect(screen.queryByTestId("dose-status")).toBeNull();
  });

  // A low refill is not a dose, so no grant makes it resolvable.
  it("never grows a control on a row with no dose behind it", () => {
    renderStrip("write", null);
    expect(screen.getByTestId("med-everyone-refill")).toBeTruthy();
    expect(screen.queryByTestId("dose-status")).toBeNull();
  });
});
