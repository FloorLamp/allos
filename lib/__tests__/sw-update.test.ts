import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deployDetectorFor,
  isDeploymentSkewError,
  isStaleActionError,
  nextSkewGuard,
  parseSkewGuard,
  SKEW_RECOVERY_MAX_ATTEMPTS,
  SKEW_RECOVERY_WINDOW_MS,
  skewRecoveryPlan,
  UPDATE_PENDING_MARKER,
  updatePendingFromMarker,
  reloadPlanFor,
  resolveUpdateState,
  SW_SKIP_WAITING,
  shouldOfferUpdate,
  shouldReloadOnControllerChange,
  waitingWorkerPlan,
} from "@/lib/sw-update";

// The deferred service-worker update (issue #1700) and the ONE update-pending state
// it grew into (issue #1795). The decisions are pure; the end-to-end drives are
// e2e/sw-update.spec.ts (a second worker version registered against an open page)
// and e2e/update-notice.spec.ts (the no-worker fallback detector).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SW = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");

describe("shouldOfferUpdate", () => {
  it("offers a waiting worker to a page that is already controlled", () => {
    expect(shouldOfferUpdate({ waiting: true, controlled: true })).toBe(true);
  });

  it("stays silent on a first install — nothing is being replaced", () => {
    expect(shouldOfferUpdate({ waiting: true, controlled: false })).toBe(false);
  });

  it("stays silent with no waiting worker", () => {
    expect(shouldOfferUpdate({ waiting: false, controlled: true })).toBe(false);
  });
});

describe("shouldReloadOnControllerChange", () => {
  it("reloads the tab that asked", () => {
    expect(
      shouldReloadOnControllerChange({
        requestedByThisTab: true,
        alreadyReloaded: false,
      })
    ).toBe(true);
  });

  it("never reloads a tab that did NOT ask — the mid-form tab next door", () => {
    // Activation is registration-wide: every open tab gets controllerchange when
    // one of them taps Reload. This is the guard that keeps the others alive.
    expect(
      shouldReloadOnControllerChange({
        requestedByThisTab: false,
        alreadyReloaded: false,
      })
    ).toBe(false);
  });

  it("reloads at most once per activation (the loop guard)", () => {
    expect(
      shouldReloadOnControllerChange({
        requestedByThisTab: true,
        alreadyReloaded: true,
      })
    ).toBe(false);
  });
});

describe("one detector per context (#1795)", () => {
  it("lets the worker answer wherever there is one", () => {
    expect(deployDetectorFor("active")).toBe("service-worker");
  });

  it("falls back to the sha poll where no worker exists", () => {
    // Private mode, an unsupported browser, a failed registration, development.
    expect(deployDetectorFor("unavailable")).toBe("version-poll");
  });

  it("asks nothing while registration hasn't answered", () => {
    // A poll started in that window would race the worker for the same deploy —
    // which is how one deploy came to raise two notices in the first place.
    expect(deployDetectorFor("probing")).toBe("none");
  });
});

describe("resolveUpdateState (#1795)", () => {
  const OLD = "aaaaaaa";
  const NEW = "bbbbbbb";

  it("is pending on a waiting worker", () => {
    expect(
      resolveUpdateState({
        swWaiting: true,
        baselineSha: OLD,
        deployedSha: null,
        deployedMessage: null,
      })
    ).toEqual({ pending: true, commitMessage: null });
  });

  it("is pending on a sha mismatch with no worker, and names the build", () => {
    expect(
      resolveUpdateState({
        swWaiting: false,
        baselineSha: OLD,
        deployedSha: NEW,
        deployedMessage: "Ship the thing",
      })
    ).toEqual({ pending: true, commitMessage: "Ship the thing" });
  });

  it("is ONE pending state when both detectors fire — one deploy, one notice", () => {
    // The defect: a deploy mints a new COMMIT_SHA *and* a new sw.js?v=<sha>, so both
    // detectors trip. Two surfaces used to answer that; there is one answer now.
    const both = resolveUpdateState({
      swWaiting: true,
      baselineSha: OLD,
      deployedSha: NEW,
      deployedMessage: "Ship the thing",
    });
    expect(both).toEqual({ pending: true, commitMessage: "Ship the thing" });
  });

  it("is not pending when neither detector has anything", () => {
    expect(
      resolveUpdateState({
        swWaiting: false,
        baselineSha: OLD,
        deployedSha: OLD,
        deployedMessage: "The build you are on",
      })
    ).toEqual({ pending: false, commitMessage: null });
  });

  it("never names the build the user is already running", () => {
    // A waiting worker carries no commit metadata, so the message can only come from
    // the server — and if the server reports the sha this page was served with, that
    // message describes THIS build, not the update.
    expect(
      resolveUpdateState({
        swWaiting: true,
        baselineSha: OLD,
        deployedSha: OLD,
        deployedMessage: "The build you are on",
      })
    ).toEqual({ pending: true, commitMessage: null });
  });

  it("cannot detect a deploy with no baseline to compare against", () => {
    expect(
      resolveUpdateState({
        swWaiting: false,
        baselineSha: null,
        deployedSha: NEW,
        deployedMessage: "Ship the thing",
      })
    ).toEqual({ pending: false, commitMessage: null });
  });
});

