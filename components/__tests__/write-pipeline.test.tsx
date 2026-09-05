import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import {
  useWritePipeline,
  type WriteResult,
  type WriteSpec,
} from "@/components/useWritePipeline";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";
import { OFFLINE_CAPTURE_REFUSED_MESSAGE } from "@/lib/offline/queue";
import { dateStrInTz } from "@/lib/date";
import { UNDO_TOAST_MS } from "@/lib/undo-offer";

// THE FOUR CLASSES THE PIPELINE MAKES UNREPRESENTABLE (#3276's 2026-08-31 amendment).
// Each was measured live on main, one surface at a time, because the step is
// forgettable. Here the type system or the hook's own shape is what remembers, so these
// guards are about STRUCTURE — what a caller is able to express — not about copy.
//
// The runtime half is below; the compile-time half is `useTypeCheckedGuards`, which is
// checked by `npm run typecheck` and asserts nothing at runtime by design.

const mocks = vi.hoisted(() => ({ toast: vi.fn(), enqueue: vi.fn() }));

vi.mock("@/components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: mocks.enqueue }),
}));

// The REAL ledger, the REAL surface context and the REAL undo wiring run here: a
// stubbed ledger would make every tap a no-op, and a stubbed surface would prove the
// stamp is applied by the test rather than by the pipeline.
function Tap({
  spec,
  onResult,
}: {
  spec: WriteSpec<"dose-status", { ok: true } | { ok: false; error: string }>;
  onResult?: (result: WriteResult) => void;
}) {
  const pipeline = useWritePipeline("dose-status");
  return (
    <button
      type="button"
      onClick={() => void pipeline.run(spec).then((r) => onResult?.(r))}
    >
      tap
    </button>
  );
}

// Resolves with what the pipeline answered, so a case can assert on state the run only
// reaches after a real timer — an `act` that merely flushes microtasks returns while the
// write is still in flight, and every assertion after it reads an empty mock.
async function tapInside(
  spec: WriteSpec<"dose-status", { ok: true } | { ok: false; error: string }>
): Promise<WriteResult> {
  let settle!: (result: WriteResult) => void;
  const done = new Promise<WriteResult>((resolve) => (settle = resolve));
  render(
    <LoggedViaSurface value="quick-log">
      <Tap spec={spec} onResult={settle} />
    </LoggedViaSurface>
  );
  await act(async () => {
    screen.getByRole("button", { name: "tap" }).click();
    await done;
  });
  return done;
}

// The acting profile's zone, which is what a real caller reads off `useTimezone()` —
// never the browser's (#4559). Named here so this stand-in spells the day the same way
// `DoseStatusControl` does.
const PROFILE_TZ = "UTC";

// A spec with every declaration the pipeline demands, so each case below overrides only
// the one thing it is about.
function doseSpec(
  over: Partial<
    WriteSpec<"dose-status", { ok: true } | { ok: false; error: string }>
  > = {}
): WriteSpec<"dose-status", { ok: true } | { ok: false; error: string }> {
  return {
    fields: { dose_id: "7" },
    action: async () => ({ ok: true }) as const,
    settle: (result) =>
      result.ok
        ? { wrote: true, announce: { message: "Dose logged", undo: null } }
        : {
            wrote: false,
            announce: { message: result.error, tone: "error", undo: null },
          },
    failureMessage: "Couldn't update this dose. Try again.",
    offline: (tappedAt) => ({
      kind: "capture",
      flow: "dose",
      date: dateStrInTz(PROFILE_TZ, tappedAt),
      payload: { doseId: 7, clientTakenAt: tappedAt.toISOString() },
      keptMessage: "Dose saved offline — will sync when you reconnect.",
    }),
    ...over,
  } as WriteSpec<"dose-status", { ok: true } | { ok: false; error: string }>;
}

