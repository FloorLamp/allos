import { describe, it, expect } from "vitest";
import { hashPasswordSync, verifyPassword } from "../password";

describe("password hashing", () => {
  it("round-trips a hash back to a successful verification", async () => {
    const stored = hashPasswordSync("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(
      true
    );
  });

  it("rejects the wrong password", async () => {
    const stored = hashPasswordSync("hunter2");
    expect(await verifyPassword("hunter3", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("is self-describing: params and salt live in the stored string", () => {
    const stored = hashPasswordSync("pw");
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    const [scheme, n, r, p, saltHex, hashHex] = parts;
    expect(scheme).toBe("scrypt");
    expect(n).toBe("32768");
    expect(r).toBe("8");
    expect(p).toBe("1");
    expect(saltHex).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
  });

  it("produces a distinct salt (and thus hash) per call", () => {
    const a = hashPasswordSync("same");
    const b = hashPasswordSync("same");
    expect(a).not.toBe(b);
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
