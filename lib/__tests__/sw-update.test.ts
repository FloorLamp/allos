import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SW_SKIP_WAITING,
  shouldOfferUpdate,
  shouldReloadOnControllerChange,
} from "@/lib/sw-update";

// The deferred service-worker update (issue #1700). The decisions are pure; the
// end-to-end drive (a second worker version registered against an open page) is
// e2e/sw-update.spec.ts.

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
