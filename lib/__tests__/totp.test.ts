import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  verifyTotp,
  otpauthURL,
  stepForTime,
} from "@/lib/totp";

// The RFC 6238 Appendix B shared secret for SHA-1 is the ASCII string
// "12345678901234567890" (20 bytes). Its base32 encoding is well-known.
const SEED_ASCII = "12345678901234567890";
const SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32", () => {
  it("encodes the RFC 6238 SHA-1 seed to the canonical base32", () => {
    expect(base32Encode(Buffer.from(SEED_ASCII, "ascii"))).toBe(SEED_BASE32);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 42, 7]);
    const decoded = base32Decode(base32Encode(bytes));
    expect(decoded).not.toBeNull();
    expect(Buffer.compare(decoded!, bytes)).toBe(0);
  });

  it("is tolerant of lowercase, spaces, and padding", () => {
    const a = base32Decode(SEED_BASE32);
    const b = base32Decode(SEED_BASE32.toLowerCase().replace(/(.{4})/g, "$1 "));
    expect(a).not.toBeNull();
    expect(Buffer.compare(a!, b!)).toBe(0);
  });

  it("returns null for a non-alphabet character", () => {
    expect(base32Decode("111!")).toBeNull();
  });
});

// RFC 6238 Appendix B test vectors (SHA-1 column), plus the 6-digit truncation
// of the same dynamic binary code (the app default): the 8-digit value's last 6
// digits, since 6-digit = dbc mod 10^6 and 8-digit = dbc mod 10^8.
const VECTORS: { time: number; eight: string; six: string }[] = [
  { time: 59, eight: "94287082", six: "287082" },
  { time: 1111111109, eight: "07081804", six: "081804" },
  { time: 1111111111, eight: "14050471", six: "050471" },
  { time: 1234567890, eight: "89005924", six: "005924" },
  { time: 2000000000, eight: "69279037", six: "279037" },
  { time: 20000000000, eight: "65353130", six: "353130" },
];

describe("TOTP against RFC 6238 vectors", () => {
  for (const v of VECTORS) {
    it(`t=${v.time}: 8-digit ${v.eight}, 6-digit ${v.six}`, () => {
      const timeMs = v.time * 1000;
      expect(totp(SEED_BASE32, { timeMs, digits: 8 })).toBe(v.eight);
      expect(totp(SEED_BASE32, { timeMs, digits: 6 })).toBe(v.six);
    });
  }

  it("hotp truncation matches the direct 8-digit vector at step 1 (t=59)", () => {
    const key = base32Decode(SEED_BASE32)!;
    expect(hotp(key, stepForTime(59_000), 8)).toBe("94287082");
  });
});

describe("verifyTotp", () => {
  const timeMs = 59_000; // step 1

  it("accepts the current code and reports its step", () => {
    const code = totp(SEED_BASE32, { timeMs })!;
    const res = verifyTotp(SEED_BASE32, code, { timeMs });
    expect(res.ok).toBe(true);
    expect(res.step).toBe(stepForTime(timeMs));
  });

  it("accepts a code within the ±1 window (previous step)", () => {
    const prevCode = totp(SEED_BASE32, { timeMs: timeMs - 30_000 })!;
    expect(verifyTotp(SEED_BASE32, prevCode, { timeMs }).ok).toBe(true);
  });

  it("rejects a code outside the window", () => {
    const farCode = totp(SEED_BASE32, { timeMs: timeMs + 120_000 })!;
    expect(verifyTotp(SEED_BASE32, farCode, { timeMs }).ok).toBe(false);
  });

  it("tolerates whitespace in the submitted token", () => {
    const code = totp(SEED_BASE32, { timeMs })!;
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(SEED_BASE32, spaced, { timeMs }).ok).toBe(true);
  });

  it("rejects non-numeric / wrong-length input", () => {
    expect(verifyTotp(SEED_BASE32, "abcdef", { timeMs }).ok).toBe(false);
    expect(verifyTotp(SEED_BASE32, "12345", { timeMs }).ok).toBe(false);
  });

  it("enforces the replay guard: a used step (and older) is refused", () => {
    const code = totp(SEED_BASE32, { timeMs })!;
    const first = verifyTotp(SEED_BASE32, code, { timeMs });
    expect(first.ok).toBe(true);
    // Same code again, now with lastStep = the step it matched → rejected.
    const replay = verifyTotp(SEED_BASE32, code, {
      timeMs,
      lastStep: first.step,
    });
    expect(replay.ok).toBe(false);
  });

  it("still accepts a NEWER step after a prior one was used", () => {
    const used = stepForTime(timeMs);
    const nextMs = timeMs + 30_000;
    const nextCode = totp(SEED_BASE32, { timeMs: nextMs })!;
    const res = verifyTotp(SEED_BASE32, nextCode, {
      timeMs: nextMs,
      lastStep: used,
    });
    expect(res.ok).toBe(true);
    expect(res.step).toBe(used + 1);
  });

  it("returns not-ok for a malformed secret", () => {
    expect(verifyTotp("!!!not-base32!!!", "000000", { timeMs }).ok).toBe(false);
  });
});

describe("otpauthURL", () => {
  it("builds a scannable otpauth:// URI", () => {
    const uri = otpauthURL({
      secret: SEED_BASE32,
      account: "ada",
      issuer: "Allos",
    });
    expect(uri.startsWith("otpauth://totp/Allos:ada?")).toBe(true);
    expect(uri).toContain(`secret=${SEED_BASE32}`);
    expect(uri).toContain("issuer=Allos");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
