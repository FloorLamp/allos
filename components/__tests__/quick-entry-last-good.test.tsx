import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider } from "@/components/Toast";
import QuickEntryProvider, {
  useQuickEntry,
} from "@/components/QuickEntryProvider";
import { clearLastGood } from "@/lib/offline/quick-entry-read";
import { SNAPSHOT_VERSION, type AnySnapshot } from "@/lib/offline/snapshots";
import type { QuickEntryForm } from "@/lib/quick-log";
import type { SessionProfile } from "@/lib/auth";

// COMPONENT TIER — #3416/#4454/#5211, the sheet's offline OPEN path: last-good render
// with a revalidate behind it, keyed by the day-context key (a response is applied
// only if the context it was issued for is still on screen; a copy held for one day
// never fills the next day's form), a failed revalidate keeping what is shown under
// the as-of line, a cold failure falling back to the device's own copy, a stalled
// gather doing the same, Retry re-running the SAME gather, a failed body chunk
// reaching the same retry state, and the acting-profile change dropping the cache.

const loadQuickEntry = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/quick-entry-actions", () => ({ loadQuickEntry }));

const allSnapshots = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown[]> => [])
);
vi.mock("@/lib/offline/snapshot-db", () => ({ allSnapshots }));
const allIntents = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("@/lib/offline/queue-db", () => ({ allIntents }));

// The bodies are stubs: what they render is their own tests' business, and what this
// file asserts is WHICH props reached them. `UploadForm` also throws on demand — the
// chunk-failure stand-in (a lazy import that rejects and a body that throws land on the
// same boundary).
vi.mock("@/components/stool/StoolTypeControl", () => ({
  default: ({ todayCount, today }: { todayCount: number; today: string }) => (
    <div data-testid="stub-stool">
      {today}:{todayCount}
    </div>
  ),
}));
vi.mock("@/components/quick-entry/QuickDoseList", () => {
  function StubDose({ doses }: { doses: { doseId: number }[] }) {
    // The list's `resolved` set, in miniature: a dose confirmed during this overlay
    // session is struck off in LOCAL state and the rows are filtered by it, so a
    // remount would put the row back — which is the thing this file now asserts does
    // not happen. The confirm button carries no text, so the rows stay the whole
    // textContent for every other test here.
    const [resolved, setResolved] = useState<number[]>([]);
    return (
      <div data-testid="stub-dose" data-resolved={resolved.join(",")}>
        {doses
          .filter((d) => !resolved.includes(d.doseId))
          .map((d) => d.doseId)
          .join(",")}
        <button
          data-testid="stub-dose-confirm"
          onClick={() =>
            setResolved((current) =>
              doses[0] ? [...current, doses[0].doseId] : current
            )
          }
        />
      </div>
    );
  }
  return { default: StubDose };
});
vi.mock("@/components/mood/MoodForm", () => {
  function StubMood({
    days,
    dayUnseen,
    onStagedChange,
    onDone,
  }: {
    days: { date: string }[];
    dayUnseen?: boolean;
    onStagedChange?: (staged: boolean) => void;
    onDone?: () => void;
  }) {
    // SEEDED ONCE, as the real form seeds its fields — so this stub can tell a
    // remount from a prop swap. `composed-*` is what the mount was built from;
    // the attributes beside it are the props as they stand now. The two agreeing
    // is the property: a form's sight is the sight it was composed under.
    const [composed] = useState(() => ({
      days: days.map((d) => d.date).join(","),
      dayUnseen: dayUnseen ?? false,
    }));
    // The real form's half of the announcement contract (pinned on the real form in
    // mood-two-pieces): it reports staged input while it is mounted and false when it
    // goes. The button carries no text, so the days stay the whole textContent.
    const [staged, setStaged] = useState(false);
    useEffect(() => {
      onStagedChange?.(staged);
      return () => onStagedChange?.(false);
    }, [staged, onStagedChange]);
    return (
      <div
        data-testid="stub-mood"
        data-day-unseen={String(dayUnseen ?? false)}
        data-composed-unseen={String(composed.dayUnseen)}
        data-composed-days={composed.days}
      >
        {days.map((d) => d.date).join(",")}
        <button data-testid="stub-mood-stage" onClick={() => setStaged(true)} />
        {/* THE REAL FORM'S ORDER when a quick check-in succeeds: it closes the sheet
            (`complete` → `onDone`) and only THEN does its write release the fields,
            at which point the effect above reports what they still hold. Modelled
            imperatively because the point is the ORDER, not the state. */}
        <button
          data-testid="stub-mood-wrote-and-closed"
          onClick={() => {
            onDone?.();
            onStagedChange?.(true);
          }}
        />
      </div>
    );
  }
  return { default: StubMood };
});
const upload = vi.hoisted(() => ({ failing: false }));
vi.mock("@/components/UploadForm", () => ({
  default: () => {
    if (upload.failing) throw new Error("chunk failed to load");
    return <div data-testid="stub-upload" />;
  },
}));