describe("waitingWorkerPlan — a refresh consumes the update (#1905)", () => {
  const SERVED = "abc1234";
  const OLDER = "0000fff";
  const settled = { deployedSettled: true };

  it("takes the waiting worker SILENTLY when the page is already on that build", () => {
    // The loop: a refresh fetches the new build's HTML and assets but never
    // activates a waiting worker — and the worker the fresh load discovers through
    // its own register() call is not even waiting yet, so it lands seconds after
    // the "waiting at load" moment the first cut of this fix keyed on, and was
    // offered as an "update" to the build the page was already running. Equal shas
    // say the worker is queued behind nothing, whenever it arrived — take it, say
    // nothing. There is no arrival-time input left to get that wrong with.
    expect(
      waitingWorkerPlan({
        pageSha: SERVED,
        deployedSha: SERVED,
        ...settled,
      })
    ).toBe("activate-silently");
  });

  it("still offers when the shas differ — this document predates the deploy", () => {
    // A deploy genuinely discovered mid-session, or a document served from the
    // worker's own shell cache: the page is on an older build and the user
    // genuinely has a choice to make. This is the bar's whole charter (#1700), and
    // it is also why the fallback path never loops — its baseline is the
    // freshly-served sha, so a refresh self-clears the mismatch.
    expect(
      waitingWorkerPlan({
        pageSha: OLDER,
        deployedSha: SERVED,
        ...settled,
      })
    ).toBe("offer");
  });

  it("holds the bar until the one sha read settles, instead of flashing it", () => {
    expect(
      waitingWorkerPlan({
        pageSha: SERVED,
        deployedSha: null,
        deployedSettled: false,
      })
    ).toBe("wait");
  });

  it("offers when the read settles knowing nothing — no silence we cannot justify", () => {
    // /api/version is session-gated, so an anonymous tab settles with no answer. That
    // is the shipped behaviour, not a case to invent new silence for.
    expect(
      waitingWorkerPlan({
        pageSha: SERVED,
        deployedSha: null,
        ...settled,
      })
    ).toBe("offer");
  });

  it("offers with no baseline sha to compare against, without waiting", () => {
    // The page cannot claim to be on the new build, and there is no read worth
    // holding the bar for.
    for (const deployedSettled of [true, false]) {
      expect(
        waitingWorkerPlan({
          pageSha: null,
          deployedSha: SERVED,
          deployedSettled,
        })
      ).toBe("offer");
    }
  });
});

describe("reloadPlanFor (#1795)", () => {
  it("resolves the handshake whenever a worker is waiting", () => {
    // The bug this closes: the retired banner's plain reload left the worker waiting,
    // so the bar re-offered the update the user had just taken.
    expect(reloadPlanFor({ waitingWorker: true })).toBe("handshake");
  });

  it("plainly reloads when there is nothing to hand over to", () => {
    expect(reloadPlanFor({ waitingWorker: false })).toBe("plain");
  });
});

describe("the worker's activation posture (#1700)", () => {
  it("does not skip waiting on an update — only on a first install", () => {
    // Every skipWaiting() in the worker must be guarded: the dev branch (which the
    // registrar unregisters anyway), the first install, or the page's explicit
    // message. An unguarded one in install() is the defect this issue is about.
    expect(SW).toContain("if (firstInstall) await self.skipWaiting();");
    expect(SW).not.toMatch(/^\s*await self\.skipWaiting\(\);\s*$/m);
  });

  it("claims open clients only on a first install", () => {
    expect(SW).toContain(
      "if (IS_DEV || firstInstall) await self.clients.claim();"
    );
  });

  it("activates on the page's message, and on the same message name", () => {
    expect(SW).toContain(`const SKIP_WAITING_MESSAGE = "${SW_SKIP_WAITING}"`);
    expect(SW).toContain('self.addEventListener("message"');
  });

  it("retains the previous generation's cache instead of dropping it", () => {
    expect(SW).toContain("readRetained()");
    expect(SW).toContain("const keep = new Set([CACHE, ...retained]);");
  });

  it("opens the offline queue database without pinning a version", () => {
    // The page owns that schema (lib/offline/idb.ts). A worker naming a lower
    // version fails the open outright instead of replaying the queue.
    expect(SW).toContain("indexedDB.open(OFFLINE_DB)");
  });
});

