# Running a demo instance

Status: **shipped** · descriptive documentation of current behavior, extracted from the README (#597)

Allos can run as a **public, read-only demo** so people can explore the data model
before self-hosting. Set one env flag and reseed:

```bash
ALLOS_DEMO_MODE=1 npm run seed   # creates the read-only "demo" login + grants
ALLOS_DEMO_MODE=1 npm start      # (or set it in .env for Docker)
```

With `ALLOS_DEMO_MODE=1`:

- The **login page** shows the demo credentials — username `demo`, password `demo`.
- A **persistent, non-dismissible banner** appears on every page: _"Public demo —
  synthetic data — resets nightly — do not enter real health information."_
- The **demo login is a read-only member** (view-only grants, issue #33) to the
  seeded profiles. Every non-admin write is refused at the auth boundary
  (`requireWriteAccess`) even if a grant is misconfigured, and the PHI-entry
  surfaces are trimmed: no change-password, no Telegram/send-test config, and the
  document-upload input is disabled with a hint.
- The shared demo login's **account management is locked** too: password change,
  2FA enrollment, and session revocation are refused server-side
  (`requireLoginWriteAccess`, and hidden in Settings), so one visitor can't lock
  every other visitor out of the demo.
- The **admin login stays fully functional** (for maintaining the instance) and is
  never advertised in the UI. Set a strong `ADMIN_PASSWORD` — it is not read-only.

Same seed, same GHCR image, same boot as a normal deploy — demo mode is presentation
plus a belt-and-braces write block, so the demo doubles as a release smoke test.

### Nightly reset

Return the demo to a pristine state on a schedule with `npm run demo-reset` — it
wipes the live DB (and its `-wal`/`-shm` sidecars), clears `data/uploads`, reseeds a
fresh demo database, and integrity-checks the result. Run it with the app **stopped**
(stop-reset-start), e.g. a host cron:

```bash
# 4am daily: stop, reset, start (adjust to your process manager / compose setup)
0 4 * * *  cd /srv/allos && docker compose stop app && ALLOS_DEMO_MODE=1 npm run demo-reset -- --yes && docker compose start app
```

`demo-reset` **refuses to run unless `ALLOS_DEMO_MODE` is set** (so it can never wipe
a real instance by accident); `--force` overrides that single refusal, `--yes` skips
the confirmation prompt for non-interactive cron.

> **Isolation warning.** A demo instance is destructive by design — the nightly reset
> deletes its entire database and all uploads. **Never co-host a demo with a real
> family instance**, and never point `ALLOS_DEMO_MODE` at a `DATA_DIR` that holds real
> records. Run the demo as its own container with its own volume.
