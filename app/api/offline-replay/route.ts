import { revalidatePath } from "next/cache";
import {
  getCurrentSession,
  getAccessibleProfiles,
  accessForProfile,
} from "@/lib/auth";
import { applyIntent } from "@/lib/offline/writes";
import {
  FLOW_KINDS,
  MAX_INTENTS,
  type QueuedIntent,
  type ReplayResult,
} from "@/lib/offline/queue";

// Replay endpoint for the PWA offline write queue (issue #28). The browser
// (components/OfflineQueueProvider) POSTs the intents it queued while offline; each
// is applied EXACTLY ONCE via lib/offline/writes::applyIntent, which runs the same
// write cores + validation the live Server Actions use and records the intent's
// idempotency key in `replayed_keys`, so a double flush (online event + on-load +
// Background Sync racing) can't double-log.
//
// AUTH — this is a ROUTE HANDLER, not a Server Action, so it authenticates the way
// the export routes do: cookie-authoritative getCurrentSession() (never the coarse
// middleware cookie-presence check). A missing session → 401; the client keeps the
// queue and prompts to log in — a queued write is NEVER dropped because the session
// lapsed while offline.
//
// PROFILE ATTRIBUTION (issue #599) — a queued write lands on the profile it was
// CAPTURED under (intent.profileId), NOT whatever profile is active at flush time.
// Per intent: the login must still hold WRITE access to the stamped profile
// (accessible AND a non-read grant), verified per-intent below; if that access is
// gone the intent is reported "rejected" (an honest dead-letter reason) rather than
// silently rerouted to the active profile. A LEGACY intent queued before the
// profileId stamp shipped has none — it falls back to the active profile (its only
// possible attribution), still gated on write access to that profile.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isFlow(v: unknown): v is QueuedIntent["flow"] {
  return typeof v === "string" && (FLOW_KINDS as readonly string[]).includes(v);
}

// Structural guard — a replayed intent must carry a string key + known flow + a
// date + an object payload. A malformed entry is reported "rejected" so the client
// drops it rather than retrying forever. profileId is validated separately (an
// absent one is the legacy-intent fallback, not a malformed entry).
function isIntent(v: unknown): v is QueuedIntent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    o.key.length > 0 &&
    isFlow(o.flow) &&
    typeof o.date === "string" &&
    typeof o.payload === "object" &&
    o.payload !== null
  );
}

export async function POST(req: Request) {
  const session = await getCurrentSession();
  if (!session) {
    // Session expired (possibly while offline) — keep the queue, prompt re-login.
    return Response.json(
      { ok: false, error: "auth", results: [] },
      { status: 401 }
    );
  }
  const { login } = session;
  // The set of profiles this login can WRITE right now — a stamped intent targeting
  // anything outside it is dead-lettered, never applied. accessForProfile assumes the
  // profile is already reachable (it defaults an ungranted member to 'write'), so
  // accessibility is checked FIRST via this set, exactly like requireProfileWriteAccess.
  const accessible = await getAccessibleProfiles();
  const canWriteProfile = (targetId: number): boolean =>
    accessible.some((p) => p.id === targetId) &&
    accessForProfile(login.id, login.role, targetId) === "write";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad-json" }, { status: 400 });
  }
  const intents = (body as { intents?: unknown })?.intents;
  if (!Array.isArray(intents)) {
    return Response.json({ ok: false, error: "bad-shape" }, { status: 400 });
  }
  if (intents.length > MAX_INTENTS) {
    return Response.json({ ok: false, error: "too-many" }, { status: 413 });
  }

  const results: ReplayResult[] = [];
  let anyApplied = false;
  for (const raw of intents) {
    if (!isIntent(raw)) {
      // Can't identify it — drop it (no key to report if it's truly shapeless, but
      // include one when present so the client can delete it).
      const key =
        raw && typeof (raw as { key?: unknown }).key === "string"
          ? (raw as { key: string }).key
          : "";
      if (key)
        results.push({
          key,
          status: "rejected",
          reason: "The entry was malformed and couldn't be read.",
        });
      continue;
    }
    // Resolve WHICH profile this write lands on (issue #599). A stamped intent
    // targets its captured profile; a legacy unstamped one falls back to the active
    // profile. Either way the login must hold WRITE access to the target NOW — a
    // caregiver who lost the grant while the write sat queued gets an honest reject,
    // never a silent reroute onto the active profile.
    const targetProfileId =
      typeof raw.profileId === "number" ? raw.profileId : session.profile.id;
    if (!canWriteProfile(targetProfileId)) {
      results.push({
        key: raw.key,
        status: "rejected",
        reason:
          "You no longer have permission to save this entry to that profile.",
      });
      continue;
    }
    try {
      const outcome = applyIntent(targetProfileId, raw);
      if (outcome === "done") anyApplied = true;
      // A server-side rejection carries a coarse reason so the client can tell the
      // user WHY their offline entry couldn't be applied (issue #475); the full
      // captured payload is preserved client-side in the dead-letter store.
      results.push(
        outcome === "rejected"
          ? {
              key: raw.key,
              status: outcome,
              reason: "The server couldn't validate this entry.",
            }
          : { key: raw.key, status: outcome }
      );
    } catch {
      // Transient server/DB failure — leave it queued for the next flush.
      results.push({ key: raw.key, status: "error" });
    }
  }

  // Refresh the surfaces the replayed writes feed, but only when something actually
  // landed (a pure duplicate/rejected batch changed nothing).
  if (anyApplied) {
    for (const p of [
      "/",
      "/nutrition",
      "/medications",
      "/trends",
      "/results",
    ]) {
      revalidatePath(p);
    }
  }

  return Response.json({ ok: true, results });
}
