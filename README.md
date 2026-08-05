<p align="center">
  <img src=".github/allos-logo.svg" alt="Allos" width="240" />
</p>

<h1 align="center">Allos</h1>

<p align="center"><em>allostasis</em> (n.) — the body's way of maintaining stability <em>through</em> change</p>

### Allos is a self-hosted health record, tracker, and coaching app for individuals and families.

Allos brings workouts, sleep, body measurements, medications, symptoms, labs,
appointments, and medical documents into one private timeline. It supports
multiple people without requiring every person to have a login, which makes it
useful for households and caregivers as well as individuals.

Your data lives in your own SQLite database. Most analysis runs locally against
bundled datasets, and AI is optional.

## What can it track?

- **Daily health:** symptoms, mood, sleep, vitals, body measurements, nutrition,
  and wellness practices
- **Training:** strength, cardio, sports, routines, goals, and recovery context
- **Medical history:** conditions, allergies, procedures, immunizations,
  appointments, care plans, and family history
- **Labs and documents:** biomarkers, reference ranges, scans, PDFs, and health
  record imports
- **Medications and supplements:** schedules, dose history, refills, adherence,
  and locally checked interaction warnings
- **Households:** separate profiles, caregiver access, read-only grants, and
  cross-profile views
- **Connected data:** Health Connect, Strava, Oura, Fitbit exports, Withings,
  calendar feeds, and FHIR/CCD-based imports (eg. MyChart)
- **Reminders:** Telegram, Web Push, Home Assistant, and email
- **Portability:** JSON, CSV, FHIR, and uploaded-file exports

See the [full feature tour](docs/features.md) when you need the detailed behavior
and caveats.

## Design principles

1. **Local by default.** Records, rules, charts, imports, and curated reference data stay on the instance. External services are opt-in.
2. **Health is for steering, not scoring.** Allos presents the underlying signals instead of hiding them behind a single invented health score.
3. **Informational, never prescriptive.** Findings explain what was observed and, where relevant, cite a source.
4. **Calm unless safety matters.** Most observations can be dismissed or snoozed; medication safety reminders are treated more carefully.
5. **The person stays in control.** Manual corrections survive syncs, priorities remain user-owned, and data can be exported.

## Quick start with Docker

Docker Compose is the recommended way to run Allos. It starts the web app and a
small scheduler service for notifications and backups.

### 1. Get the project

```bash
git clone https://github.com/FloorLamp/allos.git
cd allos
cp .env.example .env
```

### 2. Set the first admin password

Open `.env` and, at minimum, set these values:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-long-unique-password
DATA_DIR=/absolute/path/outside/the/allos-checkout
```

`ADMIN_USERNAME` is optional and defaults to `admin`. `ADMIN_PASSWORD` is only
used when the first login is created, so set it before the first start.

Choose an absolute `DATA_DIR` outside the repository. It will contain the
database, uploaded medical files, logs, and local backups. If you do not set it,
Compose uses `./data`.

AI is not required. Replace the example `ANTHROPIC_API_KEY` value if you want to
use Anthropic, or remove that line if you do not. A self-hosted,
Anthropic-compatible endpoint can be configured with `AI_BASE_URL`.

### 3. Start Allos

```bash
docker compose up -d --pull always
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the admin
credentials from `.env`. Set `PORT` in `.env` if port 3000 is already in use.

Useful commands:

```bash
docker compose ps
docker compose logs -f allos
docker compose logs -f allos-notify
docker compose down
```

### 4. Finish setup in the app

The first-run flow asks only for information that changes app behavior, such as
timezone, units, and the active person's basic profile. Everything else can be
added later.

For a household, an administrator can create:

- **Profiles** for the people whose health data is tracked
- **Logins** for the people who can sign in
- **Grants** that give a login read/write or read-only access to selected
  profiles

Manage these under **Settings → People & access**.

## Updating

The default Compose file pulls the published image from GitHub Container
Registry:

```bash
docker compose pull
docker compose up -d
```

To pin a particular build instead of using `latest`, set `IMAGE` in `.env`:

```dotenv
IMAGE=ghcr.io/floorlamp/allos:<git-commit-sha>
```

Database migrations run automatically at startup. Read the in-app **What's new**
page after an update for release notes and any operator action.

## Data and backups

Allos stores persistent state under `DATA_DIR`, including:

- `allos.db` — the SQLite database
- `uploads/` — uploaded medical files
- `logs/` — AI and server error logs
- `backups/` — verified database snapshots

The built-in nightly snapshot is useful, but it is on the same volume as the
live database. A disk loss can therefore remove both. For real data, configure
`BACKUP_DEST_DIR` as a second mounted location and verify it from
**Settings → Server → Automated backups**.

The database snapshot does not contain uploaded files. The off-volume backup
feature mirrors them separately. See the [backup and restore
guide](docs/backups.md) before trusting the instance with irreplaceable records.

## Optional services

Allos works without AI, integrations, notifications, or outbound email. Add only
the services you want:

- [AI configuration and privacy](docs/ai.md)
- [Integrations and health record imports](docs/integrations.md)
- [Notifications](docs/notifications.md)
- [Home Assistant notification recipes](docs/home-assistant-notifications.md)
- [API tokens, the document-upload API, and the upload CLI](docs/api-tokens.md)
- [Outbound email](#outbound-email)
- [Public read-only demo mode](docs/demo.md)

External services receive the data required for the feature you enable. Review
the relevant guide before connecting a service, especially when the instance
contains protected health information.

### Outbound email

SMTP carries login invitations, password resets, and — per login, opt-in —
notification email. Configure it under **Settings → Server → Outbound email**
and set the instance's public URL so Allos can build working links. On a new
instance, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and
`SMTP_FROM` can seed the same settings from the environment.

Each person turns notification email on for themselves under **Settings →
Notifications → Email**; reminders go to their account's email address. By
default those emails are content-free ("something needs your attention — open
Allos") so no health details reach the inbox; a person can opt their own
account into full-content emails there, with the trade-off stated on the
control.

## Run from source

### Requirements

- Node.js 24, pinned in `.nvmrc`
- npm
- Native build prerequisites required by `better-sqlite3`

With `nvm` installed:

```bash
nvm install
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Apply the same admin-password and optional-AI notes from the Docker setup when
editing `.env.local`.

The app will be available at
[http://localhost:3000](http://localhost:3000). The SQLite database is created
automatically at `data/allos.db`.

To load several weeks of synthetic sample data:

```bash
npm run seed
```

Do not run the seed command against an instance containing real records.

To build the Docker image locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Development

Common checks:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:e2e
npm run build
```

The test suites are intentionally separate:

- `npm test` runs pure unit tests.
- `npm run test:db` runs SQLite integration and Server Action tests.
- `npm run test:e2e` runs Playwright against isolated seeded databases.

Contributors should read [AGENTS.md](AGENTS.md) for the architecture, data
scoping rules, migration process, and testing conventions. Deeper engineering
notes live under [`docs/internals/`](docs/internals/).

## Technology

- Next.js 16 with the App Router and Server Actions
- React 19 and TypeScript
- SQLite through `better-sqlite3`
- Tailwind CSS and Recharts
- Optional Anthropic-compatible AI

## License

Allos is licensed under the [GNU Affero General Public License
v3.0](LICENSE) (`AGPL-3.0-only`).
