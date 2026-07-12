import { revalidatePath } from "next/cache";
import { getCurrentSession } from "@/lib/auth";
import { applyIntent } from "@/lib/offline/writes";
import {
  FLOW_KINDS,
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
// middleware cookie-presence check), then an explicit WRITE-access assertion that
// mirrors requireWriteAccess() (which redirects; a route must return a status). A
// missing session → 401 and a read-only grant → 403; on either the client keeps the
// queue and prompts to log in — a queued write is NEVER dropped because the session
// lapsed while offline. Writes land on the session's ACTIVE profile.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The absolute cap on intents accepted per POST — the queue only holds a person's
// own manual quick-logs, so a batch this large is abuse, not legitimate use.
const MAX_INTENTS = 200;

function isFlow(v: unknown): v is QueuedIntent["flow"] {
  return typeof v === "string" && (FLOW_KINDS as readonly string[]).includes(v);
}

// Structural guard — a replayed intent must carry a string key + known flow + a
// date + an object payload. A malformed entry is reported "rejected" so the client
// drops it rather than retrying forever.
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
  if (session.access !== "write") {
    return Response.json(
      { ok: false, error: "forbidden", results: [] },
      { status: 403 }
    );
  }
  const profileId = session.profile.id;

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
    try {
      const outcome = applyIntent(profileId, raw);
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
    for (const p of ["/", "/medicine", "/trends", "/biomarkers"]) {
      revalidatePath(p);
    }
  }

  return Response.json({ ok: true, results });
}
