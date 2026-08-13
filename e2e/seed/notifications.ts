// e2e seed fixtures — notifications domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import fs from "node:fs";
import path from "node:path";

import {
  DIGEST_TUNE_PROFILE,
  E2E_LOGIN_DIGEST_TUNE,
  E2E_LOGIN_EMAIL_NOTIFY,
  E2E_LOGIN_HA_NOTIFY,
  E2E_LOGIN_NOTIF_SWEEP,
  E2E_LOGIN_MATRIX_INK,
  E2E_LOGIN_NOTIFY_SCOPE,
  E2E_MEMBER_PASSWORD,
  EMAIL_NOTIFY_PROFILE,
  HA_NOTIFY_PROFILE,
  MATRIX_INK_PROFILE,
  NOTIF_SWEEP_PROFILE,
  NOTIFY_LOG_BUSY_PROFILE,
  NOTIFY_LOG_QUIET_PROFILE,
  NOTIFY_SCOPE_OWN_PROFILE,
  NOTIFY_SCOPE_WARD_PROFILE,
} from "../fixture-logins";
import {
  seedMemberLogin,
  fixtureProfileId,
  memberPasswordHash,
} from "./common";
import { db } from "../../lib/db";

// ── Admin notification opt-in (#2345) ──
export function seedNotifyScope(): void {
  // A dedicated ADMIN login for notify-scope.spec.ts. It has to be an admin — that is
  // the case under test — and it has to be its OWN admin rather than the shared
  // storageState one, because the spec writes the login_profiles rows the fan-out
  // reads: doing that to the storageState admin would enrol every other spec's
  // session as a notification recipient. Reuses the shared member password constant
  // (no new credential-shaped literal in the repo).
  const ownId = fixtureProfileId(NOTIFY_SCOPE_OWN_PROFILE);
  fixtureProfileId(NOTIFY_SCOPE_WARD_PROFILE);
  db.prepare(
    "INSERT OR IGNORE INTO logins (username, password_hash, role) VALUES (?, ?, 'admin')"
  ).run(E2E_LOGIN_NOTIFY_SCOPE, memberPasswordHash());
  const loginId = (
    db
      .prepare("SELECT id FROM logins WHERE username = ?")
      .get(E2E_LOGIN_NOTIFY_SCOPE) as { id: number }
  ).id;
  // The instance's own shape (#2345): the admin holds exactly ONE row, for the
  // profile that is also its own_profile_id — so the ward starts un-opted-in and the
  // own row renders locked-on with its reason. Idempotent for a reused dev server.
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, ownId);
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    ownId,
    loginId
  );
  console.log(
    `e2e: seeded admin notify-scope fixture — ${E2E_LOGIN_NOTIFY_SCOPE} own=${NOTIFY_SCOPE_OWN_PROFILE} (${ownId}), ward=${NOTIFY_SCOPE_WARD_PROFILE} (#2345)`
  );
}

// ── Home Assistant notification config ──
export function seedHaConfig(): void {
  // ── HA notification-config fixture (post-#1025 isolation) ─────────────────────
  // A dedicated adult profile for home-assistant-notify.spec.ts. The spec persists a
  // real (unreachable) HA webhook config; since #1025 the temperature write paths
  // dispatch the red-flag nudge immediately, so that config must never live on a
  // profile other specs log temperatures for (a failed real send would overwrite the
  // GLOBAL delivery-health marker seeded above for notify-delivery-error.spec.ts).
  // No health data needed — the spec reads and writes only notification settings.
  const haNotifyId = fixtureProfileId(HA_NOTIFY_PROFILE);
  seedMemberLogin(E2E_LOGIN_HA_NOTIFY, haNotifyId, "write");
  console.log(
    `e2e: seeded HA notification-config fixture — profile ${haNotifyId} (${HA_NOTIFY_PROFILE})`
  );
}

// ── Morning-digest ⚙️ Tune mirror (#1714) ──
export function seedDigestTune(): void {
  // A dedicated adult profile + login for digest-tune.spec.ts. The spec toggles
  // LOGIN-scoped digest preferences that persist for the worker's whole run, so it
  // must not share a login with any other spec. No health data is needed — the mirror
  // lists every tunable category unconditionally, and what a demotion does to an
  // actual digest is pinned in the pure and DB tiers.
  const id = fixtureProfileId(DIGEST_TUNE_PROFILE);
  seedMemberLogin(E2E_LOGIN_DIGEST_TUNE, id, "write");
  console.log(
    `e2e: seeded digest-tune fixture — profile ${id} (${DIGEST_TUNE_PROFILE})`
  );
}

// ── Email notification channel (#1855) ──
export function seedEmailNotify(): void {
  // A dedicated adult profile + login for email-notify.spec.ts. The channel enable,
  // content mode, and email matrix column are LOGIN-scoped and persist, so the spec
  // must not share a login with any other spec; the spec itself owns the login's
  // logins.email address and resets the global SMTP config it touches. No health
  // data needed — the spec reads and writes only notification settings.
  const id = fixtureProfileId(EMAIL_NOTIFY_PROFILE);
  seedMemberLogin(E2E_LOGIN_EMAIL_NOTIFY, id, "write");
  console.log(
    `e2e: seeded email notification fixture — profile ${id} (${EMAIL_NOTIFY_PROFILE})`
  );
}

