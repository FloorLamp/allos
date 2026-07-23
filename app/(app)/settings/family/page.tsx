import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { canSendAuthEmail } from "@/lib/auth-email";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import FamilyManager from "./FamilyManager";

export const dynamic = "force-dynamic";

interface ProfileRow {
  id: number;
  name: string;
  photo_path: string | null;
  photo_version: number;
}
interface LoginRow {
  id: number;
  username: string;
  role: "admin" | "member";
  email: string | null;
  // The login's own-profile association (issue #1013), or null (unset). Which
  // profile this login considers "mine" — an association, not an access grant.
  own_profile_id: number | null;
}
export interface ProfileDataSummary {
  activities: number;
  bodyMetrics: number;
  medicalRecords: number;
  documents: number;
}

export default async function FamilySettingsPage() {
  // Login/profile management is admin-only — requireAdmin() redirects a member.
  const { profile } = await requireAdmin();

  const profiles = db
    .prepare(
      "SELECT id, name, photo_path, photo_version FROM profiles ORDER BY id"
    )
    .all() as ProfileRow[];
  const logins = db
    .prepare(
      "SELECT id, username, role, email, own_profile_id FROM logins ORDER BY id"
    )
    .all() as LoginRow[];
  // Whether the instance can send login-lifecycle mail (SMTP + public URL set):
  // gates the invite affordances (the ANTHROPIC_API_KEY / unconfigured precedent).
  const canInvite = canSendAuthEmail();
  // Live-session count per login, for the "signed in on N devices" line + the
  // revoke-all button. Expired rows are excluded to match
  // what getCurrentSession would accept.
  const sessionCountRows = db
    .prepare(
      `SELECT login_id, COUNT(*) AS c FROM sessions
        WHERE expires_at > datetime('now') GROUP BY login_id`
    )
    .all() as { login_id: number; c: number }[];
  const sessionCounts: Record<number, number> = {};
  for (const r of sessionCountRows) sessionCounts[r.login_id] = r.c;
  // Member grants only (admins are implicit-all and shown as such). Each grant
  // carries its access LEVEL (issue #33); `grants` keeps the flat id list the
  // deletion warnings rely on, while `access` maps login → profile → level for
  // the read/write toggle.
  const grantRows = db
    .prepare("SELECT login_id, profile_id, access FROM login_profiles")
    .all() as { login_id: number; profile_id: number; access: string | null }[];
  const grants: Record<number, number[]> = {};
  const access: Record<number, Record<number, "read" | "write">> = {};
  for (const g of grantRows) {
    (grants[g.login_id] ??= []).push(g.profile_id);
    (access[g.login_id] ??= {})[g.profile_id] =
      g.access === "read" ? "read" : "write";
  }

  // A small per-profile data summary, shown in the delete-profile confirmation so
  // the admin sees exactly how much is about to be destroyed. Cheap: a family has
  // few profiles, and each count is an indexed profile_id scan.
  const count = (table: string, profileId: number) =>
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?`)
        .get(profileId) as { c: number }
    ).c;
  const summaries: Record<number, ProfileDataSummary> = {};
  for (const p of profiles) {
    summaries[p.id] = {
      activities: count("activities", p.id),
      bodyMetrics: count("body_metrics", p.id),
      medicalRecords: count("medical_records", p.id),
      documents: count("medical_documents", p.id),
    };
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Family — manage the people you track (profiles) and the logins that can access them. Admins can see every profile; members only the ones you grant."
      />
      <SettingsTabs isAdmin />
      <FamilyManager
        profiles={profiles}
        logins={logins}
        grants={grants}
        access={access}
        summaries={summaries}
        sessionCounts={sessionCounts}
        canInvite={canInvite}
      />
    </div>
  );
}
