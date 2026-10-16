import { describe, it, expect } from "vitest";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword, hashPasswordSync, verifyPassword } from "../password";

describe("password hashing", () => {
  it("stores a salted, self-describing hash that verifies only its password", async () => {
    const password = "correct horse battery staple";
    const stored = hashPasswordSync(password);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);

    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    const [scheme, n, r, p, saltHex, hashHex] = parts;
    expect(scheme).toBe("scrypt");
    expect(n).toBe("32768");
    expect(r).toBe("8");
    expect(p).toBe("1");
    expect(saltHex).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
    expect(hashPasswordSync(password)).not.toBe(stored);
  });

  it("returns false for malformed stored hashes rather than throwing", async () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$32768$8$1$deadbeef", // too few fields
      "bcrypt$32768$8$1$aa$bb", // wrong scheme
      "scrypt$0$8$1$aa$bb", // non-positive N
      "scrypt$32769$8$1$aa$bb", // N not a power of two
      "scrypt$32768$8$1$xy$bb", // non-hex salt
      "scrypt$32768$8$1$aa$", // empty hash
    ]) {
      expect(await verifyPassword("pw", bad)).toBe(false);
    }
  });
});

it("keeps concurrent token/password hashing and verification within Deck's lag budget", async () => {
  const stored = await hashPassword("synthetic authentication load");
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    await delay(30);
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        if (index % 2 === 0)
          return verifyPassword("synthetic authentication load", stored);
        const hash = await hashPassword("synthetic new password");
        return verifyPassword("synthetic new password", hash);
      })
    );
    await delay(30);
    expect(results.every(Boolean)).toBe(true);
    expect(lag.count).toBeGreaterThan(0);
    expect(lag.max / 1e6).toBeLessThanOrEqual(200);
  } finally {
    lag.disable();
  }
});
