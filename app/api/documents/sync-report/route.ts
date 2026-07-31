import { revalidatePath } from "next/cache";
import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import {
  isSyncReportStatus,
  parseDiscoveredLabels,
  parseSyncReportCounts,
  parseSyncReportTarget,
  syncReportEvent,
} from "@/lib/acquirer-identity";
import {
  recordDiscoveredIdentities,
  recordPendingIdentity,
  recordPortalRunReport,
  resolveAccount,
  resolvePortalIdentity,
  type PortalAccount,
} from "@/lib/portals";
import {
  recordSync,
  recordSyncEvent,
  upsertConnection,
} from "@/lib/integrations/connections";
import { checkRateLimit } from "@/lib/rate-limit";
import { createLogger } from "@/lib/log";

// Acquirer sync report (issue #1739, the second #1735 extension).
//
// WHY THIS ENDPOINT EXISTS AT ALL. A "checked the portal, nothing new" run pushes ZERO
// documents — and it is the COMMON case. Without an explicit report the server sees no
// trace of it whatsoever, so the integrations card cannot tell *checked and unchanged*
// from *failed* or from *never ran*, and a perfectly healthy quiet week reads as broken.
// The integrations accounting rule already demands the other half of this: every sync is
// recorded with inserted/updated/unchanged counts, and Data → Review's failure badge keys
// off sync events. So the acquirer's run ends here, and the run lands as an ORDINARY sync
// event for the `mychart` provider — the same row type every other provider writes, read
// by the same surfaces, with no parallel reporting store to keep consistent.
//
// AUTH is identical to the upload route, in the same order and for the same reasons:
// rate-limit on the token's public id half BEFORE the scrypt verify; authenticate and
// demand `upload:documents` (a run report is part of the upload capability, not a new
// one); then compose the write gate explicitly — demo refusal, reachability, then write.
// A sync event is profile-owned data, so reporting one is a write and is gated like one.
//
// The destination is named exactly as an upload names it, through the same
// exactly-one-of parser: an acquirer reports `(portal, patient)` and allos resolves it,
// while a human debugging with curl may name a `profile`. A resolved identity is
// intersected with the token's write set here too — the binding says where a run belongs,
// never that this token may write there.
//
// TWO RUNS HAVE NO PROFILE, and both used to vanish (#1756):
//
//   FIRST CONTACT. The first run's own patient is not bound yet, so its report is
//   refused. The refusal is right — nothing may be filed under a guess — but recording
//   NOTHING left the card claiming "No run reported yet." directly under its promise that
//   every run is reported.
//
//   A PORTAL-LEVEL FAILURE. `{"status":"failed","portal":…}` with no patient: the login
//   page changed, the Document Center moved. Pre-patient, portal-wide, and previously
//   expressible only by fabricating a patient label.
//
// Both now leave an ACCOUNT-LEVEL run report (lib/portals.ts, migration 132) — one row
// per portal login holding the last run it reported. That is a different store from
// `integration_sync_events` on purpose: every reader of that table is profile-scoped by
// construction, so a profile-less row there would be invisible while breaking the
// invariant that a profile-owned row has a profile.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api-sync-report");

// A run report is one small JSON POST at the end of a run, so this is generous while
// still capping a client that reports in a loop.
const REPORT_RATE_LIMIT = 120;
const REPORT_RATE_WINDOW_MS = 5 * 60 * 1000;

