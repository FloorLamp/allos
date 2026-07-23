import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 104 (issue #1072): move the Telegram delivery CHANNEL from the PROFILE
// (a data subject) to the LOGIN (a person with a phone).
//
// Before: `profile_settings.telegram_chat_id` / `telegram_enabled` /
// `telegram_notify_disabled_kinds` — a per-subject chat. The model's own workaround
// for "a caregiver manages several profiles" was copying ONE chat id across N
// profiles. After: the channel belongs to the login, and a per-profile notification
// fans out to the logins that manage that profile (lib/notifications/fan-out.ts).
//
// This is a FORCED, BEST-EFFORT, NON-DATA-LOSSY data move (a wrong channel is a
// missed notification, recoverable by reconfiguring — never lost health data):
//
//   1. For each login, derive its channel from the chat ids on the profiles it
//      manages (its accessible set — members: granted profiles; admins: all). The
//      MOST-COMMON enabled chat wins (the overwhelming common case — one caregiver,
//      all family profiles → the parent's chat — resolves cleanly). Ties break to
//      the lowest profile id for determinism.
//   2. To PRESERVE delivery without the admin-bypass-all rule the fan-out
//      deliberately drops, ensure the login holds an EXPLICIT login_profiles grant
//      to every profile that CONTRIBUTED its winning chat. For members those grants
//      already exist (that's why the profile is accessible); for an admin with no
//      grants (the single-user bootstrap case) this materializes the exact
//      notification scope it had, so profile 1's reminders keep reaching the admin.
//      This is the issue's "opt specific profiles into their notification scope",
//      applied automatically for continuity. Adding a grant to an admin does NOT
//      change its access (admins already reach every profile) — only its fan-out.
//   3. AMBIGUITY (a login's accessible profiles carry MORE than one distinct enabled
//      chat, so no clean pick) → still assign the most-common chat (delivery dedup
//      prevents spam) AND set a `notify_review_needed` flag so the login is nudged
//      to confirm its settings on next login.
//   4. The old profile_settings telegram keys are read once here, then RETIRED
//      (deleted) — the channel now lives only on the login.
//   5. A one-shot reconciliation report is stored in the global `settings` table
//      (`notify_channel_migration_report`) so nothing moves invisibly.
//
// Idempotent + deterministic: runs exactly once by user_version. It only writes
// login_settings/login_profiles from profile_settings it then deletes, so a replay
// (were it ever forced) finds no source rows and is a no-op. No schema change — all
// values are KV in existing tables — so the non-version-gated migrate() replay stays
// a pure no-op on a current DB.

interface ProfileTelegramRow {
  profile_id: number;
  chat: string;
  enabled: boolean;
  disabledKinds: string;
}

interface ReconEntry {
  loginId: number;
  chat: string;
  ambiguous: boolean;
  distinctChats: number;
}

export function up(db: Database.Database): void {
  // Gather every profile's stored Telegram channel (chat + enabled + disabled-kinds)
  // in one pass. A profile contributes to a login's derivation only when it's
  // enabled with a non-empty chat.
  const chatRows = db
    .prepare(
      "SELECT profile_id, value AS chat FROM profile_settings WHERE key = 'telegram_chat_id'"
    )
    .all() as { profile_id: number; chat: string }[];
  const enabledRows = db
    .prepare(
      "SELECT profile_id, value AS v FROM profile_settings WHERE key = 'telegram_enabled'"
    )
    .all() as { profile_id: number; v: string }[];
  const disabledRows = db
    .prepare(
      "SELECT profile_id, value AS v FROM profile_settings WHERE key = 'telegram_notify_disabled_kinds'"
    )
    .all() as { profile_id: number; v: string }[];

  const enabledBy = new Map<number, boolean>();
  for (const r of enabledRows) enabledBy.set(r.profile_id, r.v === "1");
  const disabledBy = new Map<number, string>();
  for (const r of disabledRows) disabledBy.set(r.profile_id, r.v);

  const byProfile = new Map<number, ProfileTelegramRow>();
  for (const r of chatRows) {
    byProfile.set(r.profile_id, {
      profile_id: r.profile_id,
      chat: (r.chat ?? "").trim(),
      enabled: enabledBy.get(r.profile_id) ?? false,
      disabledKinds: disabledBy.get(r.profile_id) ?? "",
    });
  }

  const logins = db
    .prepare("SELECT id, role FROM logins ORDER BY id")
    .all() as { id: number; role: string }[];
  const allProfileIds = (
    db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]
  ).map((r) => r.id);

  const grantsFor = (loginId: number): number[] =>
    (
      db
        .prepare(
          "SELECT profile_id FROM login_profiles WHERE login_id = ? ORDER BY profile_id"
        )
        .all(loginId) as { profile_id: number }[]
    ).map((r) => r.profile_id);

  const setLogin = db.prepare(
    `INSERT INTO login_settings (login_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(login_id, key) DO UPDATE SET value = excluded.value`
  );
  const ensureGrant = db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')
     ON CONFLICT(login_id, profile_id) DO NOTHING`
  );

  const report: ReconEntry[] = [];

  for (const login of logins) {
    // The profiles this login "manages" for derivation: its accessible set (admins
    // reach all, members their granted ones) — mirrors accessibleProfilesForLogin.
    const accessible =
      login.role === "admin" ? allProfileIds : grantsFor(login.id);

    // Tally enabled, non-empty chats among accessible profiles. Preserve first-seen
    // (lowest profile id) order for a deterministic tie-break.
    const counts = new Map<string, number>();
    const order: string[] = [];
    const disabledForChat = new Map<string, string>();
    for (const pid of accessible) {
      const t = byProfile.get(pid);
      if (!t || !t.enabled || !t.chat) continue;
      if (!counts.has(t.chat)) {
        order.push(t.chat);
        disabledForChat.set(t.chat, t.disabledKinds);
      }
      counts.set(t.chat, (counts.get(t.chat) ?? 0) + 1);
    }
    if (order.length === 0) continue; // no channel to migrate for this login

    // Most-common chat; ties → the first seen (lowest contributing profile id).
    let winner = order[0];
    for (const chat of order) {
      if ((counts.get(chat) ?? 0) > (counts.get(winner) ?? 0)) winner = chat;
    }
    const ambiguous = order.length > 1;

    setLogin.run(login.id, "telegram_chat_id", winner);
    setLogin.run(login.id, "telegram_enabled", "1");
    setLogin.run(
      login.id,
      "telegram_notify_disabled_kinds",
      disabledForChat.get(winner) ?? ""
    );
    if (ambiguous) setLogin.run(login.id, "notify_review_needed", "1");

    // Preserve delivery: grant the login every profile that contributed the winning
    // chat, so the fan-out (grants only, no admin bypass) reaches it for exactly the
    // profiles it was receiving.
    for (const pid of accessible) {
      const t = byProfile.get(pid);
      if (t && t.enabled && t.chat === winner) ensureGrant.run(login.id, pid);
    }

    report.push({
      loginId: login.id,
      chat: winner,
      ambiguous,
      distinctChats: order.length,
    });
  }

  // Retire the old per-profile Telegram keys — the channel now lives on the login.
  db.prepare(
    "DELETE FROM profile_settings WHERE key IN ('telegram_chat_id','telegram_enabled','telegram_notify_disabled_kinds')"
  ).run();

  // One-shot reconciliation report (issue #1072 step 3): a compact, PHI-free summary
  // (login ids + whether each was ambiguous — never the chat id itself in logs) so an
  // admin can see nothing moved invisibly. Chat ids ARE stored in the settings row
  // (needed to audit the move) but that table is gitignored operational data, not a
  // log; the report is capped so a huge instance can't bloat the row.
  const summary = {
    migratedLogins: report.length,
    ambiguousLogins: report.filter((r) => r.ambiguous).map((r) => r.loginId),
    at: new Date().toISOString(),
    entries: report.slice(0, 500),
  };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('notify_channel_migration_report', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(summary));
}

export const migration: Migration = {
  id: 104,
  name: "104-login-notification-channels",
  up,
};