const ACTING: SessionProfile = {
  id: 1,
  name: "Dad",
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

function Sheet() {
  const { open, close } = useQuickEntry();
  return (
    <>
      {(["stool", "document", "dose", "mood"] as const).map((form) => (
        <button key={form} onClick={() => open(form)}>
          open {form}
        </button>
      ))}
      <button onClick={close}>close</button>
    </>
  );
}

function renderSheet(actingProfileId = ACTING.id) {
  const tree = (id: number) => (
    <ToastProvider>
      <QuickEntryProvider
        measurements={MEASUREMENTS}
        writableProfiles={[ACTING]}
        actingProfileId={id}
      >
        <Sheet />
      </QuickEntryProvider>
    </ToastProvider>
  );
  const utils = render(tree(actingProfileId));
  return {
    ...utils,
    rerenderWithActing: (id: number) => utils.rerender(tree(id)),
  };
}

function unavailable(message: string) {
  return { form: "unavailable" as const, message };
}

const open = (form: QuickEntryForm) =>
  fireEvent.click(screen.getByText(`open ${form}`));

const today = () => new Date().toISOString().slice(0, 10);

function doseSnapshot(date: string, profileId = ACTING.id): AnySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "dose-schedule",
    profileId,
    timeZone: "UTC",
    capturedOn: date,
    fetchedAt: `${date}T06:00:00Z`,
    data: {
      date,
      entries: [
        {
          doseId: 41,
          name: "Sertraline",
          detail: "50 mg",
          slot: "Morning",
          status: "pending",
        },
      ],
    },
  };
}

beforeEach(() => {
  loadQuickEntry.mockReset();
  allSnapshots.mockReset().mockResolvedValue([]);
  allIntents.mockReset().mockResolvedValue([]);
  upload.failing = false;
  clearLastGood();
});

describe("last-good render, revalidate behind it (#3416 proposal 1)", () => {
  it("a reopen after a successful open renders instantly from last-good, then updates — one gather per open either way", async () => {
    let resolveSecond: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      );

    renderSheet();
    open("stool");
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("v1");
    expect(loadQuickEntry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("close"));
    open("stool");

    // INSTANT: no loading state, v1 is already on screen from the cache — before
    // the second (background) gather has even resolved — and no as-of line, since
    // the revalidate is the request that is about to answer.
    expect(screen.queryByTestId("quick-entry-loading")).toBeNull();
    expect(screen.queryByTestId("quick-entry-asof")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );
    // The SAME one gather an open always made (#3369): the cache adds none.
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
    // Never touched on a warm open: the device copy is read only on the way to a
    // failure.
    expect(allSnapshots).not.toHaveBeenCalled();

    resolveSecond!(unavailable("v2"));
    await waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("v2")
    );
    // A revalidate is not a change of sight (#3416): both the held copy and the
    // answer behind it are the server's, so the body is refreshed in place — nothing
    // is remounted, nothing staged is discarded, and nothing is announced.
    expect(
      screen.getByTestId("quick-entry-body").getAttribute("data-body-sight")
    ).toBe("read");
    expect(
      screen.queryByText(/Anything typed on the offline copy was discarded/)
    ).toBeNull();
  });

  it("a failed revalidate behind a last-good render keeps the rendered form and says what it is", async () => {
    loadQuickEntry
      .mockResolvedValueOnce(unavailable("v1"))
      .mockRejectedValueOnce(new Error("offline"));

    renderSheet();
    open("stool");
    await screen.findByTestId("quick-entry-unavailable");

    fireEvent.click(screen.getByText("close"));
    open("stool");

    await waitFor(() => expect(loadQuickEntry).toHaveBeenCalledTimes(2));
    // The failed background revalidate must not blank the sheet into the error
    // state — the last-good copy is still a correct, if slightly stale, answer —
    // and from here what is shown did not just come from the server (#2908).
    expect(screen.queryByTestId("quick-entry-error")).toBeNull();
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "v1"
    );
    expect((await screen.findByTestId("quick-entry-asof")).textContent).toMatch(
      /^As of .* — couldn't refresh\.$/
    );
  });

  it("the acting profile changing drops the cache — a same-form reopen loads again rather than flashing the last-good copy", async () => {
    loadQuickEntry.mockResolvedValue(unavailable("v1"));
    const { rerenderWithActing } = renderSheet();
    open("stool");
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    rerenderWithActing(99);
    loadQuickEntry.mockClear();
    let resolveNext: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve))
    );
    open("stool");

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
});

