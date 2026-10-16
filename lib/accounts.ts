import { getSetting } from "./settings";
import { hoistedStatement } from "./db";
import { createHash } from "node:crypto";
import type { SessionProfile } from "./auth";
import { isRealIsoDate, toUtcInstant } from "./date";
import { listConnectionMetadata } from "./integrations/connections";
import { INTEGRATIONS } from "./integrations/registry";
import { integrationDetailHref } from "./hrefs";
import {
  getIntegrationState,
  getLatestSyncEvent,
  getLastSuccessfulSyncAt,
} from "./queries/integrations";
import type { SourceStanding } from "./integrations/source-state";
import {
  listPortals,
  listPortalAccounts,
  listPortalRunReports,
} from "./portals";
import {
  portalAccountIdsForProfile,
  portalAccountCoverage,
} from "./portal-visibility";

interface Account {
  id: string;
  group: "health";
  sensitive: "medical";
  institution: string;
  service: { name: string };
  person: string;
  connection: "oauth" | "api-key" | "session" | "export" | "device-cloud";
  purpose: string;
  credential: {
    kind: "browser-profile" | "host-file" | "oauth-grant";
    ref: string;
  };
  lastRun: { at: string; outcome: string } | null;
  lastSuccess: { at: string } | null;
  state: "ok" | "failing" | "paused" | "unknown";
  data?: {
    kind: string;
    from?: string;
    to?: string;
    count?: number;
    storedAt: string;
  };
  from?: { backend: "rover"; id: string };
  actions: { kind: "url"; label: string; url: string }[];
}

export function accountsForProfile(
  profileId: number,
  person: string,
  origin: string
): Account[] {
  const base = (id: string, name: string, path: string) => ({
    id,
    group: "health" as const,
    sensitive: "medical" as const,
    institution: name,
    service: { name },
    person,
    purpose: "Collect health records and readings",
    actions: [
      {
        kind: "url" as const,
        label: "Manage",
        url: new URL(path, origin).href,
      },
    ],
  });
  const rows: Account[] = [];
  // Rover login ids are independently configured, never inferred from a person's name.
  let origins: unknown;
  try {
    origins = JSON.parse(getSetting("accounts_rover_origins") || "{}");
  } catch {
    // Optional relay metadata must not hide the account list.
    origins = null;
  }
  const portals = listPortals();
  const reports = listPortalRunReports();
  const bound = new Set(portalAccountIdsForProfile(profileId));
  for (const account of listPortalAccounts().filter((a) => bound.has(a.id))) {
    const portal = portals.find((p) => p.id === account.portalId)!;
    const report = reports.find((r) => r.accountId === account.id);
    const at = toUtcInstant(report?.at);
    // The report is the latest attempt; the profile ledger retains successful history.
    const coverage = portalAccountCoverage(profileId, account.id);
    const successAt =
      toUtcInstant(coverage.lastSuccess) ?? (report?.ok ? at : null);
    const roverId =
      origins && typeof origins === "object"
        ? (origins as Record<string, unknown>)[String(account.id)]
        : undefined;
    rows.push({
      ...(typeof roverId === "string" &&
      /^rover:[a-z0-9][a-z0-9._@-]{0,127}$/.test(roverId)
        ? { from: { backend: "rover" as const, id: roverId } }
        : {}),
      ...base(
        `portal:${account.id}:${profileId}`,
        portal.name,
        "/integrations/patient-portals"
      ),
      connection: "session",
      credential: { kind: "browser-profile", ref: "companion browser profile" },
      lastRun:
        at && report ? { at, outcome: report.ok ? "success" : "failed" } : null,
      lastSuccess: successAt ? { at: successAt } : null,
      ...(coverage.count > 0
        ? {
            data: {
              kind: "documents",
              storedAt: "allos",
              count: coverage.count,
              ...(toUtcInstant(coverage.from)
                ? { from: toUtcInstant(coverage.from)! }
                : {}),
              ...(toUtcInstant(coverage.to)
                ? { to: toUtcInstant(coverage.to)! }
                : {}),
            },
          }
        : {}),
      state: report && at ? (report.ok ? "ok" : "failing") : "unknown",
    });
  }
  for (const c of listConnectionMetadata(profileId)) {
    // This aggregate connection is represented by its individual portal bindings.
    if (c.source_id === "patient-portals") continue;
    const def = INTEGRATIONS.find((d) => d.id === c.source_id);
    const latest = getLatestSyncEvent(profileId, c.source_id);
    const at = toUtcInstant(latest?.at);
    const successAt = toUtcInstant(
      getLastSuccessfulSyncAt(profileId, c.source_id)
    );
    const from = isRealIsoDate(latest?.window_start)
      ? latest.window_start
      : toUtcInstant(latest?.window_start);
    const to = isRealIsoDate(latest?.window_end)
      ? latest.window_end
      : toUtcInstant(latest?.window_end);
    const connection =
      def?.kind === "oauth"
        ? "oauth"
        : def?.kind === "token"
          ? "api-key"
          : def?.kind === "archive" || def?.kind === "feed"
            ? "export"
            : "device-cloud";
    rows.push({
      ...base(
        `integration:${createHash("sha256").update(c.source_id).digest("hex")}:${profileId}`,
        def?.name ?? c.source_id,
        (def && integrationDetailHref(def.id)) || "/integrations"
      ),
      connection,
      credential: {
        kind: connection === "oauth" ? "oauth-grant" : "host-file",
        ref: "allos db integration_connections",
      },
      lastRun:
        at && latest
          ? { at, outcome: latest.ok === 1 ? "success" : "failed" }
          : null,
      lastSuccess: successAt ? { at: successAt } : null,
      // allos's own verdict (lib/integrations/source-state.ts: silence tolerance,
      // flapping), never re-derived from the last event: a source silent past its
      // tolerance is failing here exactly as on its Integrations page.
      state: accountState(
        getIntegrationState(profileId, c.source_id)?.standing ?? null
      ),
      ...(latest &&
      (from || to || (latest.written !== null && latest.written > 0))
        ? {
            data: {
              kind: "readings",
              storedAt: "allos",
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
              ...(latest.written !== null && latest.written > 0
                ? { count: latest.written }
                : {}),
            },
          }
        : {}),
    });
  }
  return rows;
}

const STATE: Record<SourceStanding, Account["state"]> = {
  healthy: "ok",
  partial: "ok",
  intermittent: "ok",
  imported: "ok",
  "feed-enabled": "ok",
  failing: "failing",
  dropping: "failing",
  "needs-reauth": "failing",
  "attempt-failed": "failing",
  "not-connected": "paused",
  "not-set-up": "paused",
  "feed-off": "paused",
  "never-synced": "unknown",
  "never-imported": "unknown",
};
const accountState = (standing: SourceStanding | null): Account["state"] =>
  standing ? STATE[standing] : "unknown";

// The household's `owner`: any admin login's own profile (allos's admin role, as
// /v1/me's `owner`). The same label whichever login asks.
const OWNER_PROFILES_STMT = hoistedStatement(
  "SELECT own_profile_id AS id FROM logins WHERE role = 'admin' AND own_profile_id IS NOT NULL"
);
export function ownerProfileIds(): Set<number> {
  return new Set(
    (OWNER_PROFILES_STMT.all() as { id: number }[]).map((r) => r.id)
  );
}

export function accountPerson(
  profile: SessionProfile,
  owners: Set<number>
): string {
  return owners.has(profile.id) ? "owner" : profile.name.trim().split(/\s+/)[0];
}