// ── Matrix column select-all (#1868 §2) ──
export function seedNotifSweep(): void {
  // A dedicated adult profile + login for the column-sweep cases in
  // settings-ia.spec.ts. One sweep rewrites a whole channel's disabled-kinds blob, so
  // it must not share a login (the Telegram/Push columns are LOGIN-scoped) or a
  // profile (the HA column is profile-scoped) with any other spec. No health data
  // needed — the matrix reads only notification settings.
  const id = fixtureProfileId(NOTIF_SWEEP_PROFILE);
  seedMemberLogin(E2E_LOGIN_NOTIF_SWEEP, id, "write");
  console.log(
    `e2e: seeded notification column-sweep fixture — profile ${id} (${NOTIF_SWEEP_PROFILE})`
  );
}

// ── Matrix column liveness (#2565 part B) ──
export function seedMatrixInk(): void {
  // A dedicated adult profile + login for matrix-column-liveness.spec.ts. The spec
  // configures and un-configures the profile-scoped Home Assistant channel to move one
  // matrix column from not-set-up to set-up, and reads the login-scoped routing ticks
  // across that move — so it can share neither a profile nor a login. Its precondition
  // is an ABSENCE (no HA webhook, so the column starts dead), which it owns: nothing
  // else touches this profile. No health data needed.
  const id = fixtureProfileId(MATRIX_INK_PROFILE);
  seedMemberLogin(E2E_LOGIN_MATRIX_INK, id, "write");
  console.log(
    `e2e: seeded matrix column-liveness fixture — profile ${id} (${MATRIX_INK_PROFILE})`
  );
}

// ── Persisted notify-tick log (#2209) ──
export function seedNotifyTickLog(): void {
  // Writes data/logs/notify.jsonl DIRECTLY, exactly as seedPrelude() does for
  // errors.jsonl and for the same two reasons: the spec should not have to provoke a
  // real scheduler tick, and the file is NOT reset between e2e runs, so a second
  // appended copy would break the spec's strict-mode assertions. WRITE, never append.
  //
  // The shape seeded here is the issue's thesis in miniature:
  //   • a BUSY profile whose run declined things and sent nothing;
  //   • a QUIET profile the tick evaluated and had nothing to say about, which must
  //     still render as a ROW rather than as absence;
  //   • a global "tick started" line, the run's own marker;
  //   • enough filler runs that the pager has two pages and the spec can prove a
  //     filter survives the crossing.
  const busy = fixtureProfileId(NOTIFY_LOG_BUSY_PROFILE);
  const quiet = fixtureProfileId(NOTIFY_LOG_QUIET_PROFILE);

  let seq = 0;
  const line = (o: {
    runId: string;
    profileId: number | null;
    message: string;
    level?: "info" | "warn";
    minute: number;
    decision?: "declined" | "proceeded";
  }) => {
    seq += 1;
    return JSON.stringify({
      id: `e2e-notify-${String(seq).padStart(5, "0")}`,
      // Fixed instants, so the run ordering the spec asserts is deterministic.
      time: `2026-08-05T${String(6 + Math.floor(o.minute / 60)).padStart(2, "0")}:${String(o.minute % 60).padStart(2, "0")}:00.000Z`,
      level: o.level ?? "info",
      scope: "notify",
      runId: o.runId,
      profileId: o.profileId,
      loginId: null,
      message: o.message,
      decision: o.decision,
    });
  };

  const rows: string[] = [];

  // Thirty filler runs for the BUSY profile, each with one decline — enough to push
  // the declines-only view past one page of runs.
  for (let i = 0; i < 30; i++) {
    const runId = `e2e-fill-${String(i).padStart(2, "0")}`;
    rows.push(
      line({ runId, profileId: null, message: "tick started", minute: i * 2 })
    );
    rows.push(
      line({
        runId,
        profileId: busy,
        message: "nothing due",
        minute: i * 2,
      })
    );
    rows.push(
      line({
        runId,
        profileId: busy,
        message: "profile evaluated",
        minute: i * 2,
      })
    );
  }

  // The NEWEST run, which the spec lands on first. It deliberately straddles a
  // minute boundary so the run row also proves the grouping is keyed on the run id
  // rather than on a timestamp bucket.
  const main = "e2e-notify-main";
  rows.push(
    line({ runId: main, profileId: null, message: "tick started", minute: 179 })
  );
  rows.push(
    line({
      runId: main,
      profileId: busy,
      message: "refill nudge skipped: no channel",
      minute: 179,
    })
  );
  rows.push(
    line({
      runId: main,
      profileId: busy,
      message: "no configured channels; nothing sent",
      level: "warn",
      minute: 180,
    })
  );
  rows.push(
    line({
      runId: main,
      profileId: busy,
      message: "profile evaluated",
      minute: 180,
    })
  );
  // The QUIET profile: evaluated, decided nothing. One line, one row.
  rows.push(
    line({
      runId: main,
      profileId: quiet,
      message: "profile evaluated",
      minute: 180,
    })
  );

  const logPath = path.join(process.cwd(), "data", "logs", "notify.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, rows.join("\n") + "\n");
  console.log(
    `e2e: seeded notify tick log — ${rows.length} lines, busy profile ${busy}, quiet profile ${quiet}`
  );
}