describe("isDeploymentSkewError — the stale-build signature (#1906)", () => {
  it("recognises webpack's ChunkLoadError by name", () => {
    expect(
      isDeploymentSkewError({
        name: "ChunkLoadError",
        message: "Loading chunk 4821 failed.",
      })
    ).toBe(true);
  });

  it("recognises a failed dynamic import, however the engine words it", () => {
    // Chrome, Firefox and Safari each phrase this differently and all three mean
    // the same thing: the module the deploy deleted.
    for (const message of [
      "Failed to fetch dynamically imported module: https://example.test/_next/static/chunks/page-abc.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /_next/static/css/abc.css",
    ]) {
      expect(isDeploymentSkewError({ name: "TypeError", message })).toBe(true);
    }
  });

  it("recognises a failed RSC payload fetch", () => {
    expect(
      isDeploymentSkewError({
        name: "Error",
        message: "Failed to fetch RSC payload for https://example.test/trends",
      })
    ).toBe(true);
  });

  it("does NOT claim an ordinary network failure", () => {
    // The narrowness is the point: treating "Failed to fetch" as skew would reload
    // the document out from under someone whose connection merely dropped.
    expect(
      isDeploymentSkewError({ name: "TypeError", message: "Failed to fetch" })
    ).toBe(false);
  });

  it("does NOT claim an ordinary application crash", () => {
    expect(
      isDeploymentSkewError({
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'profileId')",
      })
    ).toBe(false);
  });

  it("survives an error with nothing on it", () => {
    expect(isDeploymentSkewError(null)).toBe(false);
    expect(isDeploymentSkewError(undefined)).toBe(false);
    expect(isDeploymentSkewError({})).toBe(false);
  });
});

