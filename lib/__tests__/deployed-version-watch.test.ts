import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_MS, waitingWorkerPlan } from "@/lib/sw-update";

// THE SIGNAL, not the decision (issue #2329).
//
// Every pure test in sw-update.test.ts takes `swWaiting` / `deployedSha` as an INPUT
// and verifies the decision made from it. That is why nothing caught the bar being
// dead in production for a week: the decisions were all correct, and no test asked
// how either signal is ever PRODUCED. `swWaiting` could not be produced at all in an
// open tab (public/sw.js reads its version from its own URL, so a deploy changes none
// of its bytes and `registration.update()` installs nothing), and the sha read was
// switched off in precisely the context where a worker existed. So both inputs were
// permanently false and the whole decision layer never ran.
//
// This file covers the production of the one signal that CAN notice a deploy under an
// already-open tab: the /api/version read. Two halves —
//
//   1. the hook itself, executed against a minimal hook runtime (below), so "the
//      first read happens on mount" and "it keeps polling" are behaviours rather
//      than comments;
//   2. a source scan of the registrar, because whether the hook is switched on is a
//      call-site fact — the exact fact #1795 got wrong — that no amount of testing
//      the hook in isolation can see.
//
// The end-to-end drive, in production's actual shape (a controlled tab, a server that
// moves ahead, and no second worker registered by hand), is e2e/sw-update.spec.ts.

// ── A minimal hook runtime ───────────────────────────────────────────────────
// The pure tier is node-only by design (no jsdom, no renderer), and this hook is one
// `useEffect` over three primitives. So `react` is mocked with an order-indexed
// implementation of exactly those three: cells for useState/useRef, a dependency
// comparison and a cleanup slot for useEffect, and a re-render on setState. It runs
// the REAL hook source — nothing about its behaviour is restated here.
const hooks = vi.hoisted(() => {
  type Cell = { value: unknown };
  let cells: Cell[] = [];
  let cellIndex = 0;
  let effectIndex = 0;
  let effectDeps: (readonly unknown[] | undefined)[] = [];
  let cleanups: (void | (() => void))[] = [];
  let queued: { slot: number; run: () => void | (() => void) }[] = [];
  let render: (() => void) | null = null;
  let rendering = false;
  let dirty = false;

  function useState<T>(initial: T | (() => T)) {
    const slot = cellIndex++;
    if (cells[slot] === undefined) {
      cells[slot] = {
        value: typeof initial === "function" ? (initial as () => T)() : initial,
      };
    }
    const cell = cells[slot];
    const set = (next: T | ((prev: T) => T)) => {
      const value =
        typeof next === "function"
          ? (next as (prev: T) => T)(cell.value as T)
          : next;
      if (Object.is(value, cell.value)) return;
      cell.value = value;
      if (rendering) dirty = true;
      else render?.();
    };
    return [cell.value as T, set] as const;
  }

  function useRef<T>(initial: T) {
    const slot = cellIndex++;
    if (cells[slot] === undefined)
      cells[slot] = { value: { current: initial } };
    return cells[slot].value as { current: T };
  }

  function useEffect(
    run: () => void | (() => void),
    deps?: readonly unknown[]
  ) {
    const slot = effectIndex++;
    const previous = effectDeps[slot];
    const changed =
      !previous ||
      !deps ||
      deps.length !== previous.length ||
      deps.some((dep, i) => !Object.is(dep, previous[i]));
    if (!changed) return;
    effectDeps[slot] = deps;
    queued.push({ slot, run });
  }

  /**
   * Mount a hook and keep re-rendering it until its state stops changing.
   *
   * `rerender` re-runs the same hook with the SAME cells, which is how a prop change
   * is expressed here: the thunk closes over a mutable holder, so a changed dependency
   * tears the effect down and starts a new run against refs that outlive both (#2447).
   */
  function mount<T>(hook: () => T): { current: () => T; rerender: () => void } {
    reset();
    let latest: T;
    render = () => {
      rendering = true;
      do {
        dirty = false;
        cellIndex = 0;
        effectIndex = 0;
        latest = hook();
        const pending = queued;
        queued = [];
        for (const effect of pending) {
          const cleanup = cleanups[effect.slot];
          if (typeof cleanup === "function") cleanup();
          cleanups[effect.slot] = effect.run();
        }
      } while (dirty);
      rendering = false;
    };
    render();
    return { current: () => latest, rerender: () => render?.() };
  }

  function reset() {
    cells = [];
    cellIndex = 0;
    effectIndex = 0;
    effectDeps = [];
    for (const cleanup of cleanups)
      if (typeof cleanup === "function") cleanup();
    cleanups = [];
    queued = [];
    render = null;
    rendering = false;
    dirty = false;
  }

  return { useState, useRef, useEffect, mount, reset };
});