describe("the #5211 day-context key", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("a copy held for one day never fills the next day's form (clauses 3 and 5)", async () => {
    vi.setSystemTime(new Date("2026-09-05T23:59:00Z"));
    loadQuickEntry.mockResolvedValueOnce(unavailable("the 5th"));
    renderSheet();
    open("stool");
    await screen.findByTestId("quick-entry-unavailable");
    fireEvent.click(screen.getByText("close"));

    // Midnight in the sheet's zone (the test tree's TimezoneProvider default, UTC).
    vi.setSystemTime(new Date("2026-09-06T00:01:00Z"));
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    open("stool");
    // A MISS, not yesterday's copy: the key moved with the day.
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
    expect(screen.queryByTestId("quick-entry-unavailable")).toBeNull();
  });

  it("a response issued for a context no longer on screen is discarded whole", async () => {
    vi.setSystemTime(new Date("2026-09-05T23:59:00Z"));
    let resolveLate: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveLate = resolve))
      )
      .mockResolvedValueOnce(unavailable("the 6th"));
    renderSheet();
    open("stool");
    vi.setSystemTime(new Date("2026-09-06T00:01:00Z"));
    open("stool");
    expect(
      (await screen.findByTestId("quick-entry-unavailable")).textContent
    ).toContain("the 6th");

    resolveLate!(unavailable("the 5th, late"));
    await act(async () => {});
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "the 6th"
    );
    // And it was not remembered under the key it was not issued for: a reopen on
    // the 6th finds the 6th's copy.
    fireEvent.click(screen.getByText("close"));
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    open("stool");
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "the 6th"
    );
  });
});

describe("a cold failure falls back to the device's own copy (#3416 proposal 2)", () => {
  it("a form with no copy on the device reaches the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    open("document");
    expect(await screen.findByTestId("quick-entry-error")).not.toBeNull();
    expect(allSnapshots).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["today's", 0, "renders"],
    ["yesterday's", -1, "is a miss for"],
  ])(
    "%s dose-schedule snapshot %s today's sheet",
    async (_which, shift, verdict) => {
      const day = new Date(Date.now() + shift * 86_400_000)
        .toISOString()
        .slice(0, 10);
      allSnapshots.mockResolvedValue([doseSnapshot(day)]);
      loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
      renderSheet();
      open("dose");
      if (verdict === "renders") {
        expect((await screen.findByTestId("stub-dose")).textContent).toBe("41");
        // The line names the ONE day the copy holds and why there is no way back to
        // the others — the switcher is not offered, so the absence is said out loud.
        expect(screen.getByTestId("quick-entry-asof").textContent).toMatch(
          /^As of .* — this device's copy of today\. Earlier days need a connection\.$/
        );
      } else {
        // Not a stale form: the copy is for a day the sheet is not standing on.
        expect(await screen.findByTestId("quick-entry-error")).not.toBeNull();
      }
    }
  );

  // THE FENCE REACHES THE FORM (#3416). A cold open's mood days carry only what this
  // device queued itself, so the form must know it may not treat what it cannot show
  // as an answer; a gathered one saw the day and carries no such claim.
  it("the mood form built from the device is told its days were not read", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    open("mood");
    expect(
      (await screen.findByTestId("stub-mood")).getAttribute("data-day-unseen")
    ).toBe("true");

    cleanup();
    loadQuickEntry.mockResolvedValueOnce({
      form: "mood" as const,
      days: [{ date: today(), label: "Today", mood: null }],
      showCalm: false,
    });
    renderSheet();
    open("mood");
    expect(
      (await screen.findByTestId("stub-mood")).getAttribute("data-day-unseen")
    ).toBe("false");
  });

  it("stool opens from what the device knows — its day and its own queued taps — and says so", async () => {
    allIntents.mockResolvedValue([
      {
        key: "k1",
        flow: "stool",
        date: today(),
        capturedAt: new Date().toISOString(),
        payload: { type: 4, at: null },
        profileId: ACTING.id,
      },
    ]);
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    open("stool");
    expect((await screen.findByTestId("stub-stool")).textContent).toBe(
      `${today()}:1`
    );
    expect(screen.getByTestId("quick-entry-asof").textContent).toBe(
      "Offline — showing only what's queued on this device."
    );
  });
});

