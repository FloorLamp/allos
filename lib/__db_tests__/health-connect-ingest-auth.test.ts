// DB INTEGRATION TIER — boundary NEGATIVE tests for the Health Connect push-ingest
// route's bearer-token auth (issue #1210). The existing ingest tests cover the 413
// over-size and the happy-path write; nothing pinned the token DENIALS at the route
// level. This is an unauthenticated WRITE endpoint whose only gate is the per-profile
// bearer token — a regression that stopped rejecting an unmatched token would let any
// caller write into a profile's data.
//
// Drives the REAL POST handler with synthesized requests. A missing, a wrong, and an
// EXPIRED token must all resolve to the SAME uniform 401 with no oracle (an expired
// token is treated as if it never existed, so it can't be distinguished from a bogus
// one). A matched token writes and returns ok:true — proving the 401s are the token
// check, not a dead route.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";

let profileId: number;
let goodToken: string;

function ingest(headers: Record<string, string>, body: unknown = {}): Request {
  return new Request("http://x/api/integrations/health-connect/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-AUTH')").run()
      .lastInsertRowid
  );
  goodToken = generateHealthConnectToken(profileId, "never");
});

describe("health-connect ingest — bearer denials (#1210)", () => {
  it("401s a request with NO Authorization header", async () => {
    const res = await POST(ingest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    // Generic guidance — never echoes any token or says which token would work.
    expect(body.error).not.toContain(goodToken);
  });

  it("401s a WRONG bearer token", async () => {
    const res = await POST(
      ingest({ authorization: "Bearer definitely-not-a-real-token" })
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(false);
  });

  it("401s an EXPIRED token identically (no oracle vs. a bogus token)", async () => {
    const expProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('HC-EXPIRED')").run()
        .lastInsertRowid
    );
    const expiredToken = generateHealthConnectToken(expProfile, "90d");
    // Force the stored expiry into the past.
    const conn = db
      .prepare(
        "SELECT config FROM integration_connections WHERE profile_id = ? AND provider = 'health-connect'"
      )
      .get(expProfile) as { config: string };
    const cfg = JSON.parse(conn.config);
    cfg.tokenExpiresAt = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare(
      "UPDATE integration_connections SET config = ? WHERE profile_id = ? AND provider = 'health-connect'"
    ).run(JSON.stringify(cfg), expProfile);

    const res = await POST(ingest({ authorization: `Bearer ${expiredToken}` }));
    expect(res.status).toBe(401);
  });

  it("accepts the matched token (proves the 401s are the token gate, not a dead route)", async () => {
    const res = await POST(ingest({ authorization: `Bearer ${goodToken}` }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
  });
});
