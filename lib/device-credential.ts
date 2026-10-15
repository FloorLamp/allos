// A TypeScript port of spaceport shared/devices.mjs (FloorLamp/spaceport; BACKEND.md
// *Device credentials*): keep the behavior the same, change it there first.
//
// Device credentials: boarding enrolls a device once and issues its one credential
// (`dev_` + 43 base64url, boarding README *Devices*); every service a device calls
// verifies it here. Verified by boarding, not offline: a service posts the credential's
// SHA-256 (never the credential) to boarding's /devices/verify and caches the answer
// TTL_MS, so a revoke, a rotation or a scope change reaches every service within that,
// with no key or list to distribute and boarding's own last-used. Fail-closed: boarding
// not answering is an error (the service answers 503), never a device.
import { createHash } from "node:crypto";
import { parseUtcSql } from "./date";

export const CREDENTIAL = /^dev_[A-Za-z0-9_-]{43}$/;
export const BOARDING_URL = "http://boarding:9816";
export const TTL_MS = 30_000;

/** The bearer token of a request's Authorization header, or ''. */
export const bearer = (req: Request): string =>
  /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";

/** The device and its scopes at the asking service. */
export interface Device {
  device: string;
  scopes: string[];
}

export class BoardingUnavailable extends Error {
  readonly status = 503;
}

type Fetch = typeof globalThis.fetch;

export interface DeviceVerifier {
  /**
   * The device a credential belongs to and its scopes here, or null (not a
   * credential, unknown, revoked or expired). Throws BoardingUnavailable when boarding
   * cannot answer.
   */
  check(token: string | undefined): Promise<Device | null>;
}

export function deviceVerifier({
  service,
  url = BOARDING_URL,
  ttlMs = TTL_MS,
  timeoutMs = 3000,
  max = 1000,
  now = Date.now,
  // Resolved at call time, not captured: a test stubs the global and the verifier
  // built at module load still sees it.
  fetch = (...args: Parameters<Fetch>) => globalThis.fetch(...args),
}: {
  service: string;
  url?: string;
  ttlMs?: number;
  timeoutMs?: number;
  max?: number;
  now?: () => number;
  fetch?: Fetch;
}): DeviceVerifier {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(service))
    throw new Error("service: lowercase letters, digits and -");
  // sha256 → the answer and until when it holds.
  const cache = new Map<string, { until: number; device: Device | null }>();
  const asking = new Map<string, Promise<Device | null>>();
  const endpoint = `${url.replace(/\/$/, "")}/devices/verify`;

  const ask = async (sha256: string): Promise<Device | null> => {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha256, service }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BoardingUnavailable(
        `boarding unreachable: ${(e as Error).message}`
      );
    }
    const body = (await res.json().catch(() => null)) as {
      device?: { name?: unknown; scopes?: unknown; expires?: string } | null;
    } | null;
    const d = body?.device;
    if (
      res.status !== 200 ||
      d === undefined ||
      (d !== null && (typeof d.name !== "string" || !Array.isArray(d.scopes)))
    )
      throw new BoardingUnavailable(`boarding answered ${res.status}`);
    const device: Device | null = d && {
      device: d.name as string,
      scopes: (d.scopes as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.startsWith(`${service}:`)
      ),
    };
    const t = now();
    // boarding's `expires` is an ISO UTC instant (`…Z`); unparseable: never cached.
    const expires = d?.expires
      ? (parseUtcSql(d.expires)?.getTime() ?? NaN)
      : Infinity;
    while (cache.size >= max) cache.delete(cache.keys().next().value as string);
    cache.set(sha256, { until: Math.min(t + ttlMs, expires), device });
    return device;
  };

  return {
    async check(token) {
      if (!token || !CREDENTIAL.test(token)) return null;
      const sha256 = createHash("sha256").update(token).digest("hex");
      const hit = cache.get(sha256);
      if (hit && hit.until > now()) return hit.device;
      cache.delete(sha256);
      let p = asking.get(sha256);
      if (!p) {
        p = ask(sha256).finally(() => asking.delete(sha256));
        asking.set(sha256, p);
      }
      return p;
    },
  };
}

/** Whether a verified device holds `scope`. */
export const allows = (who: Device | null, scope: string): boolean =>
  !!who && who.scopes.includes(scope);
