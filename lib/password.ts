import {
  scrypt as scryptCb,
  scryptSync,
  randomBytes,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// Password hashing with scrypt from node:crypto — zero external dependencies.
// The stored form is self-describing: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`,
// so the cost parameters travel with each hash and can be bumped later without a
// forced re-hash of everyone (verify reads the params out of the stored string).
//
// Node's scrypt defaults to a 32 MiB maxmem, which REJECTS N=2^15/r=8 (the memory
// need is ~128*N*r ≈ 32 MiB plus overhead), so every call must pass a larger
// maxmem or it throws. 64 MiB clears it with headroom.
const N = 32768; // 2^15 CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32; // 256-bit derived key
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;

// Hand-rolled promise wrapper rather than util.promisify: promisify picks
// scrypt's no-options callback overload, so its typing rejects the options arg
// we need (maxmem). This wrapper keeps the options parameter typed.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}

// Parsed representation of a stored hash string. null-returning parse keeps the
// verify path total: any malformed input simply fails verification.
interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const HEX = /^[0-9a-fA-F]+$/;

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  const [scheme, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (scheme !== "scrypt") return null;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return null;
  // N must be a power of two > 1 for scrypt.
  if ((n & (n - 1)) !== 0) return null;
  if (
    !HEX.test(saltHex) ||
    saltHex.length % 2 !== 0 ||
    !HEX.test(hashHex) ||
    hashHex.length % 2 !== 0 ||
    hashHex.length === 0
  ) {
    return null;
  }
  return {
    N: n,
    r,
    p,
    salt: Buffer.from(saltHex, "hex"),
    hash: Buffer.from(hashHex, "hex"),
  };
}

function formatHash(
  n: number,
  r: number,
  p: number,
  salt: Buffer,
  hash: Buffer
): string {
  return `scrypt$${n}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// Synchronous hashing — for bootstrap/seed time only, where blocking the thread
// for ~100ms is fine. Never use on a request path (see verifyPassword).
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  }) as Buffer;
  return formatHash(N, R, P, salt, hash);
}

// Asynchronous hashing — for request paths (admin creating/resetting a login,
// a user changing their own password), where blocking Node's single thread for
// ~100ms per call would stall every other in-flight request. Same self-describing
// output format as hashPasswordSync; only the hashing runs off-thread.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = (await scryptAsync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  })) as Buffer;
  return formatHash(N, R, P, salt, hash);
}

// Asynchronous verification — scrypt runs on libuv's threadpool instead of
// blocking Node's single thread (~100ms/attempt would otherwise be an
// unauthenticated DoS vector on the login route). Derives with the params baked
// into the stored string, then compares in constant time. Returns false for any
// malformed stored value rather than throwing.
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const derived = (await scryptAsync(
    password,
    parsed.salt,
    parsed.hash.length,
    {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    }
  )) as Buffer;
  // Lengths match by construction (derived to parsed.hash.length), so
  // timingSafeEqual won't throw.
  return timingSafeEqual(derived, parsed.hash);
}
