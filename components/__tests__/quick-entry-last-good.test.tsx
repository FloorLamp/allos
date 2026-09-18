import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, useEffect, useRef } from "react";
import { ToastProvider } from "@/components/Toast";
import DirtyFormProvider from "@/components/DirtyFormRegistry";
import QuickEntryProvider, {
  QuickEntryVisitBodies,
  remounts,
  useQuickEntry,
  useQuickEntryVisit,
} from "@/components/QuickEntryProvider";
import type { SessionProfile } from "@/lib/auth";
import { clearLastGood } from "@/lib/offline/quick-entry-read";
import { SNAPSHOT_VERSION, type AnySnapshot } from "@/lib/offline/snapshots";
import {
  DayContextProvider,
  ProfileDaysBoundary,
} from "@/components/DayContext";
import type { AppRoute } from "@/lib/hrefs";
import type { QuickEntryPrn } from "@/app/(app)/quick-entry-actions";
import type { QuickEntryForm } from "@/lib/quick-log";

// COMPONENT TIER — #3416/#4454, the sheet's offline OPEN path: last-good render
// with a revalidate behind it, a failed revalidate keeping what is already shown, a
// stalled gather timing out to the error state, Retry re-running the SAME gather,
// and the acting-profile change dropping the cache (the same device-local wipe
// boundary ProfileSwitchWatcher enforces for the offline read snapshots).

// `DirtyFormProvider` (mounted by the visit harness below, so #5902's "never over a
// draft" guard has a real registry to ask) calls `useRouter().refresh` when a form
// releases into an owed refresh. ONE STABLE OBJECT per render — a fresh literal makes
// the provider's `dispatch` a new function every render, which tears down and rebuilds
// the listener effect and wipes the registration state under test.
const nextRouter = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => nextRouter,
}));
const loadQuickEntry = vi.hoisted(() => vi.fn());
const loadQuickEntryIntakeContext = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/quick-entry-actions", () => ({
  loadQuickEntry,
  loadQuickEntryIntakeContext,
}));
const intakeSave = vi.hoisted(() =>
  vi.fn(
    async (_input: {
      kind: "medication" | "supplement";
      subjectProfileId?: number;
    }): Promise<void> => undefined
  )
);
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  addIntakeItem: vi.fn(async () => ({ ok: true as const })),
  resolveDayDoses: vi.fn(),
  setDoseStatus: vi.fn(),
}));
vi.mock("@/components/IntakeItemForm", () => ({
  default: function IntakeFormProbe({
    kind,
    subjectProfileId,
    autoFocusName,
    onDone,
    onSaved,
  }: {
    kind: "medication" | "supplement";
    subjectProfileId?: number;
    autoFocusName?: boolean;
    onDone?: () => void;
    onSaved?: () => boolean;
  }) {
    return (
      <div
        data-testid="intake-form-probe"
        data-kind={kind}
        data-subject={subjectProfileId}
      >
        <input aria-label="Name" autoFocus={autoFocusName} />
        <button
          type="button"
          onClick={async () => {
            await intakeSave({ kind, subjectProfileId });
            onSaved?.();
          }}
        >
          Save intake
        </button>
        <button type="button" onClick={onDone}>
          Cancel intake
        </button>
      </div>
    );
  },
}));
const logMood = vi.hoisted(() =>
  vi.fn(async (_formData: FormData) => ({ ok: true as const }))
);
vi.mock("@/app/(app)/mood-actions", () => ({ logMood }));
vi.mock("@/app/(app)/stool-actions", () => ({
  logStoolForm: vi.fn(async () => ({
    ok: true as const,
    type: 4,
    dayCount: 1,
    readings: [],
  })),
  // The stool body asks for the day's receipt rows itself (#5663); this file is about
  // the sheet's last-good gather, so the day is empty here.
  loadStoolDay: vi.fn(async () => ({ readings: [], dayCount: 0 })),
}));
const allSnapshots = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const allIntents = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/lib/offline/snapshot-db", () => ({ allSnapshots }));
vi.mock("@/lib/offline/queue-db", () => ({ allIntents }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => null,
}));
const wiped = vi.hoisted(() => vi.fn());
vi.mock("@/components/device-wipe", async () => {
  const { clearLastGood: clear } = await vi.importActual<
    typeof import("@/lib/offline/quick-entry-read")
  >("@/lib/offline/quick-entry-read");
  return {
    wipeDeviceForSignOut: () => {
      wiped();
      clear();
      return Promise.resolve();
    },
  };
});
const upload = vi.hoisted(() => ({ failing: false }));
vi.mock("@/components/UploadForm", () => ({
  default: () => {
    if (upload.failing) throw new Error("chunk failed");
    return <div data-testid="upload-body-probe" />;
  },
}));
// The visited food body's stand-in. `data-unsaved` is #3356's own seam — a form that
// composes its payload out of React state answers the dirty-form registry for itself —
// and it is what lets the resume tests below put a genuine DRAFT inside the sheet
// without driving a real body's fields.
const foodDraft = vi.hoisted(() => ({ unsaved: false }));
vi.mock("@/app/(app)/nutrition/FoodLogBar", async () => {
  const { useDayContext } = await vi.importActual<
    typeof import("@/components/DayContext")
  >("@/components/DayContext");
  return {
    default: function FoodHostProbe({
      days,
      proteinQuickAdd,
      slot,
    }: {
      days: { date: string; label: string }[];
      proteinQuickAdd?: { initialGramsByDate: Record<string, number> };
      slot: string;
    }) {
      const selected = useDayContext().parts.day;
      const label = days.find((day) => day.date === selected)?.label ?? "";
      const grams = proteinQuickAdd?.initialGramsByDate[selected] ?? -1;
      // `slot` is what the real bar seeds `activeSlot` from and prints as
      // "Add to <slot>" — the header #5902 is about, so the probe carries it.
      return (
        <output
          data-testid="food-host-probe"
          data-slot={slot}
          data-unsaved={foodDraft.unsaved ? "true" : "false"}
        >
          {selected}:{grams}:{label}
        </output>
      );
    },
  };
});
vi.mock("@/components/DoseStatusControl", () => ({
  default: ({ date }: { date?: string }) => (
    <span data-testid="dose-control-probe" data-date={date ?? ""} />
  ),
}));
vi.mock("@/components/medications/dose-day-settlement", () => ({
  useDoseDayResolution: () => ({
    resolveAll: vi.fn(),
    bulkBlocked: () => false,
  }),
}));
const prnSave = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
vi.mock("@/components/medications/QuickLogPrnContent", () => ({
  default: ({ onLogged }: { onLogged?: () => void }) => (
    <button
      type="button"
      data-testid="prn-save-probe"
      onClick={async () => {
        await prnSave();
        onLogged?.();
      }}
    >
      Take PRN
    </button>
  ),
}));

const ACTING: SessionProfile = {
  id: 1,
  name: "Dad",
  photo_path: null,
  photo_version: 0,
};
const MIA: SessionProfile = {
  id: 2,
  name: "Mia",
  photo_path: null,
  photo_version: 0,
};