describe("the client write pipeline (#3276)", () => {
  beforeEach(() => vi.clearAllMocks());

  // CLASS 1 — PROVENANCE. `DoseHistoryPanel` builds a bare `new FormData()` and every
  // backfill it posts stamps `"page"`. A pipeline caller never holds a FormData: it
  // hands `fields`, and the surface comes off the region context it is mounted in.
  it("stamps the mounting surface on a post the caller never built", async () => {
    const posted: FormData[] = [];
    await tapInside(
      doseSpec({
        action: async (formData) => {
          posted.push(formData);
          return { ok: true } as const;
        },
      })
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]!.get(LOGGED_VIA_FIELD)).toBe("quick-log");
    expect(posted[0]!.get("dose_id")).toBe("7");
  });

  // CLASS 2 — OFFLINE ENQUEUE, and CLASS 4's client instant with it. The capture is
  // taken from the moment of the TAP, before the online attempt, so a dead-spot confirm
  // records when the dose was taken rather than when the request gave up (#1427); the
  // caller cannot mint that instant, so it cannot mint the wrong one.
  it.each([
    {
      name: "a browser that reports itself offline",
      online: false,
      action: async () => ({ ok: true }) as const,
    },
    {
      name: "a submit that dies on a dropped connection",
      online: true,
      action: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ])(
    "captures the tap's own instant when $name",
    async ({ online, action }) => {
      vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(online);
      mocks.enqueue.mockResolvedValue("kept");
      const before = Date.now();
      const result = await tapInside(doseSpec({ action }));
      const after = Date.now();

      expect(result).toBe("captured");
      const [flow, date, payload] = mocks.enqueue.mock.calls[0]!;
      expect(flow).toBe("dose");
      expect(Date.parse(payload.clientTakenAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(payload.clientTakenAt)).toBeLessThanOrEqual(after);
      expect(date).toBe(
        dateStrInTz(PROFILE_TZ, new Date(payload.clientTakenAt))
      );
      expect(mocks.toast).toHaveBeenCalledWith(
        "Dose saved offline — will sync when you reconnect."
      );
    }
  );

  // …and the ORDER is the half a same-millisecond window cannot see. The action here
  // takes a measurable 25ms before it dies, so an instant minted in the catch — "when we
  // gave up" — lands strictly after the request began and this fails.
  it("stamps the instant before the attempt, not after it gives up", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    mocks.enqueue.mockResolvedValue("kept");
    let actionRanAt = 0;

    await tapInside(
      doseSpec({
        action: async () => {
          actionRanAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new TypeError("Failed to fetch");
        },
      })
    );

    const [, , payload] = mocks.enqueue.mock.calls[0]!;
    expect(Date.parse(payload.clientTakenAt)).toBeLessThanOrEqual(actionRanAt);
    expect(
      Date.now() - Date.parse(payload.clientTakenAt)
    ).toBeGreaterThanOrEqual(25);
  });

  // The queue can refuse the capture (#3038), and the pipeline reads the answer rather
  // than promising a sync nothing will perform.
  it("refuses honestly when the device does not keep the capture", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    mocks.enqueue.mockResolvedValue("failed");

    const result = await tapInside(doseSpec());

    expect(result).toBe("nothing");
    expect(mocks.toast).toHaveBeenCalledWith(OFFLINE_CAPTURE_REFUSED_MESSAGE, {
      tone: "error",
    });
  });

  // The classifier's other half: a rejection while genuinely ONLINE is a real error the
  // surface must show, never a capture (lib/offline/queue.ts::shouldQueueOffline).
  it("reports a server-side rejection instead of queueing it", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);

    const result = await tapInside(
      doseSpec({
        action: async () => {
          throw new Error("boom");
        },
      })
    );

    expect(result).toBe("nothing");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Couldn't update this dose. Try again.",
      { tone: "error" }
    );
  });

  // CLASS 3 — UNDO. The sheet's "Mark taken" has none while `DoseConfirmButton` does,
  // because nothing asked. Here the announcement's `undo` is required, and a
  // declared offer rides the toast through the shared 15s window.
  it("carries a declared undo offer onto the outcome toast", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    const run = vi.fn(async () => ({ ok: true }) as const);

    await tapInside(
      doseSpec({
        settle: () => ({
          wrote: true,
          announce: {
            message: "Dose logged",
            undo: { undoneMessage: "Dose confirm undone", run },
          },
        }),
      })
    );

    const [message, options] = mocks.toast.mock.calls.at(-1)!;
    expect(message).toBe("Dose logged");
    expect(options.duration).toBe(UNDO_TOAST_MS);
    expect(options.action.label).toBe("Undo");
    await act(async () => {
      options.action.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenLastCalledWith(
      "Dose confirm undone",
      expect.anything()
    );
  });
});

