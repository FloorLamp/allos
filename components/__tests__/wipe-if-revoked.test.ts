import { describe, expect, it, vi, beforeEach } from "vitest";

// THE DEVICE'S SIDE OF "THE SERVER SAYS REVOKED" (#3053).
//
// One decision, and it is the one #2994's pass-4 ruling constrains: a 401 wipes this
// device's whole PHI perimeter when — and only when — the server named the session
// REVOKED. Everything else is the keep-it case, including the answers that mean "I could
// not tell": an unparseable body, a 401 from something that is not this route, an older
// server still saying "auth".
//
// The table is the point. A wipe that fires one row too wide destroys the offline record
// of someone whose cookie merely lapsed, which is the case the whole feature exists for;
// a wipe that fires one row too narrow leaves the health record on a phone somebody
// revoked on suspicion of compromise. Both failures are silent on the device.

vi.mock("@/lib/offline/queue-db", () => ({
  clearQueue: vi.fn(async () => {}),
}));
vi.mock("@/lib/offline/write-gate", () => ({
  reopenForFailedLogout: vi.fn(async () => {}),
}));

import { clearQueue } from "@/lib/offline/queue-db";
import {
  recallLastGood,
  rememberLastGood,
} from "@/lib/offline/quick-entry-read";
import { wipeIfRevoked } from "../device-wipe";

// `clearQueue` is the wipe's own single transaction — it clears every store AND closes
// the device write gate — so counting its calls is counting wipes.
const wipes = vi.mocked(clearQueue);

function answer(status: number, body: unknown): Response {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not JSON");
      return body;
    },
  } as unknown as Response;
}

beforeEach(() => wipes.mockClear());

describe("wipeIfRevoked (#3053)", () => {
  it.each([
    ["the server named it revoked", 401, { ok: false, error: "revoked" }, true],
    [
      "an ordinary lapsed cookie",
      401,
      { ok: false, error: "unauthorized" },
      false,
    ],
    [
      "an older server that still says auth",
      401,
      { ok: false, error: "auth" },
      false,
    ],
    ["a 401 with no error at all", 401, { ok: false }, false],
    ["a 401 whose body will not parse", 401, undefined, false],
    ["a 403 — not this route's answer", 403, { error: "revoked" }, false],
    ["a 500 mid-deploy", 500, { error: "revoked" }, false],
    ["a 200 that happens to carry the word", 200, { error: "revoked" }, false],
  ])("%s → wipes: %j", async (_name, status, body, wiped) => {
    // The quick logger's in-memory last-good copy (#3416) is part of the perimeter:
    // it goes with the wipe, and only with the wipe.
    const held = {
      profileId: 1,
      day: "2026-09-05",
      reach: { kind: "today" } as const,
    };
    rememberLastGood(held, "dose", { form: "unavailable", message: "held" });
    expect(await wipeIfRevoked(answer(status, body))).toBe(wiped);
    expect(wipes).toHaveBeenCalledTimes(wiped ? 1 : 0);
    expect(recallLastGood(held, "dose") === undefined).toBe(wiped);
  });
});
