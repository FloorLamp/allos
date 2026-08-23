import { describe, expect, it, vi } from "vitest";

// SITE DATA BLOCKED MUST NOT SILENTLY CANCEL A LOGOUT (#3605).
//
// Chrome throws `SecurityError` from the `window.localStorage` PROPERTY GETTER when a
// site's data is blocked — before any method is reached. `hasStorage()` read that
// property outside any `try`, so the throw came from the predicate that exists to
// prevent exactly this, and every guard one level down was guarding the wrong
// statement (`clearEmergencyPayload` already wraps its own `removeItem`).
//
// WHY THE LOGOUT PATH IS THE ONE MEASURED HERE, and not just "clear() does not throw":
// `wipeDeviceForSignOut` calls `clearEmergencyPayload` OUTSIDE its own try
// (components/device-wipe.ts), so the throw rejected the wipe, which rejected
// `logoutAfterWipe`, which is invoked as `void logoutAfterWipe()`. Unhandled rejection,
// a tap that did nothing, and nothing said — the same silence as the unmount defect,
// reached by a different door.

vi.mock("@/lib/offline/queue-db", () => ({
  clearQueue: vi.fn(async () => {}),
}));
vi.mock("@/lib/offline/write-gate", () => ({
  reopenForFailedLogout: vi.fn(async () => {}),
}));

import {
  clearEmergencyPayload,
  readEmergencyPayloadRaw,
  writeEmergencyPayload,
} from "../emergency-offline";
import { wipeDeviceForSignOut } from "../device-wipe";

/** Run `body` with `window.localStorage` throwing the way a blocked browser does. */
async function withBlockedSiteData(body: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException(
        "Access is denied for this document.",
        "SecurityError"
      );
    },
  });
  try {
    await body();
  } finally {
    // Restored here rather than in an afterEach: the tier's own cleanup calls
    // `localStorage.clear()`, which a throwing getter would take down with it.
    if (real) Object.defineProperty(window, "localStorage", real);
    else Reflect.deleteProperty(window, "localStorage");
  }
}

describe("blocked site data (#3605)", () => {
  it("does not stop the logout wipe", async () => {
    await withBlockedSiteData(async () => {
      // Without the try inside `hasStorage()` this REJECTS with SecurityError, and the
      // caller that rejects with it is `void logoutAfterWipe()`.
      await expect(wipeDeviceForSignOut()).resolves.toBeUndefined();
    });
  });

  it("leaves every emergency-card accessor answering instead of throwing", async () => {
    await withBlockedSiteData(async () => {
      expect(() => clearEmergencyPayload()).not.toThrow();
      expect(() =>
        writeEmergencyPayload(1, {
          name: "Sam",
          age: null,
          sex: null,
          birthdate: null,
          bloodType: null,
          allergies: [],
          medications: [],
          conditions: [],
          contact: null,
          generatedAt: "2026-08-23T00:00:00.000Z",
        })
      ).not.toThrow();
      expect(readEmergencyPayloadRaw()).toBeNull();
    });
  });
});