const MEASUREMENTS = {
  form: "measurements" as const,
  defaultDate: "2026-09-03",
  defaultStatedAt: null,
  maxDate: "2026-09-03",
  profileId: ACTING.id,
  weightUnit: "lb" as const,
  temperatureUnit: "F" as const,
  showCompositionEntry: true,
  showGrowth: false,
  showHeadCirc: false,
};

function Sheet({ actingProfileId = ACTING.id }: { actingProfileId?: number }) {
  const { open, close } = useQuickEntry();
  return (
    <>
      <button onClick={() => open("stool")}>open</button>
      <button onClick={() => open("dose")}>open dose</button>
      <button
        onClick={() =>
          open("dose", { doseIntakeKind: "medication" }, actingProfileId)
        }
      >
        open add medication
      </button>
      <button onClick={() => open("food")}>open food</button>
      <button onClick={() => open("mood")}>open mood</button>
      <button onClick={() => open("cycle")}>open cycle</button>
      <button onClick={() => open("document")}>open document</button>
      <button onClick={close}>close</button>
    </>
  );
}

// The DEEP-LINK shape in one component, mirroring components/QuickShortcutHandler.tsx:
// it opens from a mount effect behind a value-keyed ref latch. Both halves are the
// point — the ref survives a StrictMode remount, so the second pass deliberately does
// NOT re-open, and anything that closes the overlay between the two passes leaves the
// deep link having consumed its parameter and opened nothing.
function DeepLinkOpener({ form }: { form: QuickEntryForm }) {
  const { open } = useQuickEntry();
  const handled = useRef<QuickEntryForm | null>(null);
  useEffect(() => {
    if (handled.current === form) return;
    handled.current = form;
    open(form);
  }, [form, open]);
  return null;
}

function renderSheet(
  actingProfileId = ACTING.id,
  liveToday = MEASUREMENTS.defaultDate,
  authKey = "login:session"
) {
  const surface = (id: number, day: string, identity: string) => (
    <ToastProvider>
      <ProfileDaysBoundary
        clocks={new Map([[id, { today: day, timeZone: "UTC" }]])}
      >
        <QuickEntryProvider
          key={`${identity}:${id}`}
          measurements={MEASUREMENTS}
          writableProfiles={[ACTING]}
          actingProfileId={id}
        >
          <Sheet actingProfileId={id} />
        </QuickEntryProvider>
      </ProfileDaysBoundary>
    </ToastProvider>
  );
  const utils = render(surface(actingProfileId, liveToday, authKey));
  return {
    ...utils,
    rerenderWithActing: (id: number) =>
      utils.rerender(surface(id, liveToday, authKey)),
    rerenderWithDay: (day: string) =>
      utils.rerender(surface(actingProfileId, day, authKey)),
    rerenderWithAuth: (identity: string) =>
      utils.rerender(surface(actingProfileId, liveToday, identity)),
  };
}

function renderInheritedSheet(
  inheritedDay: string,
  liveToday = MEASUREMENTS.defaultDate
) {
  const surface = (day: string) => (
    <ToastProvider>
      <ProfileDaysBoundary
        clocks={new Map([[ACTING.id, { today: day, timeZone: "UTC" }]])}
      >
        <DayContextProvider
          profileId={ACTING.id}
          today={day}
          reach={{ kind: "dated" }}
          backing={{
            kind: "url",
            day: inheritedDay,
            hrefForDay: (nextDay) => `/history?day=${nextDay}` as AppRoute,
          }}
        >
          <QuickEntryProvider
            measurements={MEASUREMENTS}
            writableProfiles={[ACTING]}
            actingProfileId={ACTING.id}
          >
            <Sheet />
          </QuickEntryProvider>
        </DayContextProvider>
      </ProfileDaysBoundary>
    </ToastProvider>
  );
  const utils = render(surface(liveToday));
  return {
    ...utils,
    rerenderWithDay: (day: string) => utils.rerender(surface(day)),
  };
}

function ready<T>(data: T) {
  return { kind: "ready" as const, data };
}

function unavailable(message: string, today = MEASUREMENTS.defaultDate) {
  return ready({
    form: "unavailable" as const,
    today,
    message,
  });
}

function dueDose(today: string, meds: QuickEntryPrn["meds"] = []) {
  return ready({
    form: "dose" as const,
    today,
    doses: [
      {
        doseId: 77,
        title: "Held midnight dose",
        detail: null,
        dueText: "8:00am",
      },
    ],
    prn: {
      meds,
      tz: "UTC",
      timeFormat: "24h" as const,
      nowIso: `${today}T12:00:00.000Z`,
      pediatric: {
        ageMonths: null,
        weightKg: null,
        weightDate: null,
        weightUnit: "kg" as const,
        today,
      },
    },
    pastDays: [
      { date: "2026-09-02", label: "Yesterday", slots: [] },
      { date: "2026-09-01", label: "Mon, Sep 1", slots: [] },
    ],
  });
}

function food(
  day: string,
  proteinGrams: number,
  today = "2026-09-03",
  slot: "Morning" | "Midday" | "Evening" = "Midday"
) {
  return ready({
    form: "food" as const,
    today,
    days: [
      {
        date: day,
        label: "server-relative label",
        counts: {},
        slotCounts: { Morning: {}, Midday: {}, Evening: {} },
        events: [],
      },
    ],
    groupsBySlot: { Morning: [], Midday: [], Evening: [] },
    proteinRankBySlot: { Morning: 0, Midday: 0, Evening: 0 },
    proteinGrams,
    proteinPreset: 30,
    excludedGroups: [],
    slot,
    slotBoundaries: { midday: 660, evening: 900 },
  });
}

function mood(
  energy: number | null,
  notes: string | null,
  today = MEASUREMENTS.defaultDate
) {
  return ready({
    form: "mood" as const,
    today,
    days: [
      {
        date: today,
        label: "Today",
        mood: {
          valence: 4,
          energy,
          anxiety: null,
          factors: [],
          notes,
        },
      },
    ],
    showCalm: false,
  });
}

function stool(today = MEASUREMENTS.defaultDate) {
  return ready({ form: "stool" as const, today, todayCount: 0 });
}

// The default food-window splits (lib/food-slot.ts): Morning before 11:00, Midday
// before 15:00, Evening to midnight. What the sheet's open-time gather publishes.
const SLOT_BOUNDARIES = { midday: 11 * 60, evening: 15 * 60 };

function VisitSheet({
  open,
  onDone = () => {},
  onInvalidated = () => {},
  slotBoundaries = SLOT_BOUNDARIES,
}: {
  open: boolean;
  onDone?: () => void;
  onInvalidated?: () => void;
  slotBoundaries?: { midday: number; evening: number } | null;
}) {
  const visit = useQuickEntryVisit(open, onInvalidated);
  // Stands in for `QuickLogMenu`'s open-time `loadLogSheetContext`, which is the one
  // publisher of these in the app (#5902). Closed means no gather, so nothing is
  // published — the same as a menu that never ran.
  const { noteSlotBoundaries } = useQuickEntry();
  useEffect(() => {
    noteSlotBoundaries(open ? slotBoundaries : null);
  }, [noteSlotBoundaries, open, slotBoundaries]);
  return (
    <>
      <output data-testid="visit-view">{visit.active?.form ?? "menu"}</output>
      <button
        data-testid="visit-dose"
        onClick={(event) => visit.open("dose", event.currentTarget)}
      >
        Dose
      </button>
      <button
        data-testid="visit-food"
        onClick={(event) => visit.open("food", event.currentTarget)}
      >
        Food
      </button>
      <button
        data-testid="visit-stool"
        onClick={(event) => visit.open("stool", event.currentTarget)}
      >
        Stool
      </button>
      <button
        data-testid="visit-mood"
        onClick={(event) => visit.open("mood", event.currentTarget)}
      >
        Mood
      </button>
      <button data-testid="visit-back" onClick={visit.back}>
        Back
      </button>
      {visit.titleAdornment}
      {visit.belowTitle}
      <QuickEntryVisitBodies identity={visit.identity} onDone={onDone} />
    </>
  );
}

