// DB INTEGRATION TIER — a web-push send is BOUNDED at the socket.
//
// web-push arms a socket timeout only when one is passed in its options, and the
// send site passed none: a push service that accepted the connection and then never
// answered left the send pending with no ceiling. dispatch() fans the channels under
// Promise.all, so that one endpoint became the whole dispatch's latency — and a
// post-workout dispatch is on a serialized queue, where an unbounded run means the
// next activity is never announced at all. Silence, on the tier whose whole job is
// not being silent.
//
// Asserted at the real send site (the channel's own send, through dispatch) rather
// than against a constant, so deleting the option is what turns this red.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(() => {}),
    sendNotification: vi.fn(async () => {}),
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "test-public",
      privateKey: "test-private",
    })),
  },
}));

import webpush from "web-push";
import { db } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { dispatch } from "@/lib/notifications";
import type { NotificationMessage } from "@/lib/notifications/types";

const sendPush = vi.mocked(webpush.sendNotification);

const DOSE: NotificationMessage = {
  title: "Morning supplements",
  body: "Time for your morning supplements: Vitamin D.",
  kind: "dose",
};

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('push-timeout')").run()
      .lastInsertRowid
  );
  setSetting("vapid_public_key", "test-public");
  setSetting("vapid_private_key", "test-private");
  const loginId = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES ('push-timeout-member', 'x', 'member')"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(loginId, profileId);
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, login_id, p256dh, auth)
     VALUES ('https://push.example/ep-timeout', ?, 'p', 'a')`
  ).run(loginId);
});

beforeEach(() => {
  sendPush.mockClear();
});

describe("web-push send bounding", () => {
  it("passes a numeric socket timeout, so a silent endpoint cannot hang the dispatch", async () => {
    const results = await dispatch(profileId, DOSE);
    expect(results).toEqual([{ id: "push", ok: true }]);
    expect(sendPush).toHaveBeenCalledTimes(1);

    const options = sendPush.mock.calls[0][2];
    expect(typeof options?.timeout).toBe("number");
    expect(options!.timeout).toBeGreaterThan(0);
  });
});