vi.mock("react", () => ({
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
}));

import {
  useDeployedVersion,
  type VersionWatchMode,
} from "@/components/useDeployedVersion";

const PAGE_SHA = "aaaaaaa";
const DEPLOYED_SHA = "bbbbbbb";

type VersionReply =
  | { status: 200; sha: string | null; commitMessage: string | null }
  | { status: 401 };

let reply: VersionReply;
let fetchCalls: number;

function stubVersionEndpoint() {
  fetchCalls = 0;
  return vi.fn(async () => {
    fetchCalls += 1;
    const answer = reply;
    if (answer.status === 401) {
      return { ok: false, status: 401 } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sha: answer.sha,
        commitMessage: answer.commitMessage,
      }),
    } as unknown as Response;
  });
}

/** Let the in-flight fetch and its `.json()` settle without advancing the clock. */
async function settleReads() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  reply = { status: 200, sha: PAGE_SHA, commitMessage: "The running build" };
  vi.stubGlobal("fetch", stubVersionEndpoint());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useDeployedVersion (#2329)", () => {
  it("asks the server on MOUNT, before any interval has elapsed", async () => {
    // The read `waitingWorkerPlan` blocks on. Deferring it by one tick — which is
    // what the retired "once" mode existed to avoid — leaves a fresh load after a
    // deploy sitting on `plan === "wait"`, bar suppressed, for a full interval.
    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );

    expect(fetchCalls).toBe(1);

    await settleReads();
    expect(watch.current()).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });
  });

  it("keeps polling while the server reports the build this page is on", async () => {
    // THE CASE THAT RETURNED NOTHING BEFORE. With a service worker active the mode
    // was "off", so this hook did not ask once — and the worker it deferred to could
    // not notice a deploy under an open tab. The poll is the detector now, so it has
    // to keep asking after a read that found no mismatch.
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(fetchCalls).toBe(1);
    // SETTLED, and still asking. Those are two different questions (#2329): the read
    // has an answer — which is what `waitingWorkerPlan` blocks on, so reporting it
    // unsettled would suppress the bar and defer #1905's silent activation forever —
    // while the answer can still change, so the poll keeps going.
    expect(watch.current()).toEqual({
      sha: PAGE_SHA,
      commitMessage: "The running build",
      settled: true,
    });

    // A deploy lands under the open tab: nothing about this document changes, and
    // the next tick is the only thing that can notice.
    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(fetchCalls).toBe(2);
    expect(watch.current()).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });

    // Settled means settled: the answer can no longer change, so the asking stops.
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 3);
    expect(fetchCalls).toBe(2);
  });

  it("reports a failed read as answered, and asks again anyway", async () => {
    // The trap the retired "once" mode hid: it settled on EVERY outcome because
    // #1905's plan blocks on the read, and a poll that only settled on a mismatch
    // would hold `plan === "wait"` — bar suppressed, waiting worker never consumed —
    // for as long as the server stayed unreachable. Answering in the dark is safe
    // precisely because the poll corrects it on the next tick.
    reply = { status: 200, sha: null, commitMessage: null };
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(watch.current()).toEqual({
      sha: null,
      commitMessage: null,
      settled: true,
    });

    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(watch.current().sha).toBe(DEPLOYED_SHA);
  });

  it("hands the matching read STRAIGHT to #1905's plan, rather than holding it at wait", async () => {
    // The signal joined to the decision it unblocks — the join no test in either file
    // made, and the one that catches the trap above by its CONSEQUENCE rather than by
    // its flag. This is the commonest shape in production: a fresh load AFTER a
    // deploy, already on the new build, whose own register() call discovers the new
    // worker seconds later. The read matches, so if a still-polling hook reported
    // itself unsettled the plan would be `wait` forever — the bar is suppressed
    // (correctly, there is nothing to offer) but the waiting worker is never consumed
    // either, and it sits behind a page that already IS the build it carries.
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();

    expect(
      waitingWorkerPlan({
        pageSha: PAGE_SHA,
        deployedSha: watch.current().sha,
        deployedSettled: watch.current().settled,
      })
    ).toBe("activate-silently");
  });

  it("asks nothing with no baseline to compare against", async () => {
    hooks.mount(() =>
      useDeployedVersion({ baseline: null, mode: "off", generation: 0 })
    );
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 2);
    expect(fetchCalls).toBe(0);
  });

  it("settles knowing nothing when the endpoint is session-gated (#390)", async () => {
    // An anonymous tab can never learn the deployed sha, and a read that never
    // settles would hold the #1905 load-time decision — and with it the bar — open
    // forever. Settling with `sha: null` is the honest outcome, not a failure.
    reply = { status: 401 };
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(watch.current()).toEqual({
      sha: null,
      commitMessage: null,
      settled: true,
    });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 2);
    expect(fetchCalls).toBe(1);
  });

  it("re-arms on a generation bump, and the re-read is immediate too (#1905)", async () => {
    // A second deploy under the same open page must not be judged against the answer
    // read for the first. The bump un-settles the read — and since the first read is
    // on mount, the re-read is immediate as well, so the newly-waiting worker is not
    // held at `wait` for an interval either.
    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    let generation = 0;
    const watch = hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation })
    );
    await settleReads();
    expect(watch.current().settled).toBe(true);
    expect(fetchCalls).toBe(1);

    generation = 1;
    reply = { status: 200, sha: "ccccccc", commitMessage: "Ship it again" };
    hooks.mount(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation })
    );
    expect(fetchCalls).toBe(2);
  });

  it("ignores a 401 that lands after its own read was torn down (#2447)", async () => {
    // `finalRef` is the poll's off switch and it OUTLIVES a single effect run — only a
    // generation bump resets it. So the 401 branch, which is the one thing that latches
    // it, must ask the same "am I still the live read" question the sha comparison
    // beside it always asked. It did not: it fired the moment the fetch resolved.
    //
    // The shape below is the one that reaches production: the effect re-runs without a
    // generation bump (a baseline that resolves late), so read #1 is cancelled while
    // still in flight and read #2 takes over against the same refs. Read #1 then comes
    // back 401 — a session that expired, or a request that raced a redirect. Guarding
    // only `cancelled` would not be enough either; it is the shared ref that carries the
    // damage from the dead read into the live one.
    const deferred: { resolve: (r: Response) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deferred.push({ resolve });
          })
      )
    );
    const props = { baseline: "0000000" };
    const watch = hooks.mount(() =>
      useDeployedVersion({
        baseline: props.baseline,
        mode: "poll",
        generation: 0,
      })
    );
    expect(deferred).toHaveLength(1);

    // The baseline changes, so this effect run is torn down and a fresh one takes over.
    props.baseline = PAGE_SHA;
    watch.rerender();
    expect(deferred).toHaveLength(2);

    // The dead read answers first, with the one status that stops the poll for good.
    deferred[0].resolve({ ok: false, status: 401 } as unknown as Response);
    await settleReads();

    // The live read finds a genuine deploy, and must still be able to report it.
    deferred[1].resolve({
      ok: true,
      status: 200,
      json: async () => ({
        sha: DEPLOYED_SHA,
        commitMessage: "Ship the thing",
      }),
    } as unknown as Response);
    await settleReads();

    expect(watch.current()).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });
  });

  it("has no 'once' mode left — the mount read is what it was for", () => {
    // @ts-expect-error "once" collapsed into "poll" (#2329): a poll that finds a
    // mismatch already learns what shipped, and its first read is now immediate.
    const retired: VersionWatchMode = "once";
    expect(retired).toBe("once");
  });
});