describe("the stall bound and Retry (#3416 proposals 3 and 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a gather stalled past the timeout reaches the error state, not perpetual Loading — and a late answer still lands", async () => {
    let resolveLate: (v: ReturnType<typeof unavailable>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    renderSheet();
    open("document");
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId("quick-entry-error")).not.toBeNull();

    // The timeout invalidated nothing but the WAIT: the action was still running,
    // and its answer for the context still on screen is applied (fresh wins).
    resolveLate!(unavailable("late but real"));
    await act(async () => {});
    expect(screen.getByTestId("quick-entry-unavailable").textContent).toContain(
      "late but real"
    );
  });

  it("a stall with a copy on the device shows the copy", async () => {
    allSnapshots.mockResolvedValue([doseSnapshot(today())]);
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    renderSheet();
    open("dose");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId("stub-dose").textContent).toBe("41");
  });

  // THE FENCE CANNOT BE TAKEN AWAY FROM A FORM THAT IS STILL BLIND (#3416). The
  // stall bound does not cancel the gather, so a slow-but-alive link answers with the
  // real day while the device-known form is still on screen. The mood form's fields
  // are seeded once at mount, so leaving that mount up and moving `dayUnseen` off it
  // would strand a blind composition beside a payload that saw the day — and the next
  // tap would write the replacing statement over the day the answer just delivered.
  it("a late answer under a form composed blind remounts it with the day rather than taking its fence away", async () => {
    let resolveLate: (v: unknown) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    renderSheet();
    open("mood");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const blind = screen.getByTestId("stub-mood");
    expect(
      screen.getByTestId("quick-entry-body").getAttribute("data-body-sight")
    ).toBe("device");
    expect(blind.getAttribute("data-day-unseen")).toBe("true");
    expect(blind.getAttribute("data-composed-unseen")).toBe("true");
    expect(screen.getByTestId("quick-entry-asof").textContent).toBe(
      "Offline — showing only what's queued on this device."
    );

    resolveLate!({
      form: "mood" as const,
      days: [
        { date: today(), label: "Today", mood: null },
        { date: "2026-01-01", label: "New Year", mood: null },
      ],
      showCalm: true,
    });
    await act(async () => {});

    const seeing = screen.getByTestId("stub-mood");
    expect(
      screen.getByTestId("quick-entry-body").getAttribute("data-body-sight")
    ).toBe("read");
    // The day arrived, so the form on screen is one built FROM the day: it shows the
    // gathered days, it was composed from them, and it claims no blindness.
    expect(seeing.textContent).toBe(`${today()},2026-01-01`);
    expect(seeing.getAttribute("data-composed-days")).toBe(
      `${today()},2026-01-01`
    );
    expect(seeing.getAttribute("data-day-unseen")).toBe("false");
    expect(seeing.getAttribute("data-composed-unseen")).toBe("false");
    // …and the sheet stops saying it is showing the device's copy, because it is not.
    expect(screen.queryByTestId("quick-entry-asof")).toBeNull();
    // NOTHING WAS TYPED ON THAT COPY, so nothing was discarded and nothing is said.
    // The announcement is about a loss; a person who opened the sheet, read the
    // offline line and touched nothing has lost nothing to be told about.
    expect(
      screen.queryByText(/typed on the offline copy was discarded/)
    ).toBeNull();
  });

  // …AND THE SAME REMOUNT, WITH SOMETHING ON THE FORM, IS ANNOUNCED. The half-typed
  // check-in composed during the stall is the remount's stated cost, so it is said
  // out loud — but only here, where it actually happened.
  it("the remount announces the discard when the blind form was holding something", async () => {
    let resolveLate: (v: unknown) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    renderSheet();
    open("mood");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    fireEvent.click(screen.getByTestId("stub-mood-stage"));

    resolveLate!({
      form: "mood" as const,
      days: [{ date: today(), label: "Today", mood: null }],
      showCalm: true,
    });
    await act(async () => {});

    expect(
      screen.getByTestId("stub-mood").getAttribute("data-composed-unseen")
    ).toBe("false");
    expect(
      screen.getByText(
        "Connected — this form now shows what's saved. What you typed on the offline copy was discarded."
      )
    ).not.toBeNull();
  });

  // AND NOT INTO A SCREEN THAT IS ALREADY GONE (#3416). A check-in that succeeds
  // CLOSES the sheet, and its write releases the fields a moment later — so the body,
  // still mounted behind the exit, reports that it is holding the note it just wrote.
  // Clearing the ref once on the way out left that later report standing, and the
  // stalled gather answering afterwards spoke a discard into the page behind a sheet
  // nobody could see, about a check-in that landed. A closed sheet holds nothing.
  it("a check-in that already closed the sheet is not announced into the screen behind it", async () => {
    let resolveLate: (v: unknown) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    renderSheet();
    open("mood");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    fireEvent.click(screen.getByTestId("stub-mood-stage"));
    fireEvent.click(screen.getByTestId("stub-mood-wrote-and-closed"));

    resolveLate!({
      form: "mood" as const,
      days: [{ date: today(), label: "Today", mood: null }],
      showCalm: true,
    });
    await act(async () => {});

    expect(
      screen.queryByText(
        "Connected — this form now shows what's saved. What you typed on the offline copy was discarded."
      )
    ).toBeNull();
  });

  // A BODY WITH NO FENCE TO LOSE KEEPS ITS MOUNT (#3416). The dose list's write is
  // per (dose, day) and idempotent, so nothing about it depends on the sight — while
  // the confirm the person just made offline lives in that mount, and the late answer
  // was gathered BEFORE the tap and knows nothing about it (the queue has not
  // drained). Remounting here would re-offer a dose they already took and then
  // announce a discard that never happened.
  it("a late answer under a dose list keeps the confirm the person made offline, and says nothing", async () => {
    allSnapshots.mockResolvedValue([doseSnapshot(today())]);
    let resolveLate: (v: unknown) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    renderSheet();
    open("dose");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      screen.getByTestId("quick-entry-body").getAttribute("data-body-sight")
    ).toBe("device");
    expect(screen.getByTestId("stub-dose").textContent).toBe("41");

    // Confirmed offline: the row is struck off in the mount's own state.
    fireEvent.click(screen.getByTestId("stub-dose-confirm"));
    expect(screen.getByTestId("stub-dose").textContent).toBe("");

    // The answer the server was still working on lands, still offering the dose.
    resolveLate!({
      form: "dose" as const,
      today: today(),
      doses: [
        {
          doseId: 41,
          title: "Sertraline",
          detail: "50 mg",
          dueText: "Morning",
        },
      ],
      prn: [],
      pastDays: [],
    });
    await act(async () => {});

    const list = screen.getByTestId("stub-dose");
    expect(
      screen.getByTestId("quick-entry-body").getAttribute("data-body-sight")
    ).toBe("read");
    // The mount survived the change of sight, so the confirm survived with it: the
    // dose is not offered again…
    expect(list.getAttribute("data-resolved")).toBe("41");
    expect(list.textContent).toBe("");
    // …and nothing was discarded, so nothing is announced over it.
    expect(
      screen.queryByText(/typed on the offline copy was discarded/)
    ).toBeNull();
  });

  it("Retry re-runs the SAME gather and a success replaces the error state", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    renderSheet();
    open("document");
    await vi.waitFor(() =>
      expect(screen.getByTestId("quick-entry-error")).not.toBeNull()
    );

    loadQuickEntry.mockResolvedValueOnce(unavailable("recovered"));
    fireEvent.click(screen.getByTestId("quick-entry-retry"));

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("quick-entry-unavailable").textContent
      ).toContain("recovered")
    );
    expect(loadQuickEntry).toHaveBeenCalledTimes(2);
  });

  it("a body that fails to load reaches the same retry state, and Retry recovers it in place", async () => {
    vi.useRealTimers();
    upload.failing = true;
    loadQuickEntry.mockResolvedValue({ form: "document", demo: false });
    // React reports the caught throw on the console; that is the boundary working.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderSheet();
      open("document");
      expect(await screen.findByTestId("quick-entry-error")).not.toBeNull();

      // The chunk is fetchable again; Retry re-mints the bodies and asks again.
      upload.failing = false;
      fireEvent.click(screen.getByTestId("quick-entry-retry"));
      expect(await screen.findByTestId("stub-upload")).not.toBeNull();
      expect(screen.queryByTestId("quick-entry-error")).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});