function renderVisitSheet(
  initiallyOpen = false,
  onDone?: () => void,
  {
    onInvalidated,
    slotBoundaries,
    timeZone = "UTC",
  }: {
    onInvalidated?: () => void;
    slotBoundaries?: { midday: number; evening: number } | null;
    timeZone?: string;
  } = {}
) {
  const surface = (open: boolean) => (
    <ToastProvider>
      <DirtyFormProvider>
        <ProfileDaysBoundary
          clocks={
            new Map([
              [ACTING.id, { today: MEASUREMENTS.defaultDate, timeZone }],
              [MIA.id, { today: MEASUREMENTS.defaultDate, timeZone }],
            ])
          }
        >
          <QuickEntryProvider
            measurements={MEASUREMENTS}
            writableProfiles={[ACTING, MIA]}
            actingProfileId={ACTING.id}
          >
            <VisitSheet
              open={open}
              onDone={onDone}
              onInvalidated={onInvalidated}
              slotBoundaries={slotBoundaries}
            />
          </QuickEntryProvider>
        </ProfileDaysBoundary>
      </DirtyFormProvider>
    </ToastProvider>
  );
  const utils = render(surface(initiallyOpen));
  return {
    ...utils,
    rerenderOpen: (open: boolean) => utils.rerender(surface(open)),
  };
}

// THE DESKTOP PANEL'S HOST (#5902 slice 2). Above `md`, `SidebarLogButton` renders
// `QuickLogMenu` inside an `AnchoredPanel` and reaches the forms through the
// provider's DIRECT overlay — `useQuickEntry().open`, no visit to invalidate — which
// is why slice 1's listener never reached it. This is that shape: the menu stays
// mounted across logs (the panel does not close behind a row), so its open-time
// gather keeps the food windows published while a form is up.
function Panel({
  slotBoundaries = SLOT_BOUNDARIES,
}: {
  slotBoundaries?: { midday: number; evening: number } | null;
}) {
  const { open, noteSlotBoundaries } = useQuickEntry();
  useEffect(() => {
    noteSlotBoundaries(slotBoundaries);
  }, [noteSlotBoundaries, slotBoundaries]);
  return (
    <>
      <button data-testid="panel-food" onClick={() => open("food")}>
        Food
      </button>
      <button data-testid="panel-stool" onClick={() => open("stool")}>
        Stool
      </button>
    </>
  );
}

function renderPanel({
  slotBoundaries,
  timeZone = "UTC",
}: {
  slotBoundaries?: { midday: number; evening: number } | null;
  timeZone?: string;
} = {}) {
  return render(
    <ToastProvider>
      <DirtyFormProvider>
        <ProfileDaysBoundary
          clocks={
            new Map([
              [ACTING.id, { today: MEASUREMENTS.defaultDate, timeZone }],
            ])
          }
        >
          <QuickEntryProvider
            measurements={MEASUREMENTS}
            writableProfiles={[ACTING]}
            actingProfileId={ACTING.id}
          >
            <Panel slotBoundaries={slotBoundaries} />
          </QuickEntryProvider>
        </ProfileDaysBoundary>
      </DirtyFormProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  loadQuickEntry.mockReset();
  loadQuickEntryIntakeContext.mockReset().mockResolvedValue({
    kind: "ready",
    context: {},
  });
  intakeSave.mockReset().mockResolvedValue(undefined);
  prnSave.mockReset().mockResolvedValue(undefined);
  logMood.mockReset().mockResolvedValue({ ok: true as const });
  allSnapshots.mockReset().mockResolvedValue([]);
  allIntents.mockReset().mockResolvedValue([]);
  wiped.mockReset();
  upload.failing = false;
  clearLastGood();
});

function doseSnapshot(date = MEASUREMENTS.defaultDate): AnySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "dose-schedule",
    profileId: ACTING.id,
    timeZone: "UTC",
    capturedOn: date,
    fetchedAt: `${date}T06:00:00Z`,
    data: {
      date,
      entries: [
        {
          doseId: 77,
          name: "Device dose",
          detail: null,
          slot: "Morning",
          status: "pending",
        },
      ],
    },
  };
}

describe("body remount policy", () => {
  const forms: Parameters<typeof remounts>[0][] = [
    "food",
    "measurements",
    "dose",
    "practice",
    "cycle",
    "mood",
    "stool",
    "substance",
    "symptom",
    "document",
    "unavailable",
  ];

  it.each(forms)(
    "keeps a same-context %s payload and remounts its context",
    (form) => {
      expect(remounts(form, form, "payload")).toBe(false);
      expect(remounts(form, form, "context")).toBe(true);
    }
  );

  it("remounts an arriving variant", () => {
    expect(remounts("mood", "unavailable", "payload")).toBe(true);
    expect(remounts("unavailable", "mood", "payload")).toBe(true);
  });
});