// ── The call site ────────────────────────────────────────────────────────────

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REGISTRAR = fs.readFileSync(
  path.join(REPO, "components/ServiceWorkerRegister.tsx"),
  "utf8"
);
/** The registrar's CODE — line comments dropped, so prose about a retired call
 *  (this file's own subject) is never mistaken for the call itself. */
const REGISTRAR_CODE = REGISTRAR.split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("the registrar switches the detector on (#2329)", () => {
  it("chooses the version-watch mode from the BASELINE alone", () => {
    // The one-line defect. #1795 wrote this as `swWaiting ? "once" : detectorFor(
    // swStatus) === "version-poll" ? "poll" : "off"`, so a tab with a healthy worker
    // asked the server nothing — while the worker it deferred to had no way to
    // notice a deploy under an open document. Whether a worker exists is not an
    // input to "should we ask what the server is running"; only having something to
    // compare the answer against is.
    const declaration = /const mode: VersionWatchMode =([^;]*);/.exec(
      REGISTRAR_CODE
    );
    expect(
      declaration,
      "the registrar declares one version-watch mode"
    ).not.toBe(null);
    const expression = declaration![1];
    for (const forbidden of ["swWaiting", "swStatus", "deployDetector"]) {
      expect(expression).not.toContain(forbidden);
    }
    expect(expression).toContain("sha");
  });

  it("runs no registration.update() tick", () => {
    // It refetched /sw.js?v=<the sha THIS document registered> once a minute per tab
    // forever, and the worker's bytes are identical across deploys, so it could
    // never install anything. A worker installed by another tab still arrives here
    // through `updatefound`, which is scope-wide and needs no tick.
    expect(REGISTRAR_CODE).not.toContain(".update()");
    expect(REGISTRAR_CODE).toContain("updatefound");
  });
});
