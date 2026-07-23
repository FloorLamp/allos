// DB INTEGRATION TIER — Health Connect ingest error isolation (issue #1285).
//
// The post-commit post-workout arming (queuePostWorkoutForFreshImports) runs mid-way
// through ingestHealthConnectPayload, AFTER every chunk's DB writes have already
// committed. A throw there (e.g. a downstream findings computation failing) must NOT
// bubble up and misreport an otherwise-successful ingest as a full sync failure — the
// call is wrapped in its own try/catch, so the batch's committed activity rows stand
// and the ingest returns its counts normally. The next rolling-window push re-arms it.
//
// The module is mocked to throw; the assertion is that the ingest still SUCCEEDS.

import { vi, describe, it, expect } from "vitest";

vi.mock("@/lib/notifications/post-workout-imports", () => ({
  queuePostWorkoutForFreshImports: vi.fn(() => {
    throw new Error("downstream post-workout arming failed");
  }),
}));

import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { queuePostWorkoutForFreshImports } from "@/lib/notifications/post-workout-imports";

const TZ = "UTC";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

describe("HC ingest isolates a throwing post-workout arming (#1285)", () => {
  it("a thrown queue call does not fail the batch — committed rows + counts stand", () => {
    const profileId = newProfile("HC-PWQ-ISOLATION");
    const parsed = parseHealthConnectPayload(
      {
        exercise: [
          {
            start_time: "2026-06-07T06:00:00Z",
            end_time: "2026-06-07T07:00:00Z",
            type: "running",
          },
        ],
      },
      TZ
    );
    expect(parsed.activities.length).toBe(1);

    // The ingest inserts the activity (activities.inserted > 0), so the arming fires —
    // and throws. It must be swallowed: no exception escapes the ingest.
    let res: ReturnType<typeof ingestHealthConnectPayload> | undefined;
    expect(() => {
      res = ingestHealthConnectPayload(profileId, parsed, "health-connect");
    }).not.toThrow();

    // The throwing arming was actually reached (the isolation path was exercised)...
    expect(queuePostWorkoutForFreshImports).toHaveBeenCalledWith(profileId);
    // ...and the batch's writes committed + are reported as a normal success.
    expect(res!.counts.activities).toBe(1);
    expect(res!.split.inserted).toBe(1);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?`)
          .get(profileId) as { n: number }
      ).n
    ).toBe(1);
  });
});