// The provider these events land under — the registry id, so the card, the staleness
// reader and Data → Review all find them without a special case. Renamed from the
// tool-shaped "mychart" by migration 131, which moved the stored rows with it.
const PROVIDER = "patient-portals";

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const limit = checkRateLimit(
    `sync-report:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: REPORT_RATE_LIMIT, windowMs: REPORT_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) return jsonError(auth.error, auth.status);
  const { login, tokenId } = auth;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("expected a JSON object body", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("expected a JSON object body", 400);
  }

  const status = typeof body.status === "string" ? body.status : "";
  if (!isSyncReportStatus(status)) {
    return jsonError(
      "`status` must be one of: downloaded, nothing-new, failed",
      400
    );
  }

  // The destination contract. Identical to an upload's, with ONE addition: a `failed`
  // run may name a portal alone, because the likely failure mode is PRE-PATIENT (the
  // login page changed, the Document Center moved) and inventing a patient label to
  // report it would put a lie in the one table whose job is honest patient labels. Every
  // other status still demands a full target — "I checked and found nothing" is a claim
  // about a patient's records and is meaningless without one.
  const target = parseSyncReportTarget(status, {
    profile: body.profile,
    portal: body.portal,
    account: body.account,
    patient: body.patient,
  });
  if (!target.ok) return jsonError(target.error, 400);

  // The proxy-patient list this run actually SAW on that login, verbatim (#1739). This is
  // the routine path by which allos learns identities — the user binds labels allos was
  // told, instead of predicting how a portal renders a name — so it is ingested even when
  // the run's own identity is refused below, and even when the run failed. A run that
  // signed in far enough to enumerate the proxy list and THEN broke has still taught us
  // who is on that login. Bounded and sanitized by parseDiscoveredLabels before anything
  // is stored.
  const discovered = parseDiscoveredLabels(body.identities);

  const counts = parseSyncReportCounts({
    inserted: body.inserted,
    updated: body.updated,
    unchanged: body.unchanged,
    failed: body.failed,
  });
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim().slice(0, 500)
      : null;
  const ev = syncReportEvent(status, counts, message);

  // How many of the reported labels are NEWLY waiting to be bound — what
  // recordDiscoveredIdentities returns, never the length of the reported list. A tool
  // reporting the same three patients every hour taught allos nothing after the first
  // run, and the honest answer to "how many new patients need mapping" is then zero. One
  // number, quoted identically by the response, the stored run report, and the card.
  let newlyWaiting = 0;

  // ── A `failed` run that never reached a patient ──
  //
  // It resolves a real portal LOGIN and stops there. There is no profile to gate on and
  // none to invent, so this path records an ACCOUNT-LEVEL run report and nothing else:
  // no sync event, no connection stamp. The Patient portals card renders it; Data →
  // Review's failure badge is profile-scoped and cannot, which is stated where the card
  // decides its line (lib/portal-status.ts).
  if (target.target.kind === "portal") {
    const account = resolveAccount(
      target.target.portalSlug,
      target.target.accountSlug
    );
    if (!account.ok) {
      // The same typed, non-oracular refusal an unmapped patient gets: an unknown
      // portal, an unknown login, and an omitted login on a multi-login portal are
      // indistinguishable from out here.
      return Response.json(
        {
          ok: false,
          error: "unmapped-identity",
          detail:
            "That portal login is not set up in allos. Register the portal — and name the login if the portal has more than one — under Integrations → Patient portals.",
        },
        { status: 404 }
      );
    }
    if (discovered.length > 0) {
      newlyWaiting = recordDiscoveredIdentities(account.account, discovered);
    }
    recordPortalRunReport(account.account, {
      ok: false,
      status,
      message,
      discovered: newlyWaiting,
    });
    revalidatePath("/integrations/patient-portals");
    return Response.json({
      ok: true,
      portal: target.target.portalSlug,
      account: account.account.slug,
      status,
      ...(newlyWaiting > 0 ? { discovered: newlyWaiting } : {}),
    });
  }

  let profileId: number;
  let identity: {
    portalId: number;
    accountId: number;
    patientLabel: string;
  } | null = null;
  // The LOGIN this run came from, once resolved — what the account-level run report is
  // keyed to. Null for a `profile=<id>` report from a human debugging with curl, which
  // names no portal at all.
  let reportAccount: PortalAccount | null = null;
  if (target.target.kind === "profile") {
    profileId = target.target.profileId;
  } else {
    // Resolve the LOGIN first, so a discovered list can be recorded against it even when
    // the reporting patient itself is unmapped — which is exactly the first-contact case
    // the discovery path exists for.
    const account = resolveAccount(
      target.target.portalSlug,
      target.target.accountSlug
    );
    if (account.ok) {
      reportAccount = account.account;
      if (discovered.length > 0) {
        newlyWaiting = recordDiscoveredIdentities(account.account, discovered);
        revalidatePath("/integrations/patient-portals");
      }
    }
    const resolved = resolvePortalIdentity(
      target.target.portalSlug,
      target.target.accountSlug,
      target.target.patientLabel
    );
    if (!resolved.ok) {
      recordPendingIdentity(
        target.target.portalSlug,
        target.target.accountSlug,
        target.target.patientLabel,
        "unmapped-sync-report"
      );
      // FIRST CONTACT (#1756). The run authenticated and resolved a real portal login;
      // only the patient binding is missing. Refusing it silently left the card saying
      // "No run reported yet." underneath its own promise that every run is reported, at
      // the exact moment a household is deciding whether to trust this. The refusal
      // still stands — nothing is filed under a guess — but the run leaves a trace.
      if (reportAccount) {
        recordPortalRunReport(reportAccount, {
          ok: ev.ok,
          status,
          message,
          discovered: newlyWaiting,
        });
      }
      revalidatePath("/integrations/patient-portals");
      // Unknown, IGNORED, and ambiguous-account all answer identically — the endpoint is
      // deliberately non-oracular about a household's choices.
      return Response.json(
        {
          ok: false,
          error: "unmapped-identity",
          detail:
            "That portal patient is not mapped to a profile yet. Map it under Integrations → Patient portals.",
          ...(newlyWaiting > 0 ? { discovered: newlyWaiting } : {}),
        },
        { status: 404 }
      );
    }
    profileId = resolved.profileId;
    identity = {
      portalId: resolved.portalId,
      accountId: resolved.accountId,
      patientLabel: resolved.patientLabel,
    };
  }

  const reachable = accessibleProfilesForLogin(login.id).some(
    (p) => p.id === profileId
  );
  if (
    isDemoRestricted(isDemoMode(), login.role) ||
    !reachable ||
    accessForProfile(login.id, login.role, profileId) !== "write"
  ) {
    return jsonError("no write access to that profile", 403);
  }

  try {
    // The append-only event history: this is what Data → Review reads and what the
    // failure badge keys off. recordSyncEvent is best-effort by contract (it never throws
    // into its caller), so a reporting hiccup can't fail an otherwise-good run.
    recordSyncEvent(profileId, PROVIDER, {
      ok: ev.ok,
      received: ev.received,
      written: ev.inserted + ev.updated,
      inserted: ev.inserted,
      updated: ev.updated,
      unchanged: ev.unchanged,
      skipped: ev.skipped,
      error: ev.error,
      // WHICH identity this run was about (#1739). Null for a `profile=<id>` report from
      // a human debugging with curl, and for every other provider's events — the card
      // shows a per-identity line only where there is an identity to show.
      identity,
    });
    // "Last synced" on the card. Only a SUCCESSFUL run advances it — including a
    // nothing-new one, which is the whole point: a quiet check is still a check, and the
    // connection is demonstrably alive. A failed run deliberately leaves the previous
    // timestamp standing so the card shows how long it has actually been since the
    // portal was last read.
    if (ev.ok) {
      // Ensure the connection ROW exists before stamping it. recordSync is an UPDATE, so
      // without this the very first report — and every report for a profile that never
      // ran setup — would silently write nothing and the card would show "Last synced:
      // never" forever while events piled up beside it. A successful push IS the
      // connection for an external-attended integration: there is no OAuth dance or
      // token paste to create the row beforehand, so the first successful run is what
      // marks it connected.
      upsertConnection(profileId, PROVIDER, { status: "connected" });
      recordSync(profileId, PROVIDER, {
        inserted: ev.inserted,
        updated: ev.updated,
        unchanged: ev.unchanged,
      });
    }
    // The ACCOUNT-LEVEL trace (#1756), written for a resolved run too so the card's
    // "this login last reported…" is a fact about the login rather than about whichever
    // profile happens to be active. Deliberately AFTER the write gate: a token that may
    // not write the resolved profile is refused above and stamps nothing.
    if (reportAccount) {
      recordPortalRunReport(reportAccount, {
        ok: ev.ok,
        status,
        message,
        discovered: newlyWaiting,
      });
    }
  } catch (err) {
    // Identifiers only — never the token, never a portal address (there isn't one).
    log.error("sync report failed to record", {
      token: tokenId,
      login: login.id,
      profile: profileId,
      err: err instanceof Error ? err : String(err),
    });
    return jsonError("internal error", 500);
  }

  revalidatePath("/data");
  revalidatePath("/integrations/patient-portals");
  return Response.json({
    ok: true,
    profile: profileId,
    status,
    // How many of the reported labels are NEWLY waiting to be bound. Echoed so a tool can
    // tell its user "3 new patients need mapping in allos" without reading the card —
    // which is only true if the number counts what is NEW. A steady-state run reporting
    // the same three patients forever taught allos nothing, so the field is absent.
    ...(newlyWaiting > 0 ? { discovered: newlyWaiting } : {}),
  });
}