// ── THE OPTIMISTIC-VALUE CHANNEL (#3728) ─────────────────────────────────────
//
// One displayed number, taps keyed the way a multi-target surface keys them (the stool
// row's seven buttons over one day count), and the REAL ledger underneath. What is
// asserted is the value a person is looking at after each ending — the matrix the
// adopters used to each spell for themselves.
//
// WHAT IT DOES NOT ASSERT, and a reader needs to know: the ledger PHASE. `keep` and a
// rollback aimed at the projection land the same number and differ only in whether the
// key enters the post-success cooldown, so this table cannot tell them apart — which is
// how a mutation swapping one for the other stayed green here. The phase transitions
// are `lib/__tests__/one-tap.test.ts`'s, on the pure machine, and pinning them a second
// time here would be a second spelling of one question.

type DoseOutcome = { ok: true } | { ok: false; error: string };

// A gate the case opens when it wants the write to answer, so the painted value can be
// read while the request is genuinely still out.
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

interface CounterTap {
  readonly key: string;
  /** Resolves once the request is allowed to answer; may throw to drop it. */
  readonly action: () => Promise<DoseOutcome>;
  /** The server's own figure, when the write names one. */
  readonly landed?: number;
}

function Counter({
  start,
  taps,
  onResult,
}: {
  start: number;
  taps: readonly CounterTap[];
  onResult: (key: string, result: WriteResult) => void;
}) {
  const pipeline = useWritePipeline<"dose-status", number>("dose-status");
  const [value, setValue] = useState(start);
  return (
    <div>
      <span data-testid="value">{value}</span>
      {taps.map((tap) => (
        <button
          key={tap.key}
          type="button"
          data-testid={`tap-${tap.key}`}
          onClick={() =>
            void pipeline
              .run({
                key: tap.key,
                // Read from this render, exactly as an adopter's handler reads its own
                // state — so the concurrency case below is the real one and not a ref
                // the harness kept fresh on the pipeline's behalf.
                optimistic: { from: value, to: value + 1, commit: setValue },
                fields: { dose_id: "7" },
                action: tap.action,
                settle: (result) =>
                  result.ok
                    ? {
                        wrote: true,
                        announce: "silent" as const,
                        ...(tap.landed === undefined
                          ? {}
                          : { value: tap.landed }),
                      }
                    : {
                        wrote: false,
                        announce: {
                          message: result.error,
                          tone: "error" as const,
                          undo: null,
                        },
                      },
                failureMessage: "Couldn't update this dose. Try again.",
                offline: (tappedAt) => ({
                  kind: "capture",
                  flow: "dose",
                  date: dateStrInTz(PROFILE_TZ, tappedAt),
                  payload: { doseId: 7, clientTakenAt: tappedAt.toISOString() },
                  keptMessage:
                    "Dose saved offline — will sync when you reconnect.",
                }),
              })
              .then((result) => onResult(tap.key, result))
          }
        >
          {tap.key}
        </button>
      ))}
    </div>
  );
}

const shown = () => Number(screen.getByTestId("value").textContent);