// THE WIPE PERIMETER (#3053/#2908's boundary, this store's half). The last-good map
// is module state — it has to be, so the device wipe can reach it — which means the
// wipe alone is not the fence: the document stays mounted and interactive for the
// whole sign-out round trip, nothing cancels a Server Action, and a sign-out is a
// client navigation, so the next sign-in mounts a new host in the SAME document.
// `clearLastGood()` below is exactly what `wipeDeviceForSignOut` calls, synchronously,
// at the top of that round trip (components/device-wipe.ts).
describe("the wipe holds against a late writer and against the next mount", () => {
  const doseData = (doseId: number) => ({
    form: "dose" as const,
    today: today(),
    doses: [
      {
        doseId,
        title: "Sertraline",
        detail: "50 mg",
        dueText: "Morning",
      },
    ],
    pastDays: [],
  });

  it("a gather answered AFTER the wipe is not remembered — a reopen finds a miss", async () => {
    let resolveHeld: (v: ReturnType<typeof doseData>) => void;
    loadQuickEntry.mockImplementationOnce(
      () => new Promise((resolve) => (resolveHeld = resolve))
    );
    renderSheet();
    open("dose");

    // Log out: the wipe empties the store while the gather is still in flight.
    act(() => clearLastGood());
    await act(async () => resolveHeld!(doseData(41)));

    // Nothing was written back into the cleared store, so a reopen is a MISS and
    // asks the server again rather than repainting the wiped copy instantly.
    fireEvent.click(screen.getByText("close"));
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    open("dose");
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
    expect(screen.queryByTestId("stub-dose")).toBeNull();
  });

  it("a copy gathered after the wipe does not paint into the next sign-in's first open", async () => {
    // The other half: a gather STARTED after the wipe, answered 200 by a session
    // that has not ended yet. It is this session's own data and it renders here —
    // but the host that mounts for the next sign-in must not inherit it.
    loadQuickEntry.mockResolvedValueOnce(doseData(42));
    const { unmount } = renderSheet();
    act(() => clearLastGood());
    open("dose");
    expect((await screen.findByTestId("stub-dose")).textContent).toBe("42");

    unmount();
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    renderSheet();
    open("dose");
    expect(screen.getByTestId("quick-entry-loading")).not.toBeNull();
    expect(screen.queryByTestId("stub-dose")).toBeNull();
  });
});

// The device-known layer is bounded by the ACTING profile because the queue captures
// under it and refuses a cross-profile write — `MoodForm` refuses to queue whenever
// its subject is set, so a mood form built for anyone else is a door onto a refusal.
// Nothing mints a new request when the acting profile moves, so the bound has to be
// asked of the profile acting when the answer LANDS.
describe("the acting bound under an in-flight recovery", () => {
  it("a switch while the device read is in flight reaches the retry state, not the previous profile's mood form", async () => {
    loadQuickEntry.mockRejectedValueOnce(new Error("offline"));
    let releaseIntents: (v: unknown[]) => void;
    allIntents.mockImplementationOnce(
      () => new Promise((resolve) => (releaseIntents = resolve))
    );
    const { rerenderWithActing } = renderSheet();
    open("mood");
    await waitFor(() => expect(allIntents).toHaveBeenCalledTimes(1));

    // The acting profile moves while the recovery is waiting on the device.
    rerenderWithActing(99);
    await act(async () => releaseIntents!([]));

    expect(screen.getByTestId("quick-entry-error")).not.toBeNull();
    expect(screen.queryByTestId("stub-mood")).toBeNull();
  });
});
