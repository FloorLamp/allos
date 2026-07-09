// Persisted raw provider payloads for integration syncs (issue #9). Each sync can
// point at the exact request/response body it exchanged with the provider via
// integration_sync_events.raw_ref, and the admin-only viewer
// (app/api/integrations/raw/[id]) reads it back to make "why did/didn't this
// change" debuggable from the UI. Mirrors lib/ai-log.ts's bounded, best-effort
// file pattern.
//
// PHI-adjacent: payloads are written under the gitignored data/ volume, scoped per
// profile, byte-capped, and retained newest-N per (profile, provider). Reads are
// admin-only + profile-scoped at the route.
//
// Server-only: uses node:fs. NEVER import from a client component.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createLogger } from "@/lib/log";
import { capPayload, isSafeRawRef, KEEP_PER_PROVIDER } from "./raw-log-format";

const log = createLogger("integration-raw");

// The only directory raw sync payloads are ever written under (gitignored /data,
// like data/logs and data/uploads). One subdirectory per profile.
export const RAW_PAYLOAD_ROOT = path.join(
  process.cwd(),
  "data",
  "integration-payloads"
);

function profileDir(profileId: number): string {
  return path.join(RAW_PAYLOAD_ROOT, String(profileId));
}

// Retain only the newest KEEP_PER_PROVIDER payloads for this (profile, provider),
// unlinking older ones. Files are named `<provider>-<uuid>.json`, so the provider
// prefix lets retention prune per provider by directory listing. Best-effort.
function pruneOld(dir: string, provider: string) {
  try {
    const prefix = `${provider}-`;
    const entries = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    if (entries.length <= KEEP_PER_PROVIDER) return;
    const withTime = entries.map((f) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch {
        // treat unstattable as oldest
      }
      return { f, mtime };
    });
    withTime.sort((a, b) => b.mtime - a.mtime); // newest first
    for (const { f } of withTime.slice(KEEP_PER_PROVIDER)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

// Persist a raw provider payload, returning the ref (bare filename) to store on the
// sync event, or null on ANY failure — writing MUST NEVER throw into ingest.
export function writeRawPayload(
  profileId: number,
  provider: string,
  payload: string
): string | null {
  if (typeof payload !== "string") return null;
  // provider comes from our own registry ids ('health-connect' | 'strava'), but
  // sanitize defensively so it can't influence the filename/prefix.
  const safeProvider = provider.replace(/[^\w-]/g, "");
  if (!safeProvider) return null;
  try {
    const dir = profileDir(profileId);
    fs.mkdirSync(dir, { recursive: true });
    const ref = `${safeProvider}-${crypto.randomUUID()}.json`;
    if (!isSafeRawRef(ref)) return null; // belt-and-suspenders: prefix+uuid is always safe
    fs.writeFileSync(path.join(dir, ref), capPayload(payload));
    pruneOld(dir, safeProvider);
    return ref;
  } catch (err) {
    log.error("failed to write integration raw payload", {
      provider,
      err: String(err),
    });
    return null;
  }
}

// Read a stored raw payload for a profile, or null. PATH-CONTAINED: the ref must be
// a bare safe filename AND the resolved path must stay inside the profile's payload
// directory (defence in depth beyond isSafeRawRef).
export function readRawPayload(profileId: number, ref: string): string | null {
  if (!isSafeRawRef(ref)) return null;
  try {
    const dir = profileDir(profileId);
    const abs = path.resolve(dir, ref);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