describe("the optimistic value a quick-log tap moves (#3728)", () => {
  beforeEach(() => vi.clearAllMocks());

  // THE FIVE ENDINGS, all from a 5 that this tap paints as a 6. Two leave the
  // projection standing and three take it back, and the difference is read off the same
  // typed outcome that picks the sentence — never off the ask.
  it.each([
    {
      name: "adopts the server's own total over the guess",
      online: true,
      answer: () => ({ ok: true }) as DoseOutcome,
      landed: 9,
      result: "wrote",
      after: 9,
    },
    {
      name: "leaves the projection standing when the write names no figure",
      online: true,
      answer: () => ({ ok: true }) as DoseOutcome,
      result: "wrote",
      after: 6,
    },
    {
      name: "takes the projection back on a typed refusal",
      online: true,
      answer: () =>
        ({ ok: false, error: "That dose was retired." }) as DoseOutcome,
      result: "nothing",
      after: 5,
    },
    {
      name: "takes the projection back when the request dies online",
      online: true,
      answer: (): DoseOutcome => {
        throw new Error("boom");
      },
      result: "nothing",
      after: 5,
    },
    {
      name: "leaves the projection standing for a capture the device keeps",
      online: false,
      enqueue: "kept",
      result: "captured",
      after: 6,
    },
    {
      name: "takes the projection back when the device refuses the capture",
      online: false,
      enqueue: "failed",
      result: "nothing",
      after: 5,
    },
  ])("$name", async ({ online, enqueue, answer, landed, result, after }) => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(online);
    const held = gate();
    if (enqueue)
      mocks.enqueue.mockImplementation(async () => {
        await held.promise;
        return enqueue;
      });
    const answered: WriteResult[] = [];
    render(
      <LoggedViaSurface value="quick-log">
        <Counter
          start={5}
          onResult={(_key, value) => answered.push(value)}
          taps={[
            {
              key: "a",
              action: async () => {
                await held.promise;
                return answer!();
              },
              ...(landed === undefined ? {} : { landed }),
            },
          ]}
        />
      </LoggedViaSurface>
    );

    await act(async () => {
      screen.getByTestId("tap-a").click();
    });
    // The tap is acknowledged in the same frame — no ending is bought by making the
    // person wait for the round trip.
    expect(shown()).toBe(6);

    await act(async () => {
      held.open();
      await waitFor(() => expect(answered).toHaveLength(1));
    });
    expect(answered[0]).toBe(result);
    expect(shown()).toBe(after);
  });

  // THE ENDING NO ADOPTER COULD REACH ALONE, and the reason this channel is not just
  // three lines moved. Seven buttons write one count, so a refusal's "pre-tap value" is
  // a snapshot a sibling tap may already have settled over. Restoring it erases a
  // reading that landed.
  it("restores what the server last took, not the snapshot a later write replaced", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    const first = gate();
    const second = gate();
    const answered: string[] = [];
    render(
      <LoggedViaSurface value="quick-log">
        <Counter
          start={0}
          onResult={(key, result) => answered.push(`${key}:${result}`)}
          taps={[
            {
              key: "a",
              action: async () => {
                await first.promise;
                return { ok: false, error: "That reading was refused." };
              },
            },
            {
              key: "b",
              action: async () => {
                await second.promise;
                return { ok: true };
              },
              landed: 1,
            },
          ]}
        />
      </LoggedViaSurface>
    );

    await act(async () => {
      screen.getByTestId("tap-a").click();
    });
    expect(shown()).toBe(1);
    await act(async () => {
      screen.getByTestId("tap-b").click();
    });
    expect(shown()).toBe(2);

    // b answers first, and the server says the day holds ONE reading — a's is not in it.
    await act(async () => {
      second.open();
      await waitFor(() => expect(answered).toEqual(["b:wrote"]));
    });
    expect(shown()).toBe(1);

    // a is then refused. Its own pre-tap snapshot was 0; putting that back would drop
    // the reading b just landed.
    await act(async () => {
      first.open();
      await waitFor(() => expect(answered).toHaveLength(2));
    });
    expect(answered[1]).toBe("a:nothing");
    expect(shown()).toBe(1);
  });
});

// ── THE COMPILE-TIME HALF ────────────────────────────────────────────────────
//
// Never called. Each `@ts-expect-error` fails `npm run typecheck` the moment the shape
// it describes becomes expressible — which is the whole claim this issue makes, and the
// only tier that can make it. Removing a suppression prints the refusal it stands for.
export function useTypeCheckedGuards() {
  const covered = useWritePipeline("dose-status");
  const excluded = useWritePipeline("dose-day-stack");
  const post = async () => ({ ok: true }) as const;

  // CLASS 2, the enrollment gate. `dose-status` maps to the "dose" flow in
  // OFFLINE_QUEUE_COVERAGE, so the offline half is not optional: a surface cannot ship
  // online-only by simply not writing the branch.
  // @ts-expect-error - `offline` is required for an affordance the census covers
  void covered.run({
    fields: {},
    action: post,
    settle: () => ({ wrote: true, announce: "silent" }),
    failureMessage: "…",
  });

  // …and the converse, which is what keeps the gate from being a blanket demand:
  // `dose-day-stack` is an ARGUED EXCLUSION, so declaring a capture for it is refused.
  void excluded.run({
    fields: {},
    action: post,
    settle: () => ({ wrote: true, announce: "silent" }),
    failureMessage: "…",
    // @ts-expect-error - the census argues this affordance out; it has no offline half
    offline: () => ({ kind: "attempt" }),
  });

  // CLASS 3. An announcement without `undo` is not a quiet default — it does not exist.
  void covered.run({
    fields: {},
    action: post,
    // @ts-expect-error - `undo` must be declared, even to decline it with null
    settle: () => ({ wrote: true, announce: { message: "Dose logged" } }),
    failureMessage: "…",
    offline: () => ({ kind: "attempt" }),
  });
}
