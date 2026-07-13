// DB INTEGRATION TIER — Health Connect ingest over-size rejection (issue #604 part 2).
// The two payload-too-large branches used to return `{ error }` with NO `ok: false`
// (the only responses in the handler breaking its own shape) and recorded NO sync
// event, so an over-sending phone exporter got no in-app signal of why data stopped
// landing. This proves the fix: a 413 body carries `ok: false`, and the rejection is
// recorded as a failure sync event visible in the Review inbox feed.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { getLatestSyncEventPerProvider } from "@/lib/queries";

let profileId: number;
const TOKEN = "hc-oversize-token-xyz";

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-OVERSIZE')").run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, 'health-connect', 'connected', ?)`
  ).run(profileId, JSON.stringify({ token: TOKEN }));
});

describe("health-connect ingest — over-size 413 (issue #604)", () => {
  it("rejects a >2MB body with ok:false and records a failure sync event", async () => {
    // A body comfortably over the 2MB cap. Whether the fast-path Content-Length
    // check or the authoritative byte-cap stream guard fires, both now carry ok:false
    // and record an attributable failure event.
    const oversize = "x".repeat(2 * 1024 * 1024 + 64);
    const res = await POST(
      new Request("http://x/api/integrations/health-connect/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: oversize,
      })
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/too large/i);

    // The rejection surfaces as a failing provider in the Review inbox feed.
    const latest = getLatestSyncEventPerProvider(profileId);
    const hc = latest.find((e) => e.provider === "health-connect");
    expect(hc).toBeTruthy();
    expect(hc?.ok).toBe(0);
    expect(String(hc?.error ?? "")).toMatch(/too large/i);
  });
});
