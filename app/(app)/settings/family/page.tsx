import { requireAdmin } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { db } from "@/lib/db";
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
}
export interface ProfileDataSummary {
  activities: number;
  bodyMetrics: number;
  medicalRecords: number;
  documents: number;
}

export default function FamilySettingsPage() {
  // Login/profile management is admin-only — requireAdmin() redirects a member.
  const { profile } = requireAdmin();

  const profiles = db
    .prepare(
      "SELECT id, name, photo_path, photo_version FROM profiles ORDER BY id"
    )
    .all() as ProfileRow[];
  const logins = db
    .prepare("SELECT id, username, role FROM logins ORDER BY id")
    .all() as LoginRow[];
  // Live-session count per login, for the "signed in on N devices" line + the
  // revoke-all button (issue #132, Phase C). Expired rows are excluded to match
  // what getCurrentSession would accept.
  const sessionCountRows = db
    .prepare(
      `SELECT login_id, COUNT(*) AS c FROM sessions
        WHERE expires_at > datetime('now') GROUP BY login_id`
    )
    .all() as { login_id: number; c: number }[];
  const sessionCounts: Record<number, number> = {};
  for (const r of sessionCountRows) sessionCounts[r.login_id] = r.c;
  // Member grants only (admins are implicit-all and shown as such).
  const grantRows = db
    .prepare("SELECT login_id, profile_id FROM login_profiles")
    .all() as { login_id: number; profile_id: number }[];
  const grants: Record<number, number[]> = {};
  for (const g of grantRows) {
    (grants[g.login_id] ??= []).push(g.profile_id);
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
      <SettingsTabs isAdmin hideEquipment={isTrainingRestricted(profile.id)} />
      <FamilyManager
        profiles={profiles}
        logins={logins}
        grants={grants}
        summaries={summaries}
        sessionCounts={sessionCounts}
      />
    </div>
  );
}