describe("one quick-log visit", () => {
  it("keeps a visited body draft and selected day across sibling travel", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(stool())
      .mockResolvedValueOnce(stool("2026-09-02"))
      .mockResolvedValueOnce(mood(3, "fresh"));
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);

    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");
    fireEvent.click(screen.getByTestId("day-context-1"));
    const time = await screen.findByTestId("stool-when-time");
    fireEvent.change(time, { target: { value: "08:10" } });

    fireEvent.click(screen.getByTestId("visit-back"));
    expect(screen.getByTestId("visit-view").textContent).toBe("menu");
    fireEvent.click(screen.getByTestId("visit-mood"));
    await screen.findByTestId("mood-form");
    fireEvent.click(screen.getByTestId("visit-back"));
    fireEvent.click(screen.getByTestId("visit-stool"));

    expect(
      screen
        .getByRole("button", { name: /^Yesterday$/ })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      (screen.getByTestId("stool-when-time") as HTMLInputElement).value
    ).toBe("08:10");
    expect(loadQuickEntry).toHaveBeenCalledTimes(3);
  });

  it("lets a pending Mood write finish without presenting over its sibling", async () => {
    let resolveMood!: (result: { ok: true }) => void;
    logMood.mockImplementationOnce(
      () => new Promise((resolve) => (resolveMood = resolve))
    );
    loadQuickEntry
      .mockResolvedValueOnce(mood(3, "fresh"))
      .mockResolvedValueOnce(mood(3, "fresh"))
      .mockResolvedValueOnce(stool());
    const onDone = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, onDone);
    rerenderOpen(true);

    fireEvent.click(screen.getByTestId("visit-mood"));
    await screen.findByTestId("mood-form");
    fireEvent.click(screen.getByTestId("quick-entry-subject-chip"));
    fireEvent.click(screen.getByTestId(`quick-entry-subject-option-${MIA.id}`));
    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "mood",
        MIA.id,
        undefined,
        "sheet"
      )
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("quick-entry-body")
          .getAttribute("data-subject-profile-id")
      ).toBe(String(MIA.id))
    );
    expect(
      screen.getByTestId("quick-entry-subject-chip").textContent
    ).toContain(MIA.name);
    fireEvent.click(await screen.findByRole("button", { name: "Mood: Good" }));
    await waitFor(() => expect(logMood).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("visit-back"));
    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");

    const posted = Object.fromEntries(
      (logMood.mock.calls[0]?.[0] as FormData).entries()
    );
    expect(posted).toMatchObject({
      date: MEASUREMENTS.defaultDate,
      valence: "4",
      energy: "3",
      note: "fresh",
      profile_id: String(MIA.id),
    });
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      MIA.id,
      undefined,
      "sheet"
    );
    expect(
      screen
        .getByTestId("quick-entry-stool")
        .closest('[data-testid="quick-entry-body"]')
        ?.getAttribute("data-subject-profile-id")
    ).toBe(String(MIA.id));
    expect(
      screen.getByTestId("quick-entry-subject-chip").textContent
    ).toContain(MIA.name);
    resolveMood({ ok: true });
    await act(async () => {});

    expect(screen.getByTestId("visit-view").textContent).toBe("stool");
    expect(screen.getByTestId("quick-entry-stool")).toBeTruthy();
    expect(screen.queryByText("Logged Good · Today")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("visit-back"));
    fireEvent.click(screen.getByTestId("visit-mood"));
    await waitFor(() =>
      expect(screen.getByTestId("mood-form").getAttribute("aria-busy")).toBe(
        "false"
      )
    );
    expect(loadQuickEntry).toHaveBeenCalledTimes(3);
  });

  it("returns a fresh menu before a rapid reopen can install the prior visit", async () => {
    let resolveFirst!: (value: ReturnType<typeof stool>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    );
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-stool"));
    expect(screen.getByTestId("visit-view").textContent).toBe("stool");

    rerenderOpen(false);
    rerenderOpen(true);
    expect(screen.getByTestId("visit-view").textContent).toBe("menu");
    expect(screen.queryByTestId("quick-entry-stool")).toBeNull();

    resolveFirst(stool());
    await act(async () => {});
    expect(screen.getByTestId("visit-view").textContent).toBe("menu");
    expect(screen.queryByTestId("quick-entry-stool")).toBeNull();

    loadQuickEntry.mockResolvedValueOnce(mood(3, "new visit"));
    fireEvent.click(screen.getByTestId("visit-mood"));
    expect(await screen.findByTestId("mood-form")).toBeTruthy();
  });

  it("opens either full intake kind and Cancel returns to the retained Dose body", async () => {
    loadQuickEntry.mockResolvedValueOnce(dueDose(MEASUREMENTS.defaultDate));
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-dose"));
    await screen.findByText("Held midnight dose");

    const medication = screen.getByTestId("quick-entry-add-medication");
    fireEvent.click(medication);
    const form = await screen.findByTestId("intake-form-probe");
    expect(form.dataset.kind).toBe("medication");
    expect(form.dataset.subject).toBe(String(ACTING.id));
    expect(loadQuickEntryIntakeContext).toHaveBeenCalledWith(ACTING.id);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Name" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel intake" }));
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
    expect(document.activeElement).toBe(medication);
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("quick-entry-add-supplement"));
    expect((await screen.findByTestId("intake-form-probe")).dataset.kind).toBe(
      "supplement"
    );
  });

  it("accepts one current intake save, refreshes Dose once, and returns focus", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(dueDose(MEASUREMENTS.defaultDate))
      .mockResolvedValueOnce(dueDose(MEASUREMENTS.defaultDate));
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-dose"));
    await screen.findByText("Held midnight dose");
    const medication = screen.getByTestId("quick-entry-add-medication");
    fireEvent.click(medication);
    await screen.findByTestId("intake-form-probe");

    fireEvent.click(screen.getByRole("button", { name: "Save intake" }));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("intake-form-probe")).toBeNull();
    expect(document.activeElement).toBe(medication);
    expect(intakeSave).toHaveBeenCalledWith({
      kind: "medication",
      subjectProfileId: ACTING.id,
    });
  });

  it("a same-kind reopen rejects the prior form's late save presentation", async () => {
    let resolveFirst!: () => void;
    intakeSave.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirst = resolve))
    );
    loadQuickEntry.mockResolvedValueOnce(dueDose(MEASUREMENTS.defaultDate));
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-dose"));
    await screen.findByText("Held midnight dose");

    fireEvent.click(screen.getByTestId("quick-entry-add-medication"));
    await screen.findByTestId("intake-form-probe");
    fireEvent.click(screen.getByRole("button", { name: "Save intake" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel intake" }));
    fireEvent.click(screen.getByTestId("quick-entry-add-medication"));
    await screen.findByTestId("intake-form-probe");

    resolveFirst();
    await act(async () => {});
    expect(screen.getByTestId("intake-form-probe").dataset.kind).toBe(
      "medication"
    );
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
  });

  it("does not let a PRN completion from an older body activation reload the returned body", async () => {
    let resolvePrn!: () => void;
    prnSave.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolvePrn = resolve))
    );
    const dose = dueDose(MEASUREMENTS.defaultDate, [
      {
        id: 31,
        name: "Rescue medicine",
        identity: { name: "Rescue medicine", rxcui: null },
        kind: "medication",
        product: null,
        amount: null,
        count: 0,
        lastGivenAt: null,
        minIntervalHours: null,
        maxDailyCount: null,
        familyCount: 0,
        familyArming: { kind: "none" },
        familyMaxDailyCount: null,
        familyExposure: null,
        familyMemberCount: 1,
      },
    ]);
    loadQuickEntry.mockResolvedValueOnce(dose);
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-dose"));
    await screen.findByText("Held midnight dose");

    fireEvent.click(screen.getByTestId("prn-save-probe"));
    fireEvent.click(screen.getByTestId("quick-entry-add-medication"));
    await screen.findByTestId("intake-form-probe");
    fireEvent.click(screen.getByRole("button", { name: "Cancel intake" }));
    resolvePrn();
    await act(async () => {});

    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
  });

  it("retries a failed intake context and ignores a later context after Back", async () => {
    let resolveLate!: (value: {
      kind: "ready";
      context: Record<string, never>;
    }) => void;
    loadQuickEntry.mockResolvedValueOnce(dueDose(MEASUREMENTS.defaultDate));
    loadQuickEntryIntakeContext
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ kind: "ready", context: {} })
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveLate = resolve))
      );
    const { rerenderOpen } = renderVisitSheet();
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-dose"));
    await screen.findByText("Held midnight dose");

    fireEvent.click(screen.getByTestId("quick-entry-add-medication"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't open that form."
    );
    fireEvent.click(screen.getByTestId("quick-entry-retry"));
    expect(await screen.findByTestId("intake-form-probe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel intake" }));
    fireEvent.click(screen.getByTestId("quick-entry-add-supplement"));
    fireEvent.click(screen.getByTestId("visit-back"));
    resolveLate({ kind: "ready", context: {} });
    await act(async () => {});

    expect(screen.queryByTestId("intake-form-probe")).toBeNull();
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
  });
});

