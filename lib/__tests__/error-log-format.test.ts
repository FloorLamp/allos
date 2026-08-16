import { describe, it, expect } from "vitest";
import {
  capDetail,
  redactSecrets,
  buildDetail,
  parseErrorLine,
} from "../error-log-format";

describe("capDetail", () => {
  it("passes short strings through", () => {
    expect(capDetail("hello", 100)).toBe("hello");
  });
  it("truncates and annotates over-long strings", () => {
    const out = capDetail("a".repeat(50), 10);
    expect(out.startsWith("aaaaaaaaaa")).toBe(true);
    expect(out).toContain("(+40 chars)");
  });
});

describe("redactSecrets", () => {
  it("masks Bearer tokens", () => {
    expect(redactSecrets("sent header Bearer abc123.def-456")).toBe(
      "sent header Bearer ***"
    );
  });
  it("masks the value of an Authorization header key", () => {
    // Both rules fire (key rule + Bearer rule); either way the secret is gone.
    const out = redactSecrets("Authorization: Bearer abc123.def-456");
    expect(out).not.toContain("abc123");
  });
  it("masks sensitive key=value pairs", () => {
    expect(redactSecrets("token=supersecret&user=ada")).toBe(
      "token=***&user=ada"
    );
  });
  it("masks JSON secret fields but keeps the key", () => {
    const out = redactSecrets('{"password":"hunter2","name":"Ada"}');
    expect(out).toContain('"password":"***"');
    expect(out).toContain('"name":"Ada"');
  });
  it("leaves non-secret text untouched", () => {
    expect(redactSecrets("failed to save body_metrics for profile 3")).toBe(
      "failed to save body_metrics for profile 3"
    );
  });
  it("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});

// Every fixture below is a PATTERNED stand-in — repeated words and digit runs,
// base64 of `user:pass` — carrying the SHAPE of the real thing and none of its
// entropy. The shapes are what redaction matches on, so a patterned value
// proves exactly what a realistic one would.
//
// The credential-shaped ones are ASSEMBLED AT RUNTIME rather than written out.
// A committed vendor-prefixed key or a literal three-segment JWT is what the
// scan exists to catch, and it reads git history across every ref — so a
// fixture that matches fails gitleaks on every other open PR too, and deleting
// it later does not help. The value under test is byte-identical either way.
const b64 = (s: string) => Buffer.from(s).toString("base64");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const B64_BASIC = b64("Abcd1234Abcd1234");
const B64_LETTERS_ONLY = b64("user:pass"); // no digits
const HEX_ID = "abcd1234abcd1234abcd1234";
const HEX_SIG = "abcd1234".repeat(8);
const UUID = "abcd1234-ab12-4c34-8d56-abcd1234ef56";
const API_KEY = ["sk", "test", "1234demo1234demo"].join("_");
const JWT = [
  b64url('{"alg":"HS256"}'),
  b64url('{"sub":"1234"}'),
  "abcd1234abcd1234",
].join(".");

// The nine inputs from #2938, asserted one at a time. Six carry a credential
// and must be masked; three carry PII/PHI and are deliberately left alone —
// redactSecrets is a credential filter, and the reader of the profile-facing
// copy is the data subject. See buildDetail's note.
describe("redactSecrets: the #2938 shapes", () => {
  it("1. masks the Basic CREDENTIAL and keeps the scheme word", () => {
    // The old rule did the reverse — it masked the word `Basic` and left the
    // base64, producing a string that read as handled.
    const out = redactSecrets(`Authorization: Basic ${B64_BASIC}`);
    expect(out).toBe("Authorization: Basic ***");
    expect(out).not.toContain(B64_BASIC);
  });

  it("2. masks an opaque token sitting in a URL path segment", () => {
    const out = redactSecrets(
      `GET https://wbsapi.withings.net/v2/measure/${HEX_ID}/getactivity`
    );
    expect(out).not.toContain(HEX_ID);
    expect(out).toBe(
      "GET https://wbsapi.withings.net/v2/measure/***/getactivity"
    );
  });

  it("3. masks presigned-URL credential and signature parameters", () => {
    const out = redactSecrets(
      `https://s3.amazonaws.com/b/k?X-Amz-Credential=DEMOKEY1234%2F20260815%2Fus-east-1&X-Amz-Signature=${HEX_SIG}`
    );
    expect(out).not.toContain(HEX_SIG);
    expect(out).not.toContain("DEMOKEY1234");
    expect(out).toBe(
      "https://s3.amazonaws.com/b/k?X-Amz-Credential=***&X-Amz-Signature=***"
    );
  });

  it("4. masks an exchangeable OAuth code but keeps the grant type", () => {
    const out = redactSecrets(
      "POST https://oauth2.googleapis.com/oauth/token?code=4%2F0demo1234demo1234&grant_type=authorization_code"
    );
    expect(out).not.toContain("0demo1234demo1234");
    expect(out).toContain("grant_type=authorization_code");
  });

  it("5. masks a header name that only a dash kept off the old list", () => {
    expect(redactSecrets(`sent X-Api-Key: ${API_KEY}`)).toBe(
      "sent X-Api-Key: ***"
    );
  });

  it("6. masks a session id whose key only differs by a suffix", () => {
    expect(redactSecrets(`sessionId=${UUID}`)).toBe("sessionId=***");
  });

  it("7. LEAVES an email address — the error is one the profile must act on", () => {
    const s = "no account linked for sam.rivers+health@example.com";
    expect(redactSecrets(s)).toBe(s);
  });

  it("8. LEAVES account ids, errno, address and host — the diagnosis", () => {
    const s =
      "Withings userid=12340001 sync failed: connect ECONNREFUSED 10.0.7.31:8443 (allos-worker-02.internal)";
    expect(redactSecrets(s)).toBe(s);
  });

  it("9. LEAVES clinical detail — PHI is not this function's filter", () => {
    const s = "patient Ada Lovelace, DOB 1974-03-02, MRN 0012345";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("redactSecrets: boundaries", () => {
  it("masks a Basic credential with no digits, via the header name", () => {
    const out = redactSecrets(`authorization=Basic ${B64_LETTERS_ONLY}`);
    expect(out).not.toContain(B64_LETTERS_ONLY);
    expect(out).toBe("authorization=Basic ***");
  });

  it("masks a bare Basic credential on its internal case change", () => {
    const out = redactSecrets(`retrying with Basic ${B64_LETTERS_ONLY}`);
    expect(out).not.toContain(B64_LETTERS_ONLY);
  });

  it("leaves a clinical phrase that happens to start with Basic", () => {
    const s = "Basic Metabolic Panel import failed for 3 rows";
    expect(redactSecrets(s)).toBe(s);
  });

  it("masks userinfo credentials in a URL authority", () => {
    const out = redactSecrets("dial https://ada:hunter2@api.example.com/v1");
    expect(out).toBe("dial https://***@api.example.com/v1");
  });

  it("masks a JWT in a path segment and a bearer JWT alike", () => {
    expect(redactSecrets(`https://h.example.com/cb/${JWT}`)).toBe(
      "https://h.example.com/cb/***"
    );
    expect(redactSecrets(`Bearer ${JWT}`)).toBe("Bearer ***");
  });

  it("masks an opaque token that carries a file extension", () => {
    expect(redactSecrets(`https://h.example.com/export/${HEX_ID}.csv`)).toBe(
      "https://h.example.com/export/***"
    );
  });

  it("leaves a long lowercase slug and ordinary query parameters", () => {
    const s =
      "GET https://api.ouraring.com/v2/comprehensive-metabolic-panel-2026?start_date=2026-08-01&end_date=2026-08-15";
    expect(redactSecrets(s)).toBe(s);
  });

  it("leaves the errno and status fields an operator reads the error for", () => {
    const s = '{"code":"ECONNREFUSED","status_code":401,"errno":-111}';
    expect(redactSecrets(s)).toBe(s);
  });

  it("does not mask keys that merely contain a sensitive word", () => {
    const s = '{"author":"Ada Lovelace","passed":true,"bypass":1,"design":"a"}';
    expect(redactSecrets(s)).toBe(s);
  });

  it("masks through JSON escaping, which used to defeat the key rule", () => {
    const out = redactSecrets('{\\"access_token\\":\\"demo1234demo\\"}');
    expect(out).not.toContain("demo1234demo");
    expect(out).toBe('{\\"access_token\\":\\"***\\"}');
  });

  it("masks a percent-encoded scheme+credential via its key", () => {
    expect(redactSecrets("authorization=Bearer%20demo1234demo")).toBe(
      "authorization=***"
    );
  });

  it("masks Set-Cookie and dashed auth headers, keeping the rest of the line", () => {
    expect(redactSecrets("Set-Cookie: sid=demo1234; Path=/")).toBe(
      "Set-Cookie: ***; Path=/"
    );
    expect(redactSecrets("X-Auth-Token: demo1234demo")).toBe(
      "X-Auth-Token: ***"
    );
  });

  it("stays roughly linear on a big detail", () => {
    // A stack or a dumped response body is the input here, and redaction runs
    // BEFORE the cap. Two of the passes were quadratic in the input length
    // while being written (1.2s on 32KB), so this guards the shape of the cost,
    // not a stopwatch: the linear form does this in tens of milliseconds.
    const dense = "a:a=".repeat(16000);
    const t0 = performance.now();
    redactSecrets(dense);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("stays idempotent on every shape above", () => {
    const samples = [
      `Authorization: Basic ${B64_BASIC}`,
      `GET https://wbsapi.withings.net/v2/measure/${HEX_ID}/getactivity`,
      `https://s3.amazonaws.com/b/k?X-Amz-Signature=${HEX_SIG}`,
      "https://oauth2.googleapis.com/t?code=4%2F0demo1234demo1234",
      `sent X-Api-Key: ${API_KEY}`,
      `sessionId=${UUID}`,
      "https://ada:hunter2@api.example.com/v1",
      `Bearer ${JWT}`,
      "Set-Cookie: sid=demo1234; Path=/",
      '{\\"access_token\\":\\"demo1234demo\\"}',
      "no account linked for sam.rivers+health@example.com",
    ];
    for (const s of samples) {
      const once = redactSecrets(s);
      expect(redactSecrets(once)).toBe(once);
    }
  });
});

describe("buildDetail", () => {
  it("returns undefined with no fields", () => {
    expect(buildDetail(undefined)).toBeUndefined();
    expect(buildDetail({})).toBeUndefined();
  });
  it("extracts an Error stack", () => {
    const err = new Error("boom");
    const out = buildDetail({ err });
    expect(out).toContain("boom");
  });
  it("serializes plain fields as JSON", () => {
    const out = buildDetail({ profileId: 3, action: "save" });
    expect(out).toContain('"profileId":3');
    expect(out).toContain('"action":"save"');
  });
  it("redacts secrets found in fields", () => {
    const out = buildDetail({ headers: "authorization=Bearer xyz" });
    expect(out).not.toContain("xyz");
  });
  it("caps very long detail", () => {
    const out = buildDetail({ blob: "x".repeat(9000) }, 100);
    expect(out!.length).toBeLessThan(200);
    expect(out).toContain("chars)");
  });
});

// #2938's second half: buildDetail used to stringify and THEN redact, so
// JSON.stringify's escaping defeated the key rules and the operator-only error
// log came out LESS redacted than the profile-facing column built from the same
// throw. Redaction now happens during serialization.
describe("buildDetail redacts after serialization (#2938)", () => {
  const BODY =
    '{"access_token":"demo1234access","refresh_token":"demo1234refresh","expires_in":21600}';

  it("masks a stringified response body a text pass could not reach", () => {
    const out = buildDetail({ provider: "strava", body: BODY })!;
    expect(out).not.toContain("demo1234access");
    expect(out).not.toContain("demo1234refresh");
    // The escaped shape survives, so the line is still readable JSON.
    expect(out).toContain('\\"access_token\\":\\"***\\"');
    // And the parts that make it diagnosable survive.
    expect(out).toContain('"provider":"strava"');
    expect(out).toContain("21600");
  });

  it("never leaves the admin log less redacted than the profile column", () => {
    // Same throw, both readers. The profile-facing copy goes through
    // redactSecrets directly (lib/integrations/backfill-error.ts); the admin
    // copy goes through buildDetail.
    const err = new Error(`Strava token refresh failed (400): ${BODY}`);
    const profileFacing = redactSecrets(err.message);
    const adminLog = buildDetail({ provider: "strava", body: BODY, err })!;
    for (const secret of ["demo1234access", "demo1234refresh"]) {
      expect(profileFacing).not.toContain(secret);
      expect(adminLog).not.toContain(secret);
    }
    // Both still say what failed.
    expect(profileFacing).toContain("400");
    expect(adminLog).toContain("400");
  });

  it("masks a whole nested object hanging off a sensitive key", () => {
    const out = buildDetail({ creds: { user: "ada", pass: "hunter2" } })!;
    expect(out).not.toContain("hunter2");
    expect(JSON.parse(out)).toEqual({ creds: "***" });
  });

  it("masks a sensitive key holding a non-string value", () => {
    const out = buildDetail({ sessionId: 4210, retries: 2 })!;
    expect(out).not.toContain("4210");
    expect(JSON.parse(out)).toEqual({ sessionId: "***", retries: 2 });
  });

  it("masks a credential URL carried in a field", () => {
    const out = buildDetail({
      url: "https://wbsapi.withings.net/v2/measure/abcd1234abcd1234abcd1234/getactivity",
    })!;
    expect(out).not.toContain("abcd1234abcd1234abcd1234");
    expect(out).toContain("wbsapi.withings.net");
  });
});

describe("parseErrorLine", () => {
  it("parses a valid event line", () => {
    const line = JSON.stringify({
      id: "1-000001",
      time: "2026-07-13T00:00:00.000Z",
      level: "error",
      message: "boom",
    });
    const ev = parseErrorLine(line);
    expect(ev?.message).toBe("boom");
    expect(ev?.level).toBe("error");
  });
  it("rejects blank and malformed lines", () => {
    expect(parseErrorLine("")).toBeNull();
    expect(parseErrorLine("   ")).toBeNull();
    expect(parseErrorLine("{not json")).toBeNull();
  });
  it("rejects objects missing required fields", () => {
    expect(parseErrorLine(JSON.stringify({ id: "1" }))).toBeNull();
    expect(parseErrorLine(JSON.stringify({ message: "x" }))).toBeNull();
  });
});