describe("isStaleActionError — the stale Server Action signature", () => {
  it("recognises the client-thrown unrecognized-action error, by name and by slug", () => {
    // What Next's action reducer throws when the server answers with its
    // action-not-found marker — the exact shape a post-deploy save produces.
    const err = Object.assign(
      new Error(
        'Server Action "7f9a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action'
      ),
      { name: "UnrecognizedActionError" }
    );
    expect(isStaleActionError(err)).toBe(true);
    // Each half is sufficient on its own: the name alone…
    expect(
      isStaleActionError({ name: "UnrecognizedActionError", message: "" })
    ).toBe(true);
    // …and the docs slug alone (the name can be mangled by minification).
    expect(
      isStaleActionError(
        new Error(
          "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action"
        )
      )
    ).toBe(true);
  });

  it("recognises the server-thrown variant, in either wording", () => {
    expect(
      isStaleActionError(
        new Error(
          'Failed to find Server Action "7f9a". This request might be from an older or newer deployment.'
        )
      )
    ).toBe(true);
  });

  it("does NOT claim a dropped connection — that is the offline path's signal", () => {
    expect(isStaleActionError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("does NOT claim an ordinary server error or refusal", () => {
    expect(
      isStaleActionError(
        new Error("An error occurred in the Server Components render.")
      )
    ).toBe(false);
    expect(isStaleActionError(new Error("validation failed"))).toBe(false);
  });

  it("survives nothing at all, and non-object throwables", () => {
    expect(isStaleActionError(null)).toBe(false);
    expect(isStaleActionError(undefined)).toBe(false);
    expect(isStaleActionError({})).toBe(false);
    expect(isStaleActionError("Failed to find Server Action")).toBe(false);
  });
});

describe("the skew loop guard (#1906)", () => {
  const T0 = 1_700_000_000_000;

  it("reads nothing out of an absent or unparseable marker", () => {
    expect(parseSkewGuard(null)).toBeNull();
    expect(parseSkewGuard("")).toBeNull();
    expect(parseSkewGuard("not json")).toBeNull();
    expect(parseSkewGuard('{"attempts":"one","at":1}')).toBeNull();
    expect(parseSkewGuard('{"attempts":1}')).toBeNull();
    expect(parseSkewGuard("[1,2]")).toBeNull();
  });

  it("round-trips the guard it writes", () => {
    const written = nextSkewGuard(null, T0);
    expect(written).toEqual({ attempts: 1, at: T0 });
    expect(parseSkewGuard(JSON.stringify(written))).toEqual(written);
  });

  it("counts within one window, keeping the window's OPENING timestamp", () => {
    // Anchoring on the first attempt is what makes the window a cap rather than a
    // sliding leash a fast loop could drag along with it.
    const first = nextSkewGuard(null, T0);
    const second = nextSkewGuard(first, T0 + 500);
    expect(second).toEqual({ attempts: 2, at: T0 });
  });

  it("opens a fresh window once the old one has aged out", () => {
    const first = nextSkewGuard(null, T0);
    const later = T0 + SKEW_RECOVERY_WINDOW_MS + 1;
    expect(nextSkewGuard(first, later)).toEqual({ attempts: 1, at: later });
  });

  it("ignores a guard written in the future (a clock that moved backwards)", () => {
    const future = { attempts: 5, at: T0 + 10_000 };
    expect(nextSkewGuard(future, T0)).toEqual({ attempts: 1, at: T0 });
  });
});

describe("skewRecoveryPlan (#1906)", () => {
  const T0 = 1_700_000_000_000;
  const CHUNK = { name: "ChunkLoadError", message: "Loading chunk 12 failed." };

  it("recovers the FIRST skew: hard reload onto the new build", () => {
    expect(
      skewRecoveryPlan({
        error: CHUNK,
        updatePending: true,
        guard: null,
        now: T0,
      })
    ).toBe("hard-reload");
  });

  it("renders the card on the SECOND skew — the guard cannot spin", () => {
    // A hard reload that fails the same way is an infinite redirect the user never
    // sees. One attempt, then the card, which at least says something.
    const afterFirst = nextSkewGuard(null, T0);
    expect(
      skewRecoveryPlan({
        error: CHUNK,
        updatePending: true,
        guard: afterFirst,
        now: T0 + 900,
      })
    ).toBe("render-card");
  });

  it("recovers again once the window has passed — a later deploy is a new episode", () => {
    const afterFirst = nextSkewGuard(null, T0);
    expect(
      skewRecoveryPlan({
        error: CHUNK,
        updatePending: true,
        guard: afterFirst,
        now: T0 + SKEW_RECOVERY_WINDOW_MS + 1,
      })
    ).toBe("hard-reload");
  });

  it("renders the card when no update is pending — this is a real crash", () => {
    expect(
      skewRecoveryPlan({
        error: CHUNK,
        updatePending: false,
        guard: null,
        now: T0,
      })
    ).toBe("render-card");
  });

  it("renders the card for an error that is not skew, pending update or not", () => {
    expect(
      skewRecoveryPlan({
        error: { name: "TypeError", message: "x is not a function" },
        updatePending: true,
        guard: null,
        now: T0,
      })
    ).toBe("render-card");
  });

  it("never reloads more than SKEW_RECOVERY_MAX_ATTEMPTS times in a window", () => {
    let guard = null as ReturnType<typeof parseSkewGuard>;
    let reloads = 0;
    // Simulate a deploy that stays broken: every pass throws the same chunk error.
    for (let i = 0; i < 25; i += 1) {
      const now = T0 + i * 100;
      if (
        skewRecoveryPlan({
          error: CHUNK,
          updatePending: true,
          guard,
          now,
        }) === "hard-reload"
      ) {
        reloads += 1;
        guard = nextSkewGuard(guard, now);
      }
    }
    expect(reloads).toBe(SKEW_RECOVERY_MAX_ATTEMPTS);
  });
});

describe("the update-pending marker (#1906)", () => {
  it("is only pending on the marker the registrar writes", () => {
    // The registrar and the error boundary live on opposite sides of a crash, so the
    // marker's shape is the whole contract between them.
    expect(updatePendingFromMarker(UPDATE_PENDING_MARKER)).toBe(true);
    expect(updatePendingFromMarker(null)).toBe(false);
    expect(updatePendingFromMarker("")).toBe(false);
    expect(updatePendingFromMarker("0")).toBe(false);
    expect(updatePendingFromMarker("true")).toBe(false);
  });
});