describe("palette intake intent", () => {
  it("opens the medication form directly and Cancel focuses the visible Dose fallback", async () => {
    let resolveDose!: (value: ReturnType<typeof dueDose>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDose = resolve))
    );
    renderSheet();
    fireEvent.click(screen.getByText("open add medication"));

    const form = await screen.findByTestId("intake-form-probe");
    expect(form.dataset.kind).toBe("medication");
    expect(form.dataset.subject).toBe(String(ACTING.id));
    fireEvent.click(screen.getByRole("button", { name: "Cancel intake" }));
    resolveDose(dueDose(MEASUREMENTS.defaultDate));

    const fallback = await screen.findByTestId("quick-entry-add-medication");
    await waitFor(() => expect(document.activeElement).toBe(fallback));
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
  });
});

describe("last-good render, revalidate behind it (#3416 proposal 1)", () => {
  it("a reopen after a successful open renders instantly from last-good, then updates", async () => {
    let resolveSecond: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      );

    renderSheet();
    fireEvent.click(screen.getByText("open"));
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("v1");

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    // INSTANT: no loading state, v1 is already on screen from the cache — before
    // the second (background) gather has even resolved.
    expect(screen.queryByTestId("quick-entry-loading")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );

    resolveSecond!(unavailable("v2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("v2")
    );
  });

  it("a failed revalidate behind a last-good render keeps the rendered form (no error state)", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockRejectedValueOnce(new Error("offline"));

    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    // The failed background revalidate must not blank the sheet into the error
    // state — the last-good copy is still a correct, if slightly stale, answer.
    expect(screen.queryByTestId("quick-entry-error")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );
  });

  it("keeps a touched real Mood field while a fresh host read replaces untouched fields", async () => {
    let resolveFresh!: (value: ReturnType<typeof mood>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(mood(1, "first"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFresh = resolve))
      );
    renderSheet();
    fireEvent.click(screen.getByText("open mood"));
    fireEvent.click(await screen.findByText("Details"));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Energy: 1" })
          .getAttribute("aria-pressed")
      ).toBe("true")
    );

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open mood"));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "mine" },
    });

    resolveFresh(mood(3, "server"));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Energy: 3" })
          .getAttribute("aria-pressed")
      ).toBe("true")
    );
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "mine"
    );
  });

  it("a COLD failure (nothing cached) reaches the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    fireEvent.click(screen.getByText("open document"));
    expect(await screen.findByTestId("quick-entry-error")).not.toBeNull();
  });

  it("the acting profile changing drops the cache — a same-form reopen loads again rather than flashing the last-good copy", async () => {
    loadQuickEntry.mockResolvedValue(unavailable("v1"));
    const { rerenderWithActing } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithActing(99);
    loadQuickEntry.mockClear();
    let resolveNext: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve))
    );
    fireEvent.click(screen.getByText("open"));

    // No stale last-good survives the identity change — the sheet goes back to a
    // genuine loading state rather than instantly repainting the OLD profile's
    // cached answer under the new one.
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
    resolveNext!(unavailable("v2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("v2")
    );
  });

  it("a new authenticated session cannot reuse the prior session's cache", async () => {
    loadQuickEntry.mockResolvedValueOnce(unavailable("old session"));
    const { rerenderWithAuth } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithAuth("next-login:next-session");
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByText("open"));

    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
  });

  // #5922. The host empties the store when it takes over an identity, and that clear
  // BROADCASTS — which this host hears and turns into `setOpen(false)`. React
  // StrictMode runs mount effects twice around the passive effects in between, so a
  // second clear for the SAME identity used to close an overlay a deep link had
  // already opened: `/?quick=log-stool` consumed its param and left the dashboard
  // sitting there on a dev server.
  //
  // THIS TIER, NOT A BROWSER ONE. Every e2e worker's server is `next start` with
  // NODE_ENV=production (e2e/fixtures.ts), where effects run once — which is why five
  // green `goto("/?quick=log-stool")` call sites in e2e/bristol-stool.spec.ts never
  // saw this and never could. StrictMode is reproducible here and nowhere else.
  it("a deep link opened during mount survives a StrictMode remount", async () => {
    loadQuickEntry.mockResolvedValue(stool());
    render(
      <StrictMode>
        <ToastProvider>
          <ProfileDaysBoundary
            clocks={
              new Map([
                [
                  ACTING.id,
                  { today: MEASUREMENTS.defaultDate, timeZone: "UTC" },
                ],
              ])
            }
          >
            <QuickEntryProvider
              measurements={MEASUREMENTS}
              writableProfiles={[ACTING]}
              actingProfileId={ACTING.id}
            >
              <DeepLinkOpener form="stool" />
            </QuickEntryProvider>
          </ProfileDaysBoundary>
        </ToastProvider>
      </StrictMode>
    );

    expect(await screen.findByTestId("quick-entry-sheet")).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-body").getAttribute("data-form")
      ).toBe("stool")
    );
  });
});

describe("the stall bound and Retry (#3416 proposal 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a gather stalled past the timeout reaches the error state, not perpetual Loading", async () => {
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    renderSheet();
    fireEvent.click(screen.getByText("open document"));
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByTestId("quick-entry-error")).not.toBeNull();
  });

  it("Retry re-runs the SAME gather and a success replaces the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    fireEvent.click(screen.getByText("open document"));
    await vi.waitFor(() =>
      expect(screen.getByTestId("quick-entry-error")).not.toBeNull()
    );

    loadQuickEntry.mockResolvedValueOnce(
      ready({ form: "document" as const, demo: false })
    );
    fireEvent.click(screen.getByTestId("quick-entry-retry"));

    await vi.waitFor(() =>
      expect(screen.getByTestId("upload-body-probe")).toBeTruthy()
    );
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
  });

  it("expires a held revalidation so its late answer cannot paint or refill cache", async () => {
    let resolveLate!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("held"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveLate = resolve))
      );
    renderSheet();
    await act(async () => {
      fireEvent.click(screen.getByText("open"));
      await Promise.resolve();
    });
    expect(screen.getByText(/held/)).toBeTruthy();
    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "held"
    );
    expect(screen.getByTestId("quick-entry-asof").textContent).toContain(
      "couldn't refresh"
    );

    resolveLate(unavailable("too late"));
    await act(async () => {});
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "held"
    );
    expect(screen.queryByText(/too late/)).toBeNull();
  });

  it("recovers a rejected body chunk through the shared Retry boundary", async () => {
    vi.useRealTimers();
    upload.failing = true;
    loadQuickEntry.mockResolvedValue(
      ready({ form: "document" as const, demo: false })
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderSheet();
      fireEvent.click(screen.getByText("open document"));
      expect(await screen.findByTestId("quick-entry-error")).toBeTruthy();

      upload.failing = false;
      fireEvent.click(screen.getByTestId("quick-entry-retry"));
      expect(await screen.findByTestId("upload-body-probe")).toBeTruthy();
      expect(screen.queryByTestId("quick-entry-error")).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("device recovery and authorization refusal", () => {
  it("opens the real dose list from the existing device snapshot after a cold failure", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    allSnapshots.mockResolvedValueOnce([doseSnapshot()]);
    renderSheet();
    fireEvent.click(screen.getByText("open dose"));

    expect(await screen.findByText("Device dose")).toBeTruthy();
    expect(screen.getByTestId("quick-entry-asof").textContent).toContain(
      "this device's copy of today"
    );
    expect(screen.getByTestId("quick-entry-body").dataset.bodySight).toBe(
      "device"
    );
  });

  it("invalidates held content when the subject gate refuses", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("held subject"))
      .mockResolvedValueOnce({ kind: "refused", reason: "subject" });
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByText(/held subject/);
    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    await waitFor(() =>
      expect(screen.queryByTestId("quick-entry-sheet")).toBeNull()
    );
    expect(wiped).not.toHaveBeenCalled();
  });

  it("routes a revoked session through the existing device wipe owner", async () => {
    loadQuickEntry.mockResolvedValueOnce({
      kind: "refused",
      reason: "session",
    });
    renderSheet();
    fireEvent.click(screen.getByText("open"));

    await waitFor(() => expect(wiped).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByTestId("quick-entry-sheet")).toBeNull()
    );
  });
});

