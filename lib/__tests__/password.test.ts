import { describe, it, expect } from "vitest";
import { hashPasswordSync, verifyPassword } from "../password";

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