describe("day request identity", () => {
  it("does not repaint a warm Today entry into an uncached selected day", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockRejectedValueOnce(new Error("offline"));
    allSnapshots.mockImplementationOnce(() => new Promise(() => {}));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByText(/today/);

    fireEvent.click(screen.getByTestId("day-context-1"));
    await act(async () => {});

    expect(screen.getByTestId("quick-entry-loading")).toBeTruthy();
    expect(screen.queryByTestId("quick-entry-unavailable")).toBeNull();
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      "2026-09-02",
      "sheet"
    );
  });

  it("returns from Yesterday to the cached Today Food total while refreshing that key", async () => {
    let resolveTodayRefresh!: (value: ReturnType<typeof food>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(food("2026-09-03", 5))
      .mockResolvedValueOnce(food("2026-09-02", 0))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveTodayRefresh = resolve))
      );
    renderSheet();
    fireEvent.click(screen.getByText("open food"));
    expect((await screen.findByTestId("food-host-probe")).textContent).toBe(
      "2026-09-03:5:Today"
    );

    fireEvent.click(screen.getByTestId("day-context-1"));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toBe(
        "2026-09-02:0:Yesterday"
      )
    );

    fireEvent.click(screen.getByTestId("day-context-0"));
    expect(screen.getByTestId("food-host-probe").textContent).toBe(
      "2026-09-03:5:Today"
    );
    resolveTodayRefresh(food("2026-09-03", 7));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toBe(
        "2026-09-03:7:Today"
      )
    );
  });

  it("renders the inherited dated Food total without a sheet switcher", async () => {
    const inheritedDay = "2026-08-20";
    loadQuickEntry.mockResolvedValueOnce(food(inheritedDay, 33));
    render(
      <ToastProvider>
        <ProfileDaysBoundary
          clocks={
            new Map([[ACTING.id, { today: "2026-09-03", timeZone: "UTC" }]])
          }
        >
          <DayContextProvider
            profileId={ACTING.id}
            today="2026-09-03"
            reach={{ kind: "dated" }}
            backing={{
              kind: "url",
              day: inheritedDay,
              hrefForDay: (day) => `/history?day=${day}` as AppRoute,
            }}
          >
            <QuickEntryProvider
              measurements={MEASUREMENTS}
              writableProfiles={[ACTING]}
              actingProfileId={ACTING.id}
            >
              <Sheet />
            </QuickEntryProvider>
          </DayContextProvider>
        </ProfileDaysBoundary>
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("open food"));
    await waitFor(() =>
      expect(screen.getByTestId("food-host-probe").textContent).toContain(
        `${inheritedDay}:33:`
      )
    );
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "food",
      ACTING.id,
      inheritedDay,
      "dated"
    );
    expect(screen.queryByTestId("bounded-day-switcher")).toBeNull();
  });

  it("reopens an undated form daylessly, not on the prior selection", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockResolvedValueOnce(unavailable("past"))
      .mockResolvedValueOnce(unavailable("today refreshed"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");
    fireEvent.click(screen.getByTestId("day-context-1"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("past")
    );

    fireEvent.click(screen.getByText("close"));
    fireEvent.click(screen.getByText("open"));

    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-0").getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("does not expose a past-day context for a today-bound lifecycle", async () => {
    loadQuickEntry.mockResolvedValueOnce(unavailable("cycle unavailable"));
    renderSheet();
    fireEvent.click(screen.getByText("open cycle"));
    await screen.findByTestId("quick-entry-unavailable");
    expect(screen.queryByTestId("bounded-day-switcher")).toBeNull();
    expect(loadQuickEntry).toHaveBeenCalledWith(
      "cycle",
      ACTING.id,
      undefined,
      "sheet"
    );
  });

  it("retries the selected day after its gather rejects", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(unavailable("recovered"));
    renderSheet();
    fireEvent.click(screen.getByText("open dose"));
    await screen.findByTestId("bounded-day-switcher");

    fireEvent.click(screen.getByTestId("day-context-1"));
    await screen.findByTestId("quick-entry-error");
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "dose",
      ACTING.id,
      "2026-09-02",
      "sheet"
    );

    fireEvent.click(screen.getByTestId("quick-entry-retry"));
    await screen.findByTestId("quick-entry-unavailable");
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "dose",
      ACTING.id,
      "2026-09-02",
      "sheet"
    );
  });

  it("drops a late response for a day already left", async () => {
    let resolveYesterday!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("today"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveYesterday = resolve))
      )
      .mockResolvedValueOnce(unavailable("two days ago"));
    renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");

    fireEvent.click(screen.getByTestId("day-context-1"));
    fireEvent.click(screen.getByTestId("day-context-2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("two days ago")
    );
    resolveYesterday(unavailable("late yesterday"));
    await act(async () => {});
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "two days ago"
    );
  });

  it("gathers the reconciled day when midnight expires the cached selection", async () => {
    let resolveOld!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("initial"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValueOnce(unavailable("reconciled", "2026-09-05"));
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("bounded-day-switcher");
    fireEvent.click(screen.getByTestId("day-context-2"));
    rerenderWithDay("2026-09-05");

    await waitFor(() =>
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "stool",
        ACTING.id,
        "2026-09-05",
        "sheet"
      )
    );
    resolveOld(unavailable("old day after midnight", "2026-09-05"));
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("reconciled");
  });

  it("keeps an in-reach cached prior day while a new dayless bootstrap runs", async () => {
    let resolveRefresh!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("September 3"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveRefresh = resolve))
      );
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithDay("2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "September 3"
    );
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByTestId("day-context-1").textContent).toBe("Yesterday");
    resolveRefresh(unavailable("September 4", "2026-09-04"));
    await waitFor(() =>
      expect(
        screen.getByTestId("day-context-0").getAttribute("aria-pressed")
      ).toBe("true")
    );
  });

  it("restarts a dayless bootstrap whose response crossed local midnight", async () => {
    let resolveOld!: (value: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValueOnce(unavailable("new day", "2026-09-04"));
    const { rerenderWithDay } = renderSheet();
    fireEvent.click(screen.getByText("open"));
    rerenderWithDay("2026-09-04");

    resolveOld(unavailable("old day", "2026-09-03"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "stool",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("new day");
  });
});

describe("midnight fallback integration", () => {
  it("restarts a dayless device recovery that crosses live midnight", async () => {
    let resolveSnapshots!: (snapshots: AnySnapshot[]) => void;
    allSnapshots.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSnapshots = resolve))
    );
    loadQuickEntry
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(unavailable("new day", "2026-09-04"));
    const { rerenderWithDay } = renderSheet(ACTING.id, "2026-09-03");

    fireEvent.click(screen.getByText("open dose"));
    await waitFor(() => expect(allSnapshots).toHaveBeenCalledOnce());
    rerenderWithDay("2026-09-04");
    resolveSnapshots([doseSnapshot("2026-09-03")]);

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "dose",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("new day");
    expect(screen.queryByText("Device dose")).toBeNull();
  });

  it.each(["selected", "inherited"] as const)(
    "keeps an in-reach %s day through a device recovery that crosses midnight",
    async (requestKind) => {
      let resolveSnapshots!: (snapshots: AnySnapshot[]) => void;
      allSnapshots.mockImplementationOnce(
        () => new Promise((resolve) => (resolveSnapshots = resolve))
      );
      const selectedDay = "2026-09-02";

      if (requestKind === "selected") {
        loadQuickEntry
          .mockResolvedValueOnce(dueDose("2026-09-03"))
          .mockRejectedValueOnce(new Error("offline"));
        const { rerenderWithDay } = renderSheet(ACTING.id, "2026-09-03");
        fireEvent.click(screen.getByText("open dose"));
        await screen.findByTestId("bounded-day-switcher");
        fireEvent.click(screen.getByTestId("day-context-1"));
        await waitFor(() => expect(allSnapshots).toHaveBeenCalledOnce());
        rerenderWithDay("2026-09-04");
      } else {
        loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
        const { rerenderWithDay } = renderInheritedSheet(
          selectedDay,
          "2026-09-03"
        );
        fireEvent.click(screen.getByText("open dose"));
        await waitFor(() => expect(allSnapshots).toHaveBeenCalledOnce());
        rerenderWithDay("2026-09-04");
      }

      resolveSnapshots([doseSnapshot(selectedDay)]);

      expect(await screen.findByText("Device dose")).toBeTruthy();
      expect(loadQuickEntry).toHaveBeenCalledTimes(
        requestKind === "selected" ? 2 : 1
      );
      expect(loadQuickEntry).toHaveBeenLastCalledWith(
        "dose",
        ACTING.id,
        selectedDay,
        requestKind === "selected" ? "sheet" : "dated"
      );
      expect(screen.getByTestId("dose-control-probe").dataset.date).toBe(
        selectedDay
      );
    }
  );

  it("keeps a reachable prior-day dose row and gives its control the explicit day", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(dueDose("2026-09-03"))
      .mockRejectedValueOnce(new Error("offline"));
    const { rerenderWithDay } = renderSheet(ACTING.id, "2026-09-03");

    fireEvent.click(screen.getByText("open dose"));
    expect(await screen.findByText("Held midnight dose")).toBeTruthy();
    fireEvent.click(screen.getByText("close"));
    rerenderWithDay("2026-09-04");
    fireEvent.click(screen.getByText("open dose"));

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    expect(loadQuickEntry).toHaveBeenLastCalledWith(
      "dose",
      ACTING.id,
      undefined,
      "sheet"
    );
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText("Held midnight dose")).toBeTruthy();
    expect(screen.getByTestId("dose-control-probe").dataset.date).toBe(
      "2026-09-03"
    );
  });

  it("settles persistent in-reach disagreement with one historical response", async () => {
    let calls = 0;
    loadQuickEntry.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        unavailable(`stale response ${calls}`, "2026-09-03")
      );
    });
    renderSheet(ACTING.id, "2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("stale response 1");
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("day-context-1").getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("settles a consistent dayless response without an extra request", async () => {
    loadQuickEntry.mockResolvedValueOnce(
      unavailable("current response", "2026-09-04")
    );
    renderSheet(ACTING.id, "2026-09-04");
    fireEvent.click(screen.getByText("open"));

    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("current response");
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);
  });
});

// ── THE SHEET DOES NOT SURVIVE A BOUNDARY IT CARES ABOUT (#5902) ──────────────
//
// Background the PWA at breakfast, come back at dinner: a page the OS did not
// discard comes back exactly as it was, with the morning's offers, the morning's
// rows and a food header that still says "Add to Morning" while a bare tap files
// the serving there. Owner ruling 2026-09-15 — the sheet CLOSES on that return,
// and never over a draft. Regathering in place was considered and reversed.
//
// The listener lives in the visit owner (`useQuickEntryVisit`), so what is driven
// here is what BOTH hosts get: a `visibilitychange` pair around a clock move, and
// the visit's existing `invalidated` flag reaching the host's `onInvalidated`.
// The day comes from the profile's zone, the window from the boundaries the
// open-time gather published, and a return inside the same window on the same day
// is not a crossing at all.
describe("a resume across a slot or day boundary (#5902)", () => {
  let hidden = false;

  function background() {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  }
  function resume() {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  }

  beforeEach(() => {
    foodDraft.unsaved = false;
    hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    // Date only: the tier's own async settling still needs real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-03T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "hidden");
  });

  it("closes on a return in a later food window, and the next open names it", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(food("2026-09-03", 5, "2026-09-03", "Morning"))
      .mockResolvedValueOnce(food("2026-09-03", 5, "2026-09-03", "Evening"));
    const onInvalidated = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
    });
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-food"));
    expect(
      (await screen.findByTestId("food-host-probe")).getAttribute("data-slot")
    ).toBe("Morning");

    background();
    vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
    resume();

    await waitFor(() => expect(onInvalidated).toHaveBeenCalled());
    expect(screen.getByTestId("visit-view").textContent).toBe("menu");
    expect(screen.queryByTestId("food-host-probe")).toBeNull();

    // The host's close, then the next puck tap: one fresh gather, whose slot is
    // what the bar's "Add to <slot>" header seeds from.
    rerenderOpen(false);
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-food"));
    expect(
      (await screen.findByTestId("food-host-probe")).getAttribute("data-slot")
    ).toBe("Evening");
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
  });

  it("closes across local midnight inside one food window", async () => {
    loadQuickEntry.mockResolvedValue(stool());
    const onInvalidated = vi.fn();
    vi.setSystemTime(new Date("2026-09-03T23:50:00Z"));
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
    });
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");

    background();
    // Ten past midnight: still Evening, a different day.
    vi.setSystemTime(new Date("2026-09-04T00:10:00Z"));
    resume();

    await waitFor(() => expect(onInvalidated).toHaveBeenCalled());
    expect(screen.getByTestId("visit-view").textContent).toBe("menu");
  });

  it("leaves the sheet and its state alone inside one window on one day", async () => {
    loadQuickEntry.mockResolvedValue(stool());
    const onInvalidated = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
    });
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");
    fireEvent.click(screen.getByTestId("day-context-1"));
    const time = await screen.findByTestId("stool-when-time");
    fireEvent.change(time, { target: { value: "08:10" } });

    background();
    // Twenty minutes later, still Morning, still the same day. An ordinary app
    // switch is free: no timer, no minute threshold, nothing to cross.
    vi.setSystemTime(new Date("2026-09-03T08:20:00Z"));
    resume();
    await act(async () => {});

    expect(onInvalidated).not.toHaveBeenCalled();
    expect(screen.getByTestId("visit-view").textContent).toBe("stool");
    expect(
      screen
        .getByRole("button", { name: /^Yesterday$/ })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      (screen.getByTestId("stool-when-time") as HTMLInputElement).value
    ).toBe("08:10");
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
  });

  it("stays open over a body with unsaved input, boundary or not", async () => {
    foodDraft.unsaved = true;
    loadQuickEntry.mockResolvedValue(
      food("2026-09-03", 5, "2026-09-03", "Morning")
    );
    const onInvalidated = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
    });
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-food"));
    await screen.findByTestId("food-host-probe");

    background();
    vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
    resume();
    await act(async () => {});

    expect(onInvalidated).not.toHaveBeenCalled();
    // The header still names the window it gathered in — the accepted cost of not
    // prompting on resume.
    expect(
      screen.getByTestId("food-host-probe").getAttribute("data-slot")
    ).toBe("Morning");
  });

  it("dispatches nothing from a closed sheet or while the document is hidden", async () => {
    loadQuickEntry.mockResolvedValue(stool());
    const onInvalidated = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
    });

    // Closed: no listener at all, so the pair cannot record or compare anything.
    background();
    vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
    resume();
    await act(async () => {});
    expect(onInvalidated).not.toHaveBeenCalled();

    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");

    // Hidden, and still hidden: the clock moves a whole day and nothing runs
    // until the page is actually back.
    background();
    vi.setSystemTime(new Date("2026-09-04T19:00:00Z"));
    await act(async () => {});
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(screen.getByTestId("visit-view").textContent).toBe("stool");
  });

  it("keeps the day boundary when no gather published the windows", async () => {
    loadQuickEntry.mockResolvedValue(stool());
    const onInvalidated = vi.fn();
    const { rerenderOpen } = renderVisitSheet(false, undefined, {
      onInvalidated,
      slotBoundaries: null,
    });
    rerenderOpen(true);
    fireEvent.click(screen.getByTestId("visit-stool"));
    await screen.findByTestId("quick-entry-stool");

    // Morning to Evening with no boundaries to judge it by: unknown on both
    // sides, so the window decides nothing.
    background();
    vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
    resume();
    await act(async () => {});
    expect(onInvalidated).not.toHaveBeenCalled();

    // The profile day never needed them.
    background();
    vi.setSystemTime(new Date("2026-09-04T19:00:00Z"));
    resume();
    await waitFor(() => expect(onInvalidated).toHaveBeenCalled());
  });

  // THE DESKTOP PANEL, slice 2 of the same ruling (PM, 2026-09-16). Same behaviour,
  // different host: these forms are the provider's DIRECT overlay, whose `open` state
  // and draft subtree are the provider's own, so the visit's listener above cannot
  // see them. The boundary reads, the two event-time snapshots and the draft guard are
  // the SAME module (components/quick-entry/visit-resume.ts); only the host differs.
  describe("the desktop panel", () => {
    it("closes the panel in a later food window, and the next open names it", async () => {
      loadQuickEntry
        .mockResolvedValueOnce(food("2026-09-03", 5, "2026-09-03", "Morning"))
        .mockResolvedValueOnce(food("2026-09-03", 5, "2026-09-03", "Evening"));
      renderPanel();
      fireEvent.click(screen.getByTestId("panel-food"));
      expect(
        (await screen.findByTestId("food-host-probe")).getAttribute("data-slot")
      ).toBe("Morning");

      background();
      vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
      resume();

      await waitFor(() =>
        expect(screen.queryByTestId("quick-entry-sheet")).toBeNull()
      );

      // The next row tap gathers fresh, and that gather is what the bar's
      // "Add to <slot>" header seeds from.
      fireEvent.click(screen.getByTestId("panel-food"));
      await waitFor(() =>
        expect(
          screen.getByTestId("food-host-probe").getAttribute("data-slot")
        ).toBe("Evening")
      );
      expect(loadQuickEntry).toHaveBeenCalledTimes(2);
    });

    it("closes the panel across local midnight inside one food window", async () => {
      loadQuickEntry.mockResolvedValue(stool());
      vi.setSystemTime(new Date("2026-09-03T23:50:00Z"));
      renderPanel();
      fireEvent.click(screen.getByTestId("panel-stool"));
      await screen.findByTestId("quick-entry-stool");

      background();
      vi.setSystemTime(new Date("2026-09-04T00:10:00Z"));
      resume();

      await waitFor(() =>
        expect(screen.queryByTestId("quick-entry-sheet")).toBeNull()
      );
    });

    it("leaves the panel and its typed input alone inside one window on one day", async () => {
      loadQuickEntry.mockResolvedValue(stool());
      renderPanel();
      fireEvent.click(screen.getByTestId("panel-stool"));
      await screen.findByTestId("quick-entry-stool");
      fireEvent.click(await screen.findByTestId("stool-when-toggle"));
      const time = await screen.findByTestId("stool-when-time");
      fireEvent.change(time, { target: { value: "08:10" } });

      background();
      vi.setSystemTime(new Date("2026-09-03T08:20:00Z"));
      resume();
      await act(async () => {});

      expect(screen.getByTestId("quick-entry-sheet")).toBeTruthy();
      expect(
        (screen.getByTestId("stool-when-time") as HTMLInputElement).value
      ).toBe("08:10");
      expect(loadQuickEntry).toHaveBeenCalledTimes(1);
    });

    it("keeps the panel open over unsaved input, boundary or not", async () => {
      foodDraft.unsaved = true;
      loadQuickEntry.mockResolvedValue(
        food("2026-09-03", 5, "2026-09-03", "Morning")
      );
      renderPanel();
      fireEvent.click(screen.getByTestId("panel-food"));
      await screen.findByTestId("food-host-probe");

      background();
      vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
      resume();
      await act(async () => {});

      expect(screen.getByTestId("quick-entry-sheet")).toBeTruthy();
      // The header still names the window it gathered in — the same accepted cost
      // the phone sheet pays for not prompting on resume.
      expect(
        screen.getByTestId("food-host-probe").getAttribute("data-slot")
      ).toBe("Morning");
    });

    it("dispatches nothing from a closed panel or while the document is hidden", async () => {
      loadQuickEntry.mockResolvedValue(stool());
      renderPanel();

      background();
      vi.setSystemTime(new Date("2026-09-03T19:00:00Z"));
      resume();
      await act(async () => {});
      expect(screen.queryByTestId("quick-entry-sheet")).toBeNull();
      expect(loadQuickEntry).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("panel-stool"));
      await screen.findByTestId("quick-entry-stool");

      background();
      vi.setSystemTime(new Date("2026-09-04T19:00:00Z"));
      await act(async () => {});
      expect(screen.getByTestId("quick-entry-sheet")).toBeTruthy();
    });
  });
});
