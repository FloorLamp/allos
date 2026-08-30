// Persona seeding (#2594's sibling axis) — SEED_PERSONA selects WHO the seeded
// profile is, where SEED_RNG varies how the baseline character's data is shaped.
//
// The baseline seed is one hand-authored character: a ~40-year-old male
// lifter-with-a-clinic-history. Whole page populations are invisible from that
// one vantage: growth charts render only for a child, the AAP blood-pressure
// percentiles only under 13, fitness norms read differently at 76, a
// twenty-supplement stack stresses /nutrition in ways five never will, and an
// elevated-LDL trend with no diagnosis exercises the flag/Upcoming machinery the
// baseline's statin-managed lipids never trip. Each persona is a coherent
// alternate character for profile 1, targeted at the surfaces its demographics
// and data most affect.
//
// Contracts:
//   - `SEED_PERSONA` unset ⇒ scripts/seed.ts runs the baseline story unchanged
//     (the byte-stable pin `npm run seed`, the e2e template DB, and census
//     `--baseline` diffing rely on). Personas are a seeing-tool feature, never
//     a test tier.
//   - An UNKNOWN name fails the seed loudly (exit 1). A typo must never
//     silently produce a differently-labeled look — the census records the
//     persona name it was asked for, so the data must be that persona or
//     nothing. (SEED_RNG falls back to baseline instead because there the
//     labeled look IS the baseline.)
//   - Personas ignore the SEED_RNG dials: dial hooks live inline in the
//     baseline story and do not apply to persona data. `SEED_RNG` is still
//     recorded by the census harness; a persona run leaves it unset.
//   - Each persona writes profile attributes (name, sex, birthdate) BEFORE its
//     labs and calls reconcileFlags on every medical_records id it inserts, so
//     flags derive from the persona's own age/sex bands exactly like an import.
//   - Birthdates are RELATIVE (daysAgo), so a persona's age never drifts.
//
// This module stays import-pure (type-only imports) so the unit tier can load
// the registry without booting a database; scripts/seed.ts passes the live db
// and lib helpers in through PersonaContext.

import type { Database } from "better-sqlite3";
import type { FitnessEntryInput } from "../lib/fitness-assessment";
import { VIA_IMPORTED, VIA_SEEDED } from "./seed-logged-via";

export interface PersonaContext {
  db: Database;
  profileId: number;
  /** Calendar-string date n days ago (negative = future), profile-local. */
  daysAgo(n: number): string;
  /** Calendar-string arithmetic (lib/date shiftDateStr). */
  shiftDateStr(date: string, days: number): string;
  /** Canonical UTC instant for a wall-clock time on a profile-local day. */
  occurredAt(day: string, hhmm: string): string;
  reconcileFlags(profileId: number, ids: number[]): void;
  saveFitnessEntry(profileId: number, entry: FitnessEntryInput): unknown;
  /**
   * The continuous-glucose trace write core (lib/glucose-trace-db.ts, #2810) —
   * stores the raw points AND recomputes the day's derived `metric_samples` rows,
   * so a persona seeds the two-store shape through the path an ingest would use
   * rather than hand-writing either half.
   */
  recordGlucoseTrace(
    profileId: number,
    rows: readonly { ts: string; mgdl: number }[],
    source: string
  ): unknown;
  /** The standard Overview metric saves every production-created profile gets. */
  seedStandardMetricSaves(profileId: number): void;
  /** The situation change-log helpers (lib/trend-annotations, lib/symptom-episode). */
  diffSituations(before: string[], after: string[], date: string): unknown[];
  serializeSituationEvents(
    prior: readonly never[],
    events: readonly unknown[]
  ): string;
  episodesForSituation(
    name: string,
    events: readonly unknown[],
    includeOpen: boolean
  ): readonly { start: string | null; end: string | null }[];
  /** Serialized COMPLETE onboarding state for the given path + focuses. */
  onboardingStateJson(
    profilePath: "self" | "caregiving",
    focuses: readonly string[]
  ): string;
}

export interface SeedPersona {
  /** The SEED_PERSONA env value. Kebab-case, unique. */
  name: string;
  /** Short human label for logs and the census audit header. */
  title: string;
  /** One line on what this persona exists to surface. */
  description: string;
  /**
   * UX_ROUTES targets: the routes this persona most affects, as census prefix
   * filters. The walkthrough skill doc tells a persona run to pass these.
   */
  routes: readonly string[];
  /** Known app gaps the persona is designed to make visible, if any. */
  gaps?: readonly string[];
  /** Stable semantic candidate ids expected on, or absent from, the dashboard. */
  dashboard: {
    expect: readonly string[];
    absent: readonly string[];
  };
  apply(ctx: PersonaContext): void;
}

// ── Shared writers ───────────────────────────────────────────────────────────
// Column lists mirror scripts/seed.ts exactly; a schema change breaks both the
// same way and the db-tier smoke test catches it.

function setAttrs(
  ctx: PersonaContext,
  attrs: {
    name: string;
    sex: "male" | "female";
    birthdate: string;
    extra?: Record<string, string>;
  }
): void {
  ctx.db
    .prepare(`UPDATE profiles SET name = ? WHERE id = ?`)
    .run(attrs.name, ctx.profileId);
  const set = ctx.db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  set.run(ctx.profileId, "sex", attrs.sex);
  set.run(ctx.profileId, "birthdate", attrs.birthdate);
  for (const [k, v] of Object.entries(attrs.extra ?? {})) {
    set.run(ctx.profileId, k, v);
  }
}

function completeOnboarding(
  ctx: PersonaContext,
  profilePath: "self" | "caregiving",
  focuses: readonly string[]
): void {
  ctx.db
    .prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'onboarding_state', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(ctx.profileId, ctx.onboardingStateJson(profilePath, focuses));
}

// Biomarker/vitals writer collecting ids for reconcileFlags. Same shape as the
// baseline PANELS insert, plus optional occurred_at for timed readings.
interface RecordWriter {
  rec(
    day: string,
    category: "lab" | "vitals" | "scan",
    canonical: string,
    value: number,
    unit: string | null,
    ref: string | null,
    opts?: { panel?: string | null; time?: string; name?: string }
  ): number;
  ids: number[];
}

function recordWriter(ctx: PersonaContext): RecordWriter {
  const ins = ctx.db.prepare(
    // `source` is bound to the literal "manual" below, so this is a person's own
    // entry rather than an import — see scripts/seed-logged-via.ts.
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, reference_range,
        value_num, canonical_name, panel, source, occurred_at, logged_via)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ${VIA_SEEDED})`
  );
  const ids: number[] = [];
  return {
    ids,
    rec(day, category, canonical, value, unit, ref, opts = {}) {
      const id = Number(
        ins.run(
          ctx.profileId,
          day,
          category,
          opts.name ?? canonical,
          String(value),
          unit,
          ref,
          value,
          canonical,
          opts.panel ?? null,
          "manual",
          opts.time ? ctx.occurredAt(day, opts.time) : null
        ).lastInsertRowid
      );
      ids.push(id);
      return id;
    },
  };
}

function bodyMetric(
  ctx: PersonaContext,
  day: string,
  weightKg: number | null,
  bodyFatPct: number | null,
  restingHr: number | null
): void {
  ctx.db
    .prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr, notes, logged_via)
       VALUES (?,?,?,?,?,NULL, ${VIA_SEEDED})`
    )
    .run(ctx.profileId, day, weightKg, bodyFatPct, restingHr);
}

function metricPoint(
  ctx: PersonaContext,
  metric: string,
  day: string,
  value: number,
  time = "00:00:00"
): void {
  const ts = `${day}T${time}`;
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)`
    )
    .run(ctx.profileId, metric, day, ts, ts, value);
}

function strengthSession(
  ctx: PersonaContext,
  day: string,
  title: string,
  lifts: [exercise: string, weightKg: number, reps: number[]][]
): void {
  const activityId = Number(
    ctx.db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, notes, duration_min, distance_km, intensity, logged_via)
         VALUES (?,?,?,?,NULL,?,NULL,?, ${VIA_SEEDED})`
      )
      .run(ctx.profileId, day, "strength", title, 70, "hard").lastInsertRowid
  );
  const insSet = ctx.db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps) VALUES (?,?,?,?,?)`
  );
  for (const [exercise, weightKg, reps] of lifts) {
    reps.forEach((r, i) =>
      insSet.run(activityId, exercise, i + 1, weightKg || null, r)
    );
  }
}

function cardioSession(
  ctx: PersonaContext,
  day: string,
  name: string,
  title: string,
  durationMin: number,
  distanceKm: number | null,
  intensity: "easy" | "moderate" | "hard",
  equipmentId?: number
): void {
  const components = JSON.stringify([
    {
      name,
      type: "cardio",
      distance_km: distanceKm,
      duration_min: durationMin,
    },
  ]);
  const id = Number(
    ctx.db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, notes, duration_min, distance_km, intensity, components, logged_via)
         VALUES (?,?,?,?,NULL,?,?,?,?, ${VIA_SEEDED})`
      )
      .run(
        ctx.profileId,
        day,
        "cardio",
        title,
        durationMin,
        distanceKm,
        intensity,
        components
      ).lastInsertRowid
  );
  if (equipmentId) {
    ctx.db
      .prepare(`UPDATE activities SET equipment_id = ? WHERE id = ?`)
      .run(equipmentId, id);
  }
}

interface IntakeWriter {
  supplement(s: {
    name: string;
    obligation?: "must" | "should" | "may";
    condition?: string;
    brand?: string | null;
    stack?: string | null;
    notes?: string | null;
    doses: [amount: string, time: string | null, food: string][];
  }): number;
  medication(m: {
    name: string;
    notes?: string | null;
    obligation?: "must" | "should" | "may";
    prescriber?: string | null;
    rxcui?: string | null;
    startedDaysAgo: number;
    courseNotes?: string | null;
    doses: [amount: string, time: string | null, food: string][];
  }): number;
}

function intakeWriter(ctx: PersonaContext): IntakeWriter {
  const supIns = ctx.db.prepare(
    `INSERT INTO intake_items
       (profile_id, name, notes, condition, obligation, brand, product, situation, stack)
     VALUES (?,?,?,?,?,?,NULL,NULL,?)`
  );
  // rx mirrors the add-medication form's fallback (intake-actions.ts):
  // a prescriber-bearing med is a prescription, everything else is OTC.
  const medIns = ctx.db.prepare(
    `INSERT INTO intake_items
       (profile_id, name, notes, condition, obligation, kind, prescriber, rx, active)
     VALUES (?,?,?,'daily',?,'medication',?,?,1)`
  );
  const doseIns = ctx.db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?,?,?,?,?)`
  );
  const courseIns = ctx.db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
     VALUES (?,?,NULL,NULL,?)`
  );
  return {
    supplement(s) {
      const id = Number(
        supIns.run(
          ctx.profileId,
          s.name,
          s.notes ?? null,
          s.condition ?? "daily",
          s.obligation ?? "should",
          s.brand ?? null,
          s.stack ?? null
        ).lastInsertRowid
      );
      s.doses.forEach(([amount, time, food], i) =>
        doseIns.run(id, amount, time, food, i)
      );
      return id;
    },
    medication(m) {
      const id = Number(
        medIns.run(
          ctx.profileId,
          m.name,
          m.notes ?? null,
          m.obligation ?? "should",
          m.prescriber ?? null,
          m.prescriber ? 1 : 0
        ).lastInsertRowid
      );
      if (m.rxcui) {
        ctx.db
          .prepare(`UPDATE intake_items SET rxcui = ? WHERE id = ?`)
          .run(m.rxcui, id);
      }
      m.doses.forEach(([amount, time, food], i) =>
        doseIns.run(id, amount, time, food, i)
      );
      courseIns.run(id, ctx.daysAgo(m.startedDaysAgo), m.courseNotes ?? null);
      return id;
    },
  };
}

// Deterministic adherence: log most doses for the last 6 days, with a fixed
// miss pattern so adherence surfaces show a realistic, reproducible gap.
function logAdherence(ctx: PersonaContext): void {
  const doses = ctx.db
    .prepare(
      `SELECT d.id, d.item_id, d.amount FROM intake_item_doses d
         JOIN intake_items i ON i.id = d.item_id
       WHERE i.profile_id = ?`
    )
    .all(ctx.profileId) as {
    id: number;
    item_id: number;
    amount: string | null;
  }[];
  // Amount is snapshotted like the real confirm path (adherence.ts) does, so
  // the dose-history ledger shows what was taken instead of "—".
  const log = ctx.db.prepare(
    `INSERT OR IGNORE INTO intake_item_logs (dose_id, item_id, date, amount, status, logged_via)
     VALUES (?,?,?,?,'taken', ${VIA_SEEDED})`
  );
  for (let d = 6; d >= 1; d--) {
    for (const row of doses) {
      if ((row.id + d) % 5 === 0) continue; // ~80% adherence, deterministic
      log.run(row.id, row.item_id, ctx.daysAgo(d), row.amount);
    }
  }
}

function condition(
  ctx: PersonaContext,
  name: string,
  code: string,
  onset: string,
  notes: string | null = null
): number {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO conditions (profile_id, name, code, code_system, status, onset_date, resolved_date, notes)
         VALUES (?,?,?,'ICD-10','active',?,NULL,?)`
      )
      .run(ctx.profileId, name, code, onset, notes).lastInsertRowid
  );
}

function immunization(
  ctx: PersonaContext,
  date: string,
  vaccine: string,
  doseLabel: string | null
): void {
  ctx.db
    .prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, notes, source)
       VALUES (?,?,?,?,NULL,NULL)`
    )
    .run(ctx.profileId, date, vaccine, doseLabel);
}

function appointment(
  ctx: PersonaContext,
  date: string,
  time: string | null,
  title: string,
  location: string | null,
  status: "scheduled" | "completed"
): void {
  ctx.db
    .prepare(
      `INSERT INTO appointments (profile_id, date, time_of_day, provider_id, title, location, notes, status)
       VALUES (?,?,?,NULL,?,?,NULL,?)`
    )
    .run(ctx.profileId, date, time, title, location, status);
}

function encounter(
  ctx: PersonaContext,
  date: string,
  reason: string,
  diagnoses: string | null
): void {
  ctx.db
    .prepare(
      `INSERT INTO encounters (profile_id, date, end_date, type, class_code, reason, diagnoses, provider_id, location_provider_id, notes)
       VALUES (?,?,NULL,'Office Visit','AMB',?,?,NULL,NULL,NULL)`
    )
    .run(ctx.profileId, date, reason, diagnoses);
}

function familyHistory(
  ctx: PersonaContext,
  rows: [
    relation: string,
    cond: string,
    code: string,
    onsetAge: number | null,
    deceased: 0 | 1,
  ][]
): void {
  const ins = ctx.db.prepare(
    `INSERT INTO family_history (profile_id, relation, condition, code, code_system, onset_age, deceased, notes)
     VALUES (?,?,?,?,'SNOMED CT',?,?,NULL)`
  );
  for (const [relation, cond, code, onsetAge, deceased] of rows) {
    ins.run(ctx.profileId, relation, cond, code, onsetAge, deceased);
  }
}

// A cloned context targeting another profile — every writer below reads
// ctx.profileId, so household members reuse the same helpers unchanged.
function forProfile(ctx: PersonaContext, profileId: number): PersonaContext {
  return { ...ctx, profileId };
}

// A household member, created the way the baseline seed creates the child
// profile: raw insert + the standard metric saves production createProfile
// would have written, then attributes. Returns a context for the new profile.
function addFamilyProfile(
  ctx: PersonaContext,
  attrs: { name: string; sex: "male" | "female"; birthdate: string }
): PersonaContext {
  const id = Number(
    ctx.db.prepare(`INSERT INTO profiles (name) VALUES (?)`).run(attrs.name)
      .lastInsertRowid
  );
  ctx.seedStandardMetricSaves(id);
  const sub = forProfile(ctx, id);
  setAttrs(sub, attrs);
  return sub;
}

// An ACTIVE illness for the profile, wired the way the baseline seeds its
// episode cluster: an illness-type situation row (active), the dated
// change-log in profile_settings.situation_events, the illness_episodes rows
// a 046→169 replay would reconstruct, day-by-day symptoms, and an optional
// fever curve whose readings flag via reconcileFlags like real imports.
function activeIllness(
  ctx: PersonaContext,
  opts: {
    startedDaysAgo: number;
    symptoms: [ago: number, symptom: string, severity: number][];
    feverCurve?: [ago: number, hhmm: string, degF: number][];
  }
): void {
  const transitions = [
    { date: ctx.daysAgo(opts.startedDaysAgo), before: [], after: ["Illness"] },
  ];
  const events = transitions.flatMap((t) =>
    ctx.diffSituations(t.before, t.after, t.date)
  );
  const situationId = Number(
    ctx.db
      .prepare(
        `INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)`
      )
      .run(ctx.profileId).lastInsertRowid
  );
  void situationId;
  ctx.db
    .prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'situation_events', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(ctx.profileId, ctx.serializeSituationEvents([], events));
  for (const run of ctx.episodesForSituation("Illness", events, true)) {
    if (run.start == null) continue; // a startless run can't seed a row
    ctx.db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(
        ctx.profileId,
        run.start,
        run.end == null ? null : ctx.shiftDateStr(run.end, -1)
      );
  }
  const sym = ctx.db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note, logged_via)
     VALUES (?, ?, ?, ?, NULL, ${VIA_SEEDED})
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  for (const [ago, symptom, severity] of opts.symptoms) {
    sym.run(ctx.profileId, ctx.daysAgo(ago), symptom, severity);
  }
  if (opts.feverCurve?.length) {
    const w = recordWriter(ctx);
    for (const [ago, hhmm, degF] of opts.feverCurve) {
      w.rec(
        ctx.daysAgo(ago),
        "vitals",
        "Body Temperature",
        degF,
        "degF",
        null,
        {
          time: hhmm,
        }
      );
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);
  }
}

// A completed document import, the baseline import-log shape: no blob on disk
// (content_hash pre-set so the boot backfill skips it), optionally re-pointing
// existing records at the document so /import shows a real breakdown.
function addDocument(
  ctx: PersonaContext,
  opts: {
    filename: string;
    docType: string;
    dateDaysAgo: number;
    hashSeed: string; // unique 4-char suffix for the synthetic content hash
    linkCategory?: "lab" | "vitals";
    linkDate?: string;
  }
): number {
  const day = ctx.daysAgo(opts.dateDaysAgo);
  const docId = Number(
    ctx.db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, mime_type, size_bytes, doc_type, source,
            document_date, patient_name, extraction_status, extracted_count, content_hash, uploaded_at)
         VALUES (?,?,?,'application/pdf',?, ?, 'upload', ?, NULL, 'done', 0, ?, ?)`
      )
      .run(
        ctx.profileId,
        opts.filename,
        `data/uploads/medical/${ctx.profileId}/seed-${opts.filename}`,
        120000 + opts.filename.length * 517,
        opts.docType,
        day,
        `seed${"0".repeat(56)}${opts.hashSeed}`,
        ctx.occurredAt(day, "08:30")
      ).lastInsertRowid
  );
  if (opts.linkCategory) {
    const linked = ctx.db
      .prepare(
        // `logged_via` moves with `source` — see the twin in scripts/seed.ts and the
        // exception stated in scripts/seed-logged-via.ts. A row retro-attached to a
        // document was not tapped by anybody.
        `UPDATE medical_records
            SET document_id = ?, source = 'extracted', logged_via = ${VIA_IMPORTED}
         WHERE profile_id = ? AND date = ? AND category = ?`
      )
      .run(docId, ctx.profileId, opts.linkDate ?? day, opts.linkCategory);
    ctx.db
      .prepare(
        `UPDATE medical_documents SET extracted_count = ? WHERE id = ? AND profile_id = ?`
      )
      .run(linked.changes, docId, ctx.profileId);
  }
  return docId;
}

// A connected integration. Status only — config carries a display-ish stub and
// NO credentials, so the sync tick degrades gracefully (documented behavior)
// while /integrations and hasConnectedDataSource read "connected".
function connectIntegration(
  ctx: PersonaContext,
  sourceId: "strava" | "health-connect" | "oura" | "withings",
  config: Record<string, unknown> = {}
): void {
  ctx.db
    .prepare(
      `INSERT INTO integration_connections (profile_id, source_id, status, config)
       VALUES (?, ?, 'connected', ?)
       ON CONFLICT(profile_id, source_id) DO UPDATE SET
         status = excluded.status, config = excluded.config`
    )
    .run(ctx.profileId, sourceId, JSON.stringify(config));
}

// A provider-imported cardio session carrying source + external_id (and the
// Strava-only rich metrics when given), so provenance chips, source filters,
// and cross-source dedup surfaces have real subjects.
function sourcedCardio(
  ctx: PersonaContext,
  opts: {
    source: "strava" | "health-connect";
    externalId: string;
    day: string;
    name: string;
    title: string;
    durationMin: number;
    distanceKm: number;
    startHhmm: string;
    endHhmm: string;
    activeKcal?: number;
    strava?: { avgHr: number; maxHr: number; elevationM: number };
  }
): number {
  const id = Number(
    ctx.db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, distance_km,
            start_time, end_time, components, source, external_id,
            avg_hr, max_hr, elevation_m, edited, logged_via)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0, ${VIA_IMPORTED})`
      )
      .run(
        ctx.profileId,
        opts.day,
        "cardio",
        opts.title,
        opts.durationMin,
        opts.distanceKm,
        opts.startHhmm,
        opts.endHhmm,
        opts.source === "strava"
          ? JSON.stringify([
              {
                name: opts.name,
                type: "cardio",
                distance_km: opts.distanceKm,
                duration_min: opts.durationMin,
              },
            ])
          : null,
        opts.source,
        opts.externalId,
        opts.strava?.avgHr ?? null,
        opts.strava?.maxHr ?? null,
        opts.strava?.elevationM ?? null
      ).lastInsertRowid
  );
  if (opts.activeKcal != null) {
    ctx.db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, started_at, ended_at, value, activity_external_id)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        ctx.profileId,
        opts.source,
        "active_kcal",
        opts.day,
        ctx.occurredAt(opts.day, opts.startHhmm),
        ctx.occurredAt(opts.day, opts.endHhmm),
        opts.activeKcal,
        opts.externalId
      );
  }
  return id;
}

// An Oura night: total + stage breakdown + HRV keyed on the bedtime window,
// and the night's resting HR as an oura-sourced body_metrics row — the
// mapOuraSleep shape (lib/integrations/oura.ts).
function ouraNight(
  ctx: PersonaContext,
  wakeDay: string,
  opts: {
    totalMin: number;
    deep: number;
    rem: number;
    hrv: number;
    rhr: number;
  }
): void {
  const bedDay = ctx.shiftDateStr(wakeDay, -1);
  const start = ctx.occurredAt(bedDay, "23:05");
  const end = ctx.occurredAt(wakeDay, "06:50");
  const ins = ctx.db.prepare(
    `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'oura', ?, ?, ?, ?, ?)`
  );
  const light = Math.max(0, opts.totalMin - opts.deep - opts.rem);
  ins.run(ctx.profileId, "sleep_min", wakeDay, start, end, opts.totalMin);
  ins.run(ctx.profileId, "sleep_deep_min", wakeDay, start, end, opts.deep);
  ins.run(ctx.profileId, "sleep_rem_min", wakeDay, start, end, opts.rem);
  ins.run(ctx.profileId, "sleep_light_min", wakeDay, start, end, light);
  ins.run(ctx.profileId, "sleep_awake_min", wakeDay, start, end, 18);
  ins.run(ctx.profileId, "hrv_ms", wakeDay, start, end, opts.hrv);
  ctx.db
    .prepare(
      `INSERT INTO body_metrics (profile_id, date, resting_hr, source, occurred_at, logged_via)
       VALUES (?,?,?,'oura',?, ${VIA_IMPORTED})`
    )
    .run(ctx.profileId, wakeDay, opts.rhr, end);
}

// A Withings weigh-in: weight + body-fat on body_metrics plus the
// body-composition point samples the sync writes (lib/integrations/withings.ts).
function withingsWeighIn(
  ctx: PersonaContext,
  day: string,
  opts: { kg: number; fatPct: number; muscleKg: number; waterKg: number }
): void {
  const at = ctx.occurredAt(day, "07:05");
  ctx.db
    .prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, source, occurred_at, logged_via)
       VALUES (?,?,?,?,'withings',?, ${VIA_IMPORTED})`
    )
    .run(ctx.profileId, day, opts.kg, opts.fatPct, at);
  const ins = ctx.db.prepare(
    `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'withings', ?, ?, ?, ?, ?)`
  );
  ins.run(ctx.profileId, "muscle_mass_kg", day, at, at, opts.muscleKg);
  ins.run(ctx.profileId, "body_water_kg", day, at, at, opts.waterKg);
}

// ── The personas ─────────────────────────────────────────────────────────────

const bodybuilder: SeedPersona = {
  name: "bodybuilder",
  title: "Marcus, 28 — competitive bodybuilder",
  description:
    "Heavy 4-day split, big lifts, strength standards near the top bands, " +
    "high-protein macros, performance supplements, mass-gain goals.",
  routes: [
    "/training",
    "/progress",
    "/trends",
    "/nutrition",
    "/longevity",
    "/results/clinical-results",
  ],
  dashboard: {
    expect: ["checkin.mood", "nutrition.protein"],
    absent: ["cycle.control"],
  },
  apply(ctx) {
    setAttrs(ctx, {
      name: "Marcus",
      sex: "male",
      birthdate: ctx.daysAgo(28 * 365 + 40),
    });

    // 20 weeks, 4 sessions/week, progressive overload near advanced standards.
    const ramp = (base: number, week: number, perWeek: number) =>
      Math.round((base + week * perWeek) * 2) / 2;
    for (let w = 19; w >= 0; w--) {
      const done = 19 - w;
      strengthSession(ctx, ctx.daysAgo(w * 7 + 6), "Push day", [
        ["Barbell Bench Press", ramp(100, done, 0.6), [5, 5, 5]],
        ["Incline Bench Press", ramp(80, done, 0.5), [8, 8, 7]],
        ["Barbell Overhead Press", ramp(60, done, 0.25), [6, 6, 5]],
        ["Tricep Pushdown", ramp(35, done, 0.25), [12, 12, 10]],
      ]);
      strengthSession(ctx, ctx.daysAgo(w * 7 + 4), "Pull day", [
        ["Deadlift", ramp(180, done, 1.0), [3, 3, 3]],
        ["Barbell Row", ramp(90, done, 0.5), [8, 8, 8]],
        ["Pull Up", 0, [12, 10, 9]],
        ["Dumbbell Curl", ramp(18, done, 0.1), [12, 10, 10]],
      ]);
      strengthSession(ctx, ctx.daysAgo(w * 7 + 2), "Leg day", [
        ["Back Squat", ramp(140, done, 1.0), [5, 5, 5]],
        ["Romanian Deadlift", ramp(110, done, 0.75), [8, 8, 8]],
        ["Leg Press", ramp(220, done, 2.0), [10, 10, 10]],
        ["Calf Raise", ramp(90, done, 0.5), [15, 15, 15]],
      ]);
      strengthSession(ctx, ctx.daysAgo(w * 7 + 1), "Upper accessories", [
        ["Incline Bench Press", ramp(75, done, 0.5), [10, 10, 9]],
        ["Dumbbell Lateral Raise", ramp(12, done, 0.1), [15, 15, 15]],
        ["Face Pull", ramp(25, done, 0.25), [15, 15, 15]],
      ]);
      // Lean-bulk weigh-ins: mass trending UP (the baseline always cuts).
      bodyMetric(
        ctx,
        ctx.daysAgo(w * 7 + 3),
        Math.round((96 + done * 0.18) * 10) / 10,
        Math.round((12.5 + done * 0.03) * 10) / 10,
        61
      );
    }

    const goal = ctx.db.prepare(
      `INSERT INTO goals (profile_id, title, status, exercise, metric,
         target_weight_kg, target_reps, target_sets, target_duration_sec, target_date)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
    );
    goal.run(
      ctx.profileId,
      "Bench 140 kg",
      "Barbell Bench Press",
      "weight",
      140,
      null,
      null,
      null,
      ctx.daysAgo(-120)
    );
    goal.run(
      ctx.profileId,
      "Squat 180 kg",
      "Back Squat",
      "weight",
      180,
      null,
      null,
      null,
      ctx.daysAgo(-150)
    );
    goal.run(
      ctx.profileId,
      "Deadlift 220 kg",
      "Deadlift",
      "weight",
      220,
      null,
      null,
      null,
      ctx.daysAgo(-180)
    );
    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, category, target_value, body_metric, baseline_value, target_date, status)
         VALUES (?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "Bulk to 102 kg",
        "body",
        102,
        "weight",
        96,
        ctx.daysAgo(-120)
      );

    const freq = ctx.db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week) VALUES (?,?,?,?)`
    );
    freq.run(ctx.profileId, "type", "strength", 4);
    freq.run(ctx.profileId, "group", "Upper", 3);
    freq.run(ctx.profileId, "group", "Lower", 1);

    const intake = intakeWriter(ctx);
    intake.supplement({
      name: "Creatine Monohydrate",
      obligation: "must",
      doses: [["10 g", "Anytime", "any"]],
    });
    intake.supplement({
      name: "Whey Protein",
      brand: "Optimum Nutrition",
      condition: "post_workout",
      doses: [["60 g", "Anytime", "any"]],
    });
    intake.supplement({
      name: "Vitamin D3",
      doses: [["2000 IU", "Morning", "with_fat"]],
    });
    intake.supplement({
      name: "Omega-3",
      doses: [["1200 mg", "Evening", "with_fat"]],
    });
    intake.supplement({
      name: "ZMA",
      notes: "Zinc + magnesium before bed",
      doses: [["1 serving", "Before sleep", "empty_stomach"]],
    });
    logAdherence(ctx);

    // High-protein macros for the nutrition chart (~2.2 g/kg).
    const macro = ctx.db.prepare(
      `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)`
    );
    for (let d = 21; d >= 0; d--) {
      const date = ctx.daysAgo(d);
      const j = (d * 7) % 13;
      // The full-day window shape the Health Connect macro ingest writes.
      const dayStart = `${date}T00:00:00Z`;
      const dayEnd = `${date}T23:59:00Z`;
      macro.run(ctx.profileId, "protein_g", date, dayStart, dayEnd, 205 + j);
      macro.run(ctx.profileId, "carbs_g", date, dayStart, dayEnd, 380 + j * 2);
      macro.run(ctx.profileId, "fat_g", date, dayStart, dayEnd, 95 + (j % 7));
      macro.run(ctx.profileId, "fiber_g", date, dayStart, dayEnd, 28 + (j % 5));
    }

    // Bloods a heavy lifter actually shows: creatine-inflated creatinine, a
    // training-suppressed HDL, mildly raised ALT — flags that invite the
    // "is this pathology or training?" reading.
    const w = recordWriter(ctx);
    for (const [ago, panel] of [
      [370, "LabCorp"],
      [25, "LabCorp"],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(
        day,
        "lab",
        "Testosterone, Total",
        ago > 100 ? 640 : 705,
        "ng/dL",
        "300-1000",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Creatinine",
        ago > 100 ? 1.25 : 1.38,
        "mg/dL",
        "0.7-1.3",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Alanine Aminotransferase (ALT)",
        ago > 100 ? 38 : 52,
        "U/L",
        "7-56",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "HDL Cholesterol",
        ago > 100 ? 41 : 37,
        "mg/dL",
        ">40",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "LDL Cholesterol",
        ago > 100 ? 118 : 126,
        "mg/dL",
        "<100",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "High-Sensitivity C-Reactive Protein (hs-CRP)",
        ago > 100 ? 0.9 : 1.4,
        "mg/L",
        "<3",
        { panel }
      );
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);

    for (const [ago, s] of [
      [
        80,
        {
          vo2: 44,
          grip: 60,
          pushups: 50,
          plank: 140,
          bodyfat: 12.8,
          restinghr: 62,
        },
      ],
      [
        5,
        {
          vo2: 45,
          grip: 63,
          pushups: 55,
          plank: 150,
          bodyfat: 13.1,
          restinghr: 61,
        },
      ],
    ] as const) {
      const date = ctx.daysAgo(ago);
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "vo2max",
        value: s.vo2,
        rawInput: { method: "watch", watchValue: s.vo2 },
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "grip",
        value: s.grip,
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "pushups",
        value: s.pushups,
        reps: s.pushups,
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "plank",
        value: s.plank,
        durationSec: s.plank,
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "bodyfat",
        value: s.bodyfat,
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "restinghr",
        value: s.restinghr,
      });
    }

    completeOnboarding(ctx, "self", ["fitness"]);
  },
};

const marathonRunner: SeedPersona = {
  name: "marathon-runner",
  title: "Elena, 34 — marathon runner with Strava + Health Connect",
  description:
    "High weekly running volume with a long-run progression, an active " +
    "marathon plan, athlete-range vitals (RHR 43), runner's low ferritin, " +
    "tracked shoes, cycle data — and BOTH Strava and Health Connect " +
    "connected, with recent runs arriving Strava-sourced and one of them " +
    "ALSO pushed by Health Connect (the phone re-syncing the same Strava " +
    "session), so cross-source provenance and duplicate handling have a " +
    "live subject.",
  routes: [
    "/training",
    "/trends",
    "/longevity",
    "/equipment",
    "/results/clinical-results",
    "/upcoming",
    "/medical/cycles",
    "/integrations",
    "/data",
  ],
  dashboard: {
    expect: ["checkin.mood", "activity.steps"],
    absent: ["weight.bootstrap"],
  },
  apply(ctx) {
    setAttrs(ctx, {
      name: "Elena",
      sex: "female",
      birthdate: ctx.daysAgo(34 * 365 + 200),
    });

    const shoes = ctx.db.prepare(
      `INSERT INTO equipment (profile_id, name, weight_kg, category) VALUES (?,?,NULL,'Shoes')`
    );
    const daily = Number(
      shoes.run(ctx.profileId, "Pegasus 41 (daily trainer)").lastInsertRowid
    );
    const racers = Number(
      shoes.run(ctx.profileId, "Vaporfly 3 (race day)").lastInsertRowid
    );

    // 18-week block, 4 runs/week: long run building 16 → 32 km, a tempo, an
    // interval session, an easy run. Long runs alternate onto the race shoes.
    for (let wk = 17; wk >= 0; wk--) {
      const done = 17 - wk;
      const longKm = Math.min(32, 16 + done);
      cardioSession(
        ctx,
        ctx.daysAgo(wk * 7),
        "Running",
        "Long run",
        Math.round(longKm * 6.2),
        longKm,
        "moderate",
        done % 2 === 0 ? racers : daily
      );
      cardioSession(
        ctx,
        ctx.daysAgo(wk * 7 + 2),
        "Running",
        "Tempo run",
        45,
        10,
        "hard",
        daily
      );
      cardioSession(
        ctx,
        ctx.daysAgo(wk * 7 + 4),
        "Running",
        "Track intervals",
        40,
        8,
        "hard",
        daily
      );
      cardioSession(
        ctx,
        ctx.daysAgo(wk * 7 + 5),
        "Running",
        "Easy run",
        40,
        7,
        "easy",
        daily
      );
      bodyMetric(
        ctx,
        ctx.daysAgo(wk * 7 + 1),
        Math.round((56.5 - done * 0.03) * 10) / 10,
        18,
        46 - Math.floor(done / 6)
      );
    }

    ctx.db
      .prepare(
        `INSERT INTO endurance_plans
           (profile_id, event_name, discipline, event_date, target_distance_km, target_time_sec, status)
         VALUES (?, ?, 'run', ?, 42.2, 13500, 'active')`
      )
      .run(ctx.profileId, "Coastal City Marathon", ctx.daysAgo(-42));

    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, description, category, target_value, current_value, unit, target_date, status)
         VALUES (?,?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "Marathon under 3:45",
        "Goal race pace 5:20/km",
        "cardio",
        42.2,
        32,
        "km",
        ctx.daysAgo(-42)
      );
    ctx.db
      .prepare(
        `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week) VALUES (?,?,?,?)`
      )
      .run(ctx.profileId, "type", "cardio", 4);

    // Cycles: regular, so the phase-aware reference ranges have a subject.
    const cycle = ctx.db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow, note) VALUES (?,?,?,?,NULL)`
    );
    for (const [startAgo, endAgo] of [
      [95, 91],
      [67, 63],
      [39, 35],
      [11, 7],
    ] as const) {
      cycle.run(
        ctx.profileId,
        ctx.daysAgo(startAgo),
        ctx.daysAgo(endAgo),
        "medium"
      );
    }

    // Runner bloods: ferritin sliding into deficiency while hemoglobin still
    // holds — the classic pattern the flag + retest machinery should surface.
    const w = recordWriter(ctx);
    for (const [ago, panel, ferritin, hgb] of [
      [210, "Quest Diagnostics", 24, 12.8],
      [20, "Quest Diagnostics", 13, 12.1],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(day, "lab", "Ferritin", ferritin, "ng/mL", "16-154", { panel });
      w.rec(day, "lab", "Hemoglobin", hgb, "g/dL", "12.0-15.5", { panel });
      w.rec(
        day,
        "lab",
        "Thyroid-Stimulating Hormone (TSH)",
        1.9,
        "mIU/L",
        "0.4-4.5",
        { panel }
      );
      w.rec(day, "lab", "Vitamin D, 25-Hydroxy", 31, "ng/mL", "30-100", {
        panel,
      });
    }
    w.rec(ctx.daysAgo(15), "scan", "VO2 Max", 54, "mL/kg/min", null);
    ctx.reconcileFlags(ctx.profileId, w.ids);

    const intake = intakeWriter(ctx);
    intake.supplement({
      name: "Iron",
      obligation: "must",
      notes: "Ferritin low — take with vitamin C, away from coffee",
      doses: [["36 mg", "Morning", "empty_stomach"]],
    });
    intake.supplement({
      name: "Vitamin D3",
      doses: [["2000 IU", "Morning", "with_fat"]],
    });
    logAdherence(ctx);

    for (const [ago, vo2, rhr] of [
      [100, 52, 45],
      [4, 54, 43],
    ] as const) {
      const date = ctx.daysAgo(ago);
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "vo2max",
        value: vo2,
        rawInput: { method: "watch", watchValue: vo2 },
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "restinghr",
        value: rhr,
      });
      ctx.saveFitnessEntry(ctx.profileId, {
        date,
        testKey: "plank",
        value: 95,
        durationSec: 95,
      });
    }

    // Connected sources: Strava (the watch uploads there) and Health Connect
    // (the phone). Credential-less config — the sync tick degrades gracefully
    // while the /integrations cards and hasConnectedDataSource read connected.
    connectIntegration(ctx, "strava", { athlete: "Elena R." });
    connectIntegration(ctx, "health-connect", {});

    // This week's runs arrive Strava-sourced with rich metrics…
    const tempoDay = ctx.daysAgo(1);
    sourcedCardio(ctx, {
      source: "strava",
      externalId: "strava:seed-elena-tempo",
      day: tempoDay,
      name: "Running",
      title: "Tempo run",
      durationMin: 44,
      distanceKm: 10.1,
      startHhmm: "06:30",
      endHhmm: "07:14",
      activeKcal: 612,
      strava: { avgHr: 168, maxHr: 181, elevationM: 55 },
    });
    const longRunDay = ctx.daysAgo(6);
    sourcedCardio(ctx, {
      source: "strava",
      externalId: "strava:seed-elena-long",
      day: longRunDay,
      name: "Running",
      title: "Long run",
      durationMin: 176,
      distanceKm: 29.0,
      startHhmm: "07:00",
      endHhmm: "09:56",
      activeKcal: 1740,
      strava: { avgHr: 156, maxHr: 172, elevationM: 190 },
    });
    // …and Health Connect ALSO pushed the long run (the phone mirroring the
    // Strava session): same window, different provider + external id — the
    // cross-source duplicate shape the census should show being handled
    // (or not) by the activity surfaces.
    sourcedCardio(ctx, {
      source: "health-connect",
      externalId: `health-connect:${ctx.occurredAt(longRunDay, "07:00")}`,
      day: longRunDay,
      name: "Running",
      title: "Morning run",
      durationMin: 176,
      distanceKm: 29.0,
      startHhmm: "07:00",
      endHhmm: "09:56",
      activeKcal: 1731,
    });

    completeOnboarding(ctx, "self", ["fitness"]);
  },
};

// Dave, 40 — the average-adult-with-rising-LDL character. Seeds profile
// attributes + data but NOT onboarding (the owning persona completes that).
function seedDaveMidlife(ctx: PersonaContext): void {
  {
    setAttrs(ctx, {
      name: "Dave",
      sex: "male",
      birthdate: ctx.daysAgo(40 * 365 + 100),
    });

    // The "means to start running again" pattern: a handful of walks.
    for (const ago of [52, 38, 24, 17, 3]) {
      cardioSession(
        ctx,
        ctx.daysAgo(ago),
        "Walking",
        "Evening walk",
        30,
        2.4,
        "easy"
      );
    }
    for (let m = 7; m >= 0; m--) {
      bodyMetric(
        ctx,
        ctx.daysAgo(m * 30 + 2),
        Math.round((89.5 - m * 0.2) * 10) / 10,
        27,
        68
      );
    }

    // Three annual draws: LDL 138 → 152 → 168, total and triglycerides
    // following, HDL flat-low, glucose creeping prediabetic. Untreated.
    const w = recordWriter(ctx);
    const draws: [
      number,
      string,
      number,
      number,
      number,
      number,
      number,
      number,
    ][] = [
      // ago, panel, ldl, total, hdl, trig, fastingGlucose, a1c
      [740, "Quest Diagnostics", 138, 214, 44, 150, 96, 5.5],
      [385, "LabCorp", 152, 229, 42, 168, 99, 5.6],
      [28, "Quest Diagnostics", 168, 246, 41, 186, 103, 5.8],
    ];
    for (const [ago, panel, ldl, total, hdl, trig, glu, a1c] of draws) {
      const day = ctx.daysAgo(ago);
      w.rec(day, "lab", "LDL Cholesterol", ldl, "mg/dL", "<100", { panel });
      w.rec(day, "lab", "Total Cholesterol", total, "mg/dL", "<200", { panel });
      w.rec(day, "lab", "HDL Cholesterol", hdl, "mg/dL", ">40", { panel });
      w.rec(day, "lab", "Triglycerides", trig, "mg/dL", "<150", { panel });
      w.rec(day, "lab", "Glucose, Fasting", glu, "mg/dL", "65-99", { panel });
      w.rec(day, "lab", "Hemoglobin A1c", a1c, "%", "<5.7", { panel });
    }
    w.rec(
      ctx.daysAgo(28),
      "lab",
      "Vitamin D, 25-Hydroxy",
      24,
      "ng/mL",
      "30-100",
      { panel: "Quest Diagnostics" }
    );
    // A few home BP readings hovering at stage-1.
    for (const [ago, sys, dia] of [
      [40, 128, 84],
      [12, 134, 86],
      [2, 131, 85],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(day, "vitals", "Blood Pressure Systolic", sys, "mmHg", "90-120", {
        time: "08:00",
      });
      w.rec(day, "vitals", "Blood Pressure Diastolic", dia, "mmHg", "60-80", {
        time: "08:00",
      });
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);

    // The risk-stratification input: a genetic father with an early MI.
    familyHistory(ctx, [
      ["Father", "Coronary artery disease", "53741008", 56, 1],
      ["Mother", "Type 2 diabetes", "44054006", 61, 0],
    ]);

    immunization(ctx, "2016-08-10", "tdap", "Booster");
    immunization(ctx, ctx.daysAgo(420), "influenza", "Last season");
    appointment(
      ctx,
      ctx.daysAgo(-18),
      "09:00",
      "Annual physical",
      "Downtown Primary Care",
      "scheduled"
    );
    encounter(ctx, ctx.daysAgo(385), "Annual physical", null);

    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, category, target_value, body_metric, baseline_value, target_date, status)
         VALUES (?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "Get back under 85 kg",
        "body",
        85,
        "weight",
        89.5,
        ctx.daysAgo(-180)
      );
  }
}

// A ~22-month-old's data (growth track, immunization series, pediatric labs,
// well-child visits). Attributes come from the caller (addFamilyProfile);
// `kgOffset` separates the twins so their curves don't coincide.
function seedToddlerData(
  ctx: PersonaContext,
  opts: { kgOffset: number }
): void {
  {
    const birth = ctx.daysAgo(670); // ~22 months

    // Well-child measurement history: ~40th percentile track.
    const measurements: [
      agoDays: number,
      kg: number,
      cm: number,
      head: number,
    ][] = [
      [610, 4.9, 55.5, 38.2], // 2 mo
      [550, 6.2, 60.0, 40.3], // 4 mo
      [490, 7.2, 64.1, 42.0], // 6 mo
      [400, 8.2, 69.0, 43.9], // 9 mo
      [305, 9.0, 73.5, 45.1], // 12 mo
      [215, 9.7, 77.2, 46.0], // 15 mo
      [120, 10.4, 80.6, 46.7], // 18 mo
      [5, 11.2, 84.3, 47.3], // ~22 mo
    ];
    for (const [ago, kg, cm, head] of measurements) {
      const day = ctx.daysAgo(ago);
      ctx.db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, notes, logged_via) VALUES (?,?,?,?, ${VIA_SEEDED})`
        )
        .run(
          ctx.profileId,
          day,
          Math.round((kg + opts.kgOffset) * 10) / 10,
          "Well-child visit"
        );
      metricPoint(ctx, "height_cm", day, cm + opts.kgOffset * 2);
      metricPoint(ctx, "head_circumference_cm", day, head);
    }

    // Immunization series through the 18-month visit; influenza current.
    const at = (days: number) => ctx.daysAgo(670 - days);
    immunization(ctx, birth, "hepb", "Dose 1");
    for (const [days, label] of [
      [61, "Dose 1"],
      [122, "Dose 2"],
      [183, "Dose 3"],
      [458, "Dose 4"],
    ] as const) {
      immunization(ctx, at(days), "dtap", label);
    }
    for (const [days, label] of [
      [61, "Dose 1"],
      [122, "Dose 2"],
      [183, "Dose 3"],
    ] as const) {
      immunization(ctx, at(days), "hib", label);
      immunization(ctx, at(days), "pcv", label);
      immunization(ctx, at(days), "ipv", label);
    }
    immunization(ctx, at(61), "rv", "Dose 1");
    immunization(ctx, at(122), "rv", "Dose 2");
    immunization(ctx, at(61), "hepb", "Dose 2");
    immunization(ctx, at(183), "hepb", "Dose 3");
    immunization(ctx, at(370), "mmr", "Dose 1");
    immunization(ctx, at(370), "varicella", "Dose 1");
    immunization(ctx, at(370), "hepa", "Dose 1");
    immunization(ctx, ctx.daysAgo(60), "influenza", "This season");

    // Pediatric labs: values that are NORMAL for age but would flag on adult
    // bands — the age-band machinery's canonical demo — plus a lead screen and
    // a BP pair for the AAP age/sex/height percentile card.
    const w = recordWriter(ctx);
    const labDay = ctx.daysAgo(305);
    w.rec(labDay, "lab", "Hemoglobin", 11.8, "g/dL", "10.5-13.5", {
      panel: "Children's Clinic",
    });
    w.rec(labDay, "lab", "Alkaline Phosphatase", 260, "U/L", "40-129", {
      panel: "Children's Clinic",
    });
    w.rec(labDay, "lab", "Lead", 2, "µg/dL", "<3.5", {
      panel: "Children's Clinic",
    });
    w.rec(
      ctx.daysAgo(5),
      "vitals",
      "Blood Pressure Systolic",
      98,
      "mmHg",
      "90-120",
      { time: "10:00" }
    );
    w.rec(
      ctx.daysAgo(5),
      "vitals",
      "Blood Pressure Diastolic",
      54,
      "mmHg",
      "60-80",
      { time: "10:00" }
    );
    ctx.reconcileFlags(ctx.profileId, w.ids);

    for (const [ago, reason] of [
      [400, "9-month well-child visit"],
      [305, "12-month well-child visit"],
      [215, "15-month well-child visit"],
      [120, "18-month well-child visit"],
    ] as const) {
      encounter(ctx, ctx.daysAgo(ago), reason, null);
    }
    appointment(
      ctx,
      ctx.daysAgo(-40),
      "10:30",
      "24-month well-child visit",
      "Children's Clinic",
      "scheduled"
    );
  }
}

// Margaret, 76 — the chronic-conditions senior. Attributes come from the
// caller (addFamilyProfile); seeds conditions, the six-med stack, labs,
// vitals, immunizations, appointments, and elderly-band fitness results.
function seedMargaretSenior(ctx: PersonaContext): void {
  {
    condition(
      ctx,
      "Type 2 diabetes mellitus",
      "E11.9",
      "2013-05-20",
      "Diet + metformin"
    );
    condition(ctx, "Essential hypertension", "I10", "2009-02-11", null);
    condition(
      ctx,
      "Atrial fibrillation",
      "I48.91",
      "2021-09-30",
      "On warfarin"
    );
    condition(
      ctx,
      "Chronic kidney disease, stage 3a",
      "N18.31",
      "2023-01-17",
      "eGFR trending down"
    );
    condition(ctx, "Osteoporosis", "M81.0", "2019-11-02", null);

    const intake = intakeWriter(ctx);
    intake.medication({
      name: "Metformin",
      notes: "With meals",
      prescriber: "Dr. Chen",
      startedDaysAgo: 2400,
      doses: [
        ["500 mg", "Morning", "with_food"],
        ["500 mg", "Evening", "with_food"],
      ],
    });
    intake.medication({
      name: "Warfarin",
      notes: "Anticoagulation for AFib — keep vitamin K intake consistent",
      prescriber: "Dr. Chen",
      rxcui: "11289",
      startedDaysAgo: 1000,
      doses: [["2.5 mg", "Evening", "any"]],
    });
    intake.medication({
      name: "Lisinopril",
      prescriber: "Dr. Chen",
      startedDaysAgo: 2000,
      doses: [["20 mg", "Morning", "any"]],
    });
    intake.medication({
      name: "Atorvastatin",
      prescriber: "Dr. Chen",
      startedDaysAgo: 1800,
      doses: [["40 mg", "Evening", "any"]],
    });
    intake.medication({
      name: "Omeprazole",
      notes: "Reflux",
      prescriber: "Dr. Chen",
      startedDaysAgo: 700,
      doses: [["20 mg", "Morning", "before_meal"]],
    });
    // The realistic danger: an OTC NSAID beside warfarin — the app should
    // surface the major bleeding-risk interaction.
    intake.medication({
      name: "Ibuprofen",
      notes: "OTC — knee pain",
      obligation: "may",
      startedDaysAgo: 90,
      doses: [["200 mg", "Anytime", "with_food"]],
    });
    intake.supplement({
      name: "Calcium",
      doses: [["600 mg", "Midday", "with_food"]],
    });
    intake.supplement({
      name: "Vitamin D3",
      doses: [["1000 IU", "Morning", "with_fat"]],
    });
    logAdherence(ctx);

    // Labs: the CKD/diabetes monitoring picture — eGFR falling, potassium
    // rising on an ACE inhibitor, A1c improving but above target, mild anemia.
    const w = recordWriter(ctx);
    const seniorDraws: [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ][] = [
      // ago, creat, egfr, potassium, a1c, fastingGlucose, hgb
      [540, 1.3, 52, 4.7, 7.9, 152, 12.4],
      [180, 1.4, 48, 4.9, 7.5, 144, 12.1],
      [18, 1.5, 44, 5.3, 7.2, 138, 11.7],
    ];
    for (const [ago, creat, egfr, k, a1c, glu, hgb] of seniorDraws) {
      const day = ctx.daysAgo(ago);
      const panel = "LabCorp";
      w.rec(day, "lab", "Creatinine", creat, "mg/dL", "0.6-1.1", { panel });
      w.rec(
        day,
        "lab",
        "Estimated Glomerular Filtration Rate (eGFR)",
        egfr,
        "mL/min/1.73m²",
        ">60",
        { panel }
      );
      w.rec(day, "lab", "Potassium", k, "mmol/L", "3.5-5.0", { panel });
      w.rec(day, "lab", "Hemoglobin A1c", a1c, "%", "<5.7", { panel });
      w.rec(day, "lab", "Glucose, Fasting", glu, "mg/dL", "65-99", { panel });
      w.rec(day, "lab", "Hemoglobin", hgb, "g/dL", "12.0-15.5", { panel });
    }
    w.rec(ctx.daysAgo(18), "lab", "LDL Cholesterol", 84, "mg/dL", "<100", {
      panel: "LabCorp",
    });
    // Home BP: hovering above control.
    for (const [ago, sys, dia] of [
      [20, 148, 84],
      [13, 152, 86],
      [8, 144, 82],
      [3, 149, 85],
      [1, 146, 83],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(day, "vitals", "Blood Pressure Systolic", sys, "mmHg", "90-120", {
        time: "09:00",
      });
      w.rec(day, "vitals", "Blood Pressure Diastolic", dia, "mmHg", "60-80", {
        time: "09:00",
      });
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);

    for (let m = 5; m >= 0; m--) {
      bodyMetric(
        ctx,
        ctx.daysAgo(m * 30 + 4),
        Math.round((63.5 + m * 0.1) * 10) / 10,
        null,
        72
      );
    }

    ctx.db
      .prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, severity, status, onset_date, notes)
         VALUES (?,?,?,?,?,NULL,NULL)`
      )
      .run(ctx.profileId, "Sulfa drugs", "Rash", "moderate", "active");

    immunization(ctx, ctx.daysAgo(220), "influenza", "Last season");
    immunization(ctx, "2021-04-12", "zoster", "Dose 2");
    immunization(ctx, ctx.daysAgo(500), "covid", "Booster");
    immunization(ctx, "2013-06-01", "tdap", "Booster"); // 12+ years — due

    appointment(
      ctx,
      ctx.daysAgo(9),
      null,
      "INR check",
      "Anticoag Clinic",
      "scheduled"
    ); // Overdue band
    appointment(
      ctx,
      ctx.daysAgo(-11),
      "11:15",
      "Cardiology follow-up",
      "Heart Center",
      "scheduled"
    );
    appointment(
      ctx,
      ctx.daysAgo(-30),
      null,
      "Diabetes annual review",
      "Endocrinology",
      "scheduled"
    );
    encounter(
      ctx,
      ctx.daysAgo(180),
      "Diabetes follow-up",
      "Type 2 diabetes mellitus; Chronic kidney disease"
    );
    encounter(
      ctx,
      ctx.daysAgo(540),
      "Annual wellness visit",
      "Essential hypertension"
    );

    familyHistory(ctx, [["Sister", "Osteoporosis", "64859006", 70, 0]]);

    // Elderly-band fitness: numbers that read fine only against the 75+ norms.
    const date = ctx.daysAgo(12);
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "chairstand",
      value: 9,
    });
    ctx.saveFitnessEntry(ctx.profileId, { date, testKey: "grip", value: 19 });
    ctx.saveFitnessEntry(ctx.profileId, { date, testKey: "balance", value: 7 });
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "restinghr",
      value: 72,
    });
  }
}

const household: SeedPersona = {
  name: "household",
  title: "The Reyes household — Dave, 40; Margaret, 76; sick twin toddlers",
  description:
    "One caregiver login over four profiles: Dave (rising LDL, profile 1), " +
    "his mother Margaret (six meds, T2D + AFib + CKD 3), and 22-month-old " +
    "Dave and twins Riley and Rowan who are currently sick — active illness " +
    "episodes, day-by-day symptoms, and a fever curve. Stresses the " +
    "household roll-ups, cross-profile timeline/calendar, family settings, " +
    "and every multi-profile merge surface the solo personas can't reach.",
  routes: [
    "/",
    "/household",
    "/upcoming",
    "/history",
    "/settings/family",
    "/medications",
    "/records",
    "/trends",
    "/medical/episodes",
  ],
  gaps: [
    "The pages census drives only the acting profile (profile 1, Dave) — " +
      "the members' own pages need an acting-profile switch the harness's " +
      "profiles journey does not yet parameterize.",
  ],
  dashboard: {
    expect: [
      "checkin.mood",
      "attention.fact:mental-health:crisis:",
      "illness.state:",
      "workout.live:",
    ],
    absent: ["cycle.control"],
  },
  apply(ctx) {
    seedDaveMidlife(ctx);
    activeIllness(ctx, {
      startedDaysAgo: 1,
      symptoms: [
        [1, "fatigue", 2],
        [0, "cough", 2],
      ],
    });
    ctx.db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, logged_via)
         VALUES (?, ?, 'instrument', 'PHQ-9', '24', 24, NULL, 'PHQ-9', ${VIA_SEEDED})`
      )
      .run(ctx.profileId, ctx.daysAgo(0));
    const workoutDay = ctx.daysAgo(0);
    ctx.db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            created_at, updated_at, logged_via)
         VALUES (?, ?, 'strength', 'Lunch workout', '12:30', NULL, NULL, ?, ?, ${VIA_SEEDED})`
      )
      .run(
        ctx.profileId,
        workoutDay,
        ctx.occurredAt(workoutDay, "12:30"),
        ctx.occurredAt(workoutDay, "12:30")
      );

    const margaret = addFamilyProfile(ctx, {
      name: "Margaret",
      sex: "female",
      birthdate: ctx.daysAgo(76 * 365 + 150),
    });
    seedMargaretSenior(margaret);

    // Twin toddlers — same birthdate, curves separated by a small offset,
    // both currently sick. Riley runs the fever (day 3 of it — past the
    // "more than 3 days" illness-care line); Rowan is a day behind and milder.
    const riley = addFamilyProfile(ctx, {
      name: "Riley",
      sex: "female",
      birthdate: ctx.daysAgo(670),
    });
    seedToddlerData(riley, { kgOffset: 0 });
    activeIllness(riley, {
      startedDaysAgo: 3,
      symptoms: [
        [3, "fever", 2],
        [3, "runny_nose", 2],
        [2, "fever", 3],
        [2, "cough", 2],
        [1, "fever", 2],
        [1, "cough", 2],
        [0, "fever", 2],
      ],
      feverCurve: [
        [2, "08:00", 101.3],
        [2, "20:00", 102.6],
        [1, "08:30", 101.0],
        [0, "07:45", 100.4],
      ],
    });
    const rowan = addFamilyProfile(ctx, {
      name: "Rowan",
      sex: "male",
      birthdate: ctx.daysAgo(670),
    });
    seedToddlerData(rowan, { kgOffset: 0.4 });
    activeIllness(rowan, {
      startedDaysAgo: 2,
      symptoms: [
        [2, "runny_nose", 2],
        [1, "cough", 1],
        [1, "runny_nose", 2],
        [0, "cough", 2],
      ],
    });

    completeOnboarding(ctx, "self", ["caregiving", "preventive-care"]);
  },
};

const pregnant: SeedPersona = {
  name: "pregnant",
  title: "Sofia, 31 — pregnant (~20 weeks), with a 15-year-old",
  description:
    "Declared pregnancy risk attribute, a cycle history that stops at the " +
    "LMP, gestational weight gain, prenatal labs with a flagged 50 g glucose " +
    "screen needing follow-up, prenatal supplements, OB visit cadence, a " +
    "PHQ-9 score, obstetric ultrasounds, carrier-screening genomic variants " +
    "— and Maya, a 15-year-old on the pediatric/adult boundary (CDC growth " +
    "curves still apply, adult BP regime already does, HPV series mid-course).",
  routes: [
    "/",
    "/upcoming",
    "/medical/cycles",
    "/results",
    "/trends",
    "/nutrition",
    "/appointments",
    "/records",
    "/household",
  ],
  gaps: [
    "Pregnancy is only a risk-attribute flag plus a condition row — no " +
      "gestational-age model, so nothing renders weeks-pregnant or trimester " +
      "context anywhere (#1402).",
    "No perinatal instrument (EPDS): PHQ-9 is the only depression screen the " +
      "instrument flow offers a pregnant user.",
  ],
  dashboard: {
    expect: ["checkin.mood", "cycle.control"],
    absent: ["weight.bootstrap"],
  },
  apply(ctx) {
    setAttrs(ctx, {
      name: "Sofia",
      sex: "female",
      birthdate: ctx.daysAgo(31 * 365 + 60),
      extra: { risk_pregnant: "1", reproductive_status: "premenopausal" },
    });

    condition(
      ctx,
      "Pregnant state",
      "Z33.1",
      ctx.daysAgo(100),
      "EDD in ~20 weeks"
    );

    // Regular cycles that STOP at the last menstrual period ~20 weeks ago —
    // the cycle surface's "very long current cycle" look.
    const cycle = ctx.db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow, note) VALUES (?,?,?,?,NULL)`
    );
    for (const [startAgo, endAgo] of [
      [252, 248],
      [224, 220],
      [196, 192],
      [168, 164],
      [140, 136], // LMP
    ] as const) {
      cycle.run(
        ctx.profileId,
        ctx.daysAgo(startAgo),
        ctx.daysAgo(endAgo),
        "medium"
      );
    }

    // Gestational weight gain from a 62 kg baseline.
    for (const [ago, kg] of [
      [140, 62.0],
      [110, 62.4],
      [80, 63.2],
      [50, 64.5],
      [20, 66.0],
      [2, 67.1],
    ] as const) {
      bodyMetric(ctx, ctx.daysAgo(ago), kg, null, 64);
    }

    // Prenatal labs: first-trimester panel + the 50 g glucose screen that
    // flags high and needs the 3-hour follow-up — the Upcoming story.
    const w = recordWriter(ctx);
    const firstPanel = ctx.daysAgo(90);
    w.rec(firstPanel, "lab", "Hemoglobin", 11.4, "g/dL", "12.0-15.5", {
      panel: "OB Panel",
    });
    w.rec(firstPanel, "lab", "Ferritin", 21, "ng/mL", "16-154", {
      panel: "OB Panel",
    });
    w.rec(
      firstPanel,
      "lab",
      "Thyroid-Stimulating Hormone (TSH)",
      1.7,
      "mIU/L",
      "0.4-4.5",
      { panel: "OB Panel" }
    );
    w.rec(firstPanel, "lab", "Vitamin D, 25-Hydroxy", 27, "ng/mL", "30-100", {
      panel: "OB Panel",
    });
    w.rec(
      ctx.daysAgo(8),
      "lab",
      "Glucose, Gestational Screen (50 g)",
      148,
      "mg/dL",
      "<140",
      { panel: "OB Panel" }
    );
    // Monthly BP — pregnancy-normal.
    for (const [ago, sys, dia] of [
      [100, 104, 64],
      [70, 102, 63],
      [40, 106, 66],
      [10, 108, 67],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(day, "vitals", "Blood Pressure Systolic", sys, "mmHg", "90-120", {
        time: "14:00",
      });
      w.rec(day, "vitals", "Blood Pressure Diastolic", dia, "mmHg", "60-80", {
        time: "14:00",
      });
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);

    const intake = intakeWriter(ctx);
    intake.supplement({
      name: "Prenatal Multivitamin",
      obligation: "must",
      brand: "Ritual",
      doses: [["1 capsule", "Morning", "with_food"]],
    });
    intake.supplement({
      name: "Folate",
      obligation: "must",
      doses: [["800 mcg", "Morning", "with_food"]],
    });
    intake.supplement({
      name: "Iron",
      notes: "Hemoglobin borderline",
      doses: [["27 mg", "Midday", "empty_stomach"]],
    });
    intake.supplement({
      name: "Omega-3",
      notes: "DHA for pregnancy",
      doses: [["600 mg", "Evening", "with_fat"]],
    });
    logAdherence(ctx);

    immunization(ctx, ctx.daysAgo(70), "influenza", "This season");
    immunization(ctx, "2015-03-20", "tdap", "Booster"); // due again IN pregnancy

    appointment(
      ctx,
      ctx.daysAgo(2),
      "13:30",
      "Anatomy scan",
      "Maternal-Fetal Medicine",
      "completed"
    );
    appointment(
      ctx,
      ctx.daysAgo(-6),
      "10:00",
      "3-hour glucose tolerance test",
      "OB Lab",
      "scheduled"
    );
    appointment(
      ctx,
      ctx.daysAgo(-24),
      "09:30",
      "Prenatal visit",
      "Westside OB-GYN",
      "scheduled"
    );
    for (const [ago, reason] of [
      [100, "Initial prenatal visit"],
      [60, "Prenatal visit"],
      [25, "Prenatal visit"],
    ] as const) {
      encounter(ctx, ctx.daysAgo(ago), reason, "Pregnant state");
    }

    // A PHQ-9 screen (mild range) with its per-item answers — the instrument
    // shape (#1076): score row on category 'instrument' + instrument_responses.
    {
      const phq = ctx.db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, logged_via)
           VALUES (?, ?, 'instrument', 'PHQ-9', '7', 7, NULL, 'PHQ-9', ${VIA_SEEDED})`
        )
        .run(ctx.profileId, ctx.daysAgo(25));
      const answers = ctx.db.prepare(
        `INSERT INTO instrument_responses (profile_id, medical_record_id, item_index, answer)
         VALUES (?, ?, ?, ?)`
      );
      [1, 1, 1, 1, 1, 1, 1, 0, 0].forEach((answer, itemIndex) =>
        answers.run(
          ctx.profileId,
          Number(phq.lastInsertRowid),
          itemIndex,
          answer
        )
      );
    }

    // Obstetric ultrasounds: the dating scan and the completed anatomy scan.
    const usIns = ctx.db.prepare(
      `INSERT INTO imaging_studies
         (profile_id, modality, body_region, laterality, contrast, contrast_agent,
          study_date, impression, indication, status, notes, source)
       VALUES (?,?,?,'na',0,NULL,?,?,?,'final',NULL,NULL)`
    );
    usIns.run(
      ctx.profileId,
      "ultrasound",
      "Obstetric",
      ctx.daysAgo(95),
      "Single intrauterine pregnancy. Crown-rump length consistent with dates.",
      "Dating scan"
    );
    usIns.run(
      ctx.profileId,
      "ultrasound",
      "Obstetric",
      ctx.daysAgo(2),
      "Normal anatomy survey. Anterior placenta, normal amniotic fluid.",
      "Anatomy scan (~20 weeks)"
    );

    // Carrier screening — structured genomic variants, stored factually.
    const gvIns = ctx.db.prepare(
      `INSERT INTO genomic_variants
         (profile_id, gene, variant, genotype, star_allele, zygosity, significance,
          result_type, interpretation, source_lab, report_date, notes, source)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,?,NULL,NULL)`
    );
    gvIns.run(
      ctx.profileId,
      "CFTR",
      "deltaF508",
      null,
      "heterozygous",
      null,
      "hereditary-risk",
      "Carrier — partner screening recommended",
      "Example Genomics Lab",
      ctx.daysAgo(80)
    );
    gvIns.run(
      ctx.profileId,
      "MTHFR",
      "C677T",
      null,
      "heterozygous",
      null,
      "other",
      null,
      "Example Genomics Lab",
      ctx.daysAgo(80)
    );

    // Maya, 15 — the pediatric/adult boundary band: growth charts still apply
    // (CDC 2–20), the adult BP regime already does (13+), HPV mid-series,
    // school sports, and a teen-typical low-normal ferritin.
    const maya = addFamilyProfile(ctx, {
      name: "Maya",
      sex: "female",
      birthdate: ctx.daysAgo(15 * 365 + 40),
    });
    for (const [ago, kg, cm] of [
      [720, 47.0, 155.0],
      [360, 51.5, 159.5],
      [10, 54.8, 162.0],
    ] as const) {
      const day = maya.daysAgo(ago);
      ctx.db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, notes, logged_via) VALUES (?,?,?,NULL, ${VIA_SEEDED})`
        )
        .run(maya.profileId, day, kg);
      metricPoint(maya, "height_cm", day, cm);
    }
    immunization(maya, maya.daysAgo(400), "hpv", "Dose 1");
    immunization(maya, maya.daysAgo(200), "hpv", "Dose 2");
    immunization(maya, maya.daysAgo(1100), "tdap", "Adolescent booster");
    immunization(maya, maya.daysAgo(1100), "menacwy", "Dose 1");
    immunization(maya, maya.daysAgo(70), "influenza", "This season");
    for (const ago of [9, 5, 2]) {
      cardioSession(
        maya,
        maya.daysAgo(ago),
        "Running",
        "Soccer practice run",
        40,
        5.5,
        "moderate"
      );
    }
    const mw = recordWriter(maya);
    const teenLabDay = maya.daysAgo(30);
    mw.rec(teenLabDay, "lab", "Ferritin", 19, "ng/mL", "16-154", {
      panel: "Children's Clinic",
    });
    mw.rec(teenLabDay, "lab", "Hemoglobin", 12.6, "g/dL", "12.0-15.5", {
      panel: "Children's Clinic",
    });
    mw.rec(
      maya.daysAgo(30),
      "vitals",
      "Blood Pressure Systolic",
      108,
      "mmHg",
      "90-120",
      { time: "15:30" }
    );
    mw.rec(
      maya.daysAgo(30),
      "vitals",
      "Blood Pressure Diastolic",
      68,
      "mmHg",
      "60-80",
      { time: "15:30" }
    );
    ctx.reconcileFlags(maya.profileId, mw.ids);
    encounter(maya, maya.daysAgo(370), "Annual well-adolescent visit", null);

    completeOnboarding(ctx, "self", ["preventive-care", "metrics-labs"]);
  },
};

const diabeticCgm: SeedPersona = {
  name: "diabetic-cgm",
  title: "Ray, 52 — type 2 diabetic wearing a CGM; partner with asthma",
  description:
    "A two-week per-5-minute sensor trace plus the dense timed readings " +
    "(4/day) the same fortnight lands as lab rows, an improving A1c " +
    "series, diabetes med stack with monitoring " +
    "obligations (metformin B12/eGFR), microalbumin creeping up, a linked " +
    "visit-summary document — plus Priya, his partner with chronic asthma: " +
    "controller + rescue inhalers, a peak-flow stream with a flare dip, " +
    "spirometry results, and her own imported pulmonology report.",
  routes: [
    "/",
    "/medications",
    "/results",
    "/upcoming",
    "/trends",
    "/longevity",
    "/data",
    "/household",
  ],
  gaps: [
    "Continuous glucose has a HOME but no way in and no way to look at it: " +
      "the two stores exist (#2810 — a glucose_trace stream plus its derived " +
      "metric_samples day summaries, seeded here), but no integration ingests " +
      "a CGM, and no surface charts the trace or its time-in-range.",
  ],
  dashboard: {
    expect: ["checkin.mood", "vitals.resting-heart-rate"],
    absent: ["weight.bootstrap"],
  },
  apply(ctx) {
    setAttrs(ctx, {
      name: "Ray",
      sex: "male",
      birthdate: ctx.daysAgo(52 * 365 + 20),
    });

    condition(
      ctx,
      "Type 2 diabetes mellitus",
      "E11.9",
      "2019-08-14",
      "Metformin + SGLT2"
    );
    condition(ctx, "Essential hypertension", "I10", "2017-04-02", null);

    const intake = intakeWriter(ctx);
    intake.medication({
      name: "Metformin",
      notes: "With meals",
      prescriber: "Dr. Okafor",
      rxcui: "6809",
      startedDaysAgo: 2200,
      doses: [
        ["1000 mg", "Morning", "with_food"],
        ["1000 mg", "Evening", "with_food"],
      ],
    });
    intake.medication({
      name: "Empagliflozin",
      notes: "SGLT2 inhibitor",
      prescriber: "Dr. Okafor",
      startedDaysAgo: 420,
      doses: [["10 mg", "Morning", "any"]],
    });
    intake.medication({
      name: "Lisinopril",
      prescriber: "Dr. Okafor",
      startedDaysAgo: 1500,
      doses: [["10 mg", "Morning", "any"]],
    });
    intake.medication({
      name: "Atorvastatin",
      prescriber: "Dr. Okafor",
      startedDaysAgo: 1500,
      doses: [["20 mg", "Evening", "any"]],
    });
    logAdherence(ctx);

    // The CGM sensor as a tracked device (the hearing-aid precedent).
    ctx.db
      .prepare(
        `INSERT INTO equipment (profile_id, name, weight_kg, category) VALUES (?,?,NULL,'Other')`
      )
      .run(ctx.profileId, "Dexcom G7 CGM sensor");

    // Two weeks × 4 timed glucose readings/day: fasting, post-breakfast spike,
    // afternoon, evening. Post-meal values flag high — a dense flagged series.
    const w = recordWriter(ctx);
    for (let d = 13; d >= 0; d--) {
      const day = ctx.daysAgo(d);
      const j = (d * 11) % 17; // deterministic wobble
      const readings: [string, number][] = [
        ["07:00", 102 + (j % 9)],
        ["09:30", 168 + j * 2],
        ["13:30", 121 + (j % 11)],
        ["21:00", 138 + (j % 13)],
      ];
      for (const [time, mgdl] of readings) {
        w.rec(day, "vitals", "Glucose", mgdl, "mg/dL", "65-99", {
          time,
          panel: null,
          name: "Glucose",
        });
      }
    }

    // ── The CGM's actual output: a per-5-minute trace (#2810) ────────────────
    //
    // The four timed readings above are the LAB shape — discrete `medical_records`
    // vitals, which is what a CGM export could land as before this store existed
    // and is still what a fingerstick or a clinic draw is. This is the other half
    // the ruling splits out: 288 sensor points a day, in `glucose_trace`, carrying
    // no reading identity and no band, with the day's mean / time-in-range /
    // coverage recomputed into `metric_samples` by the same write core an ingest
    // would call.
    //
    // The curve is a plausible type-2 day rather than noise: a dawn rise, three
    // meal excursions that peak ~45 minutes after the meal and decay over two
    // hours, and an overnight floor — so time-in-range lands in the 60–75% band a
    // reasonably-controlled person on metformin actually sees, and the trace and
    // the timed readings above tell the same story. Deterministic: the wobble is a
    // function of the day index and the minute, so re-seeding reproduces it.
    const MEALS: [number, number][] = [
      // minute-of-day the meal started, its excursion height in mg/dL
      [7 * 60 + 30, 62],
      [12 * 60 + 45, 54],
      [19 * 60 + 15, 70],
    ];
    for (let d = 13; d >= 0; d--) {
      const day = ctx.daysAgo(d);
      const points: { ts: string; mgdl: number }[] = [];
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        // Overnight floor rising into the dawn phenomenon, then a flat daytime base.
        const base =
          minute < 4 * 60
            ? 108
            : minute < 7 * 60
              ? 108 + (minute - 240) / 12
              : 118;
        let excursion = 0;
        for (const [start, height] of MEALS) {
          const since = minute - start;
          // Rise over 45 min, decay over the next 135. Zero outside the window.
          if (since >= 0 && since < 45) excursion += (height * since) / 45;
          else if (since >= 45 && since < 180)
            excursion += height * (1 - (since - 45) / 135);
        }
        const wobble = ((d * 7 + minute) % 13) - 6;
        points.push({
          ts: ctx.occurredAt(
            day,
            `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
              minute % 60
            ).padStart(2, "0")}`
          ),
          mgdl: Math.round(base + excursion + wobble),
        });
      }
      ctx.recordGlucoseTrace(ctx.profileId, points, "manual");
    }

    // Quarterly labs: A1c improving, kidney watch items.
    const labs: [number, number, number, number, number][] = [
      // ago, a1c, egfr, microalbuminRatio, b12ago-marker unused
      [420, 8.9, 82, 22, 0],
      [200, 8.1, 79, 31, 0],
      [15, 7.4, 76, 44, 0],
    ];
    for (const [ago, a1c, egfr, uacr] of labs) {
      const day = ctx.daysAgo(ago);
      const panel = "Quest Diagnostics";
      w.rec(day, "lab", "Hemoglobin A1c", a1c, "%", "<5.7", { panel });
      w.rec(
        day,
        "lab",
        "Estimated Glomerular Filtration Rate (eGFR)",
        egfr,
        "mL/min/1.73m²",
        ">60",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Microalbumin/Creatinine Ratio, Urine",
        uacr,
        "mg/g",
        "<30",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Glucose, Fasting",
        118 + Math.round(a1c * 2),
        "mg/dL",
        "65-99",
        { panel }
      );
      w.rec(day, "lab", "LDL Cholesterol", 98, "mg/dL", "<100", { panel });
    }
    // A stale B12 (metformin monitoring should call for a re-draw).
    w.rec(ctx.daysAgo(500), "lab", "Vitamin B12", 410, "pg/mL", "232-1245", {
      panel: "Quest Diagnostics",
    });
    ctx.reconcileFlags(ctx.profileId, w.ids);

    for (let wk = 11; wk >= 0; wk--) {
      bodyMetric(
        ctx,
        ctx.daysAgo(wk * 7 + 2),
        Math.round((91 + wk * 0.25) * 10) / 10,
        31,
        68
      );
    }
    for (const ago of [16, 9, 4, 1]) {
      cardioSession(
        ctx,
        ctx.daysAgo(ago),
        "Walking",
        "After-dinner walk",
        35,
        2.8,
        "easy"
      );
    }
    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, description, category, target_value, current_value, unit, target_date, status)
         VALUES (?,?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "A1c under 7",
        "Per Dr. Okafor",
        null,
        7,
        7.4,
        "%",
        ctx.daysAgo(-120)
      );
    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, category, target_value, body_metric, baseline_value, target_date, status)
         VALUES (?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "Lose 8 kg",
        "body",
        86,
        "weight",
        94,
        ctx.daysAgo(-200)
      );

    appointment(
      ctx,
      ctx.daysAgo(-14),
      "08:45",
      "Endocrinology follow-up",
      "Diabetes Center",
      "scheduled"
    );
    encounter(
      ctx,
      ctx.daysAgo(200),
      "Diabetes follow-up",
      "Type 2 diabetes mellitus"
    );
    familyHistory(ctx, [["Mother", "Type 2 diabetes", "44054006", 50, 0]]);

    // Ray's latest quarterly labs arrived as a visit-summary document.
    addDocument(ctx, {
      filename: "endocrinology-visit-summary.pdf",
      docType: "visit_summary",
      dateDaysAgo: 15,
      hashSeed: "ray1",
      linkCategory: "lab",
    });

    // Priya, 48 — chronic asthma: controller + rescue inhalers, a peak-flow
    // stream dipping through a flare, spirometry results, and her own
    // imported pulmonology report. Covers the respiratory machinery no solo
    // persona touches.
    const priya = addFamilyProfile(ctx, {
      name: "Priya",
      sex: "female",
      birthdate: ctx.daysAgo(48 * 365 + 200),
    });
    condition(
      priya,
      "Asthma, moderate persistent",
      "J45.40",
      "2008-04-15",
      "Well controlled on ICS/LABA"
    );
    ctx.db
      .prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, severity, status, onset_date, notes)
         VALUES (?,?,?,?,?,NULL,NULL)`
      )
      .run(priya.profileId, "Dust mites", "Wheezing", "moderate", "active");
    const priyaIntake = intakeWriter(priya);
    priyaIntake.medication({
      name: "Fluticasone/Salmeterol",
      notes: "Controller inhaler — rinse mouth after use",
      prescriber: "Dr. Osei",
      startedDaysAgo: 1600,
      doses: [
        ["1 puff", "Morning", "any"],
        ["1 puff", "Evening", "any"],
      ],
    });
    priyaIntake.medication({
      name: "Albuterol",
      notes: "Rescue inhaler — as needed",
      obligation: "may",
      prescriber: "Dr. Osei",
      startedDaysAgo: 1600,
      doses: [["2 puffs", "Anytime", "any"]],
    });
    logAdherence(priya);

    // Peak flow: three weeks of morning/evening blows dipping through a flare
    // — the #1850 stream shape — with the DECLARED personal best the zone
    // card judges against.
    for (let d = 20; d >= 0; d--) {
      const day = priya.daysAgo(d);
      const dip = d <= 11 && d >= 7 ? 90 - Math.abs(9 - d) * 20 : 0;
      const jitter = (d * 5) % 12;
      metricPoint(priya, "peak_flow_lmin", day, 430 - dip + jitter, "07:20:00");
      metricPoint(priya, "peak_flow_lmin", day, 420 - dip + jitter, "20:10:00");
    }
    ctx.db
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'peak_flow_personal_best', '460')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(priya.profileId);

    // Spirometry from the pulmonology visit, linked to her imported report.
    // Printed name = the bare abbreviation a PFT report prints; canonical =
    // the "Long Name (ABBR)" entry it snaps onto (#2335), mirroring the
    // baseline spirometry block. Ratio just below the 70% cutoff → flags.
    const pw = recordWriter(priya);
    const spiroDay = priya.daysAgo(40);
    pw.rec(
      spiroDay,
      "vitals",
      "Forced Expiratory Volume in 1 Second (FEV1)",
      2.4,
      "L",
      null,
      { panel: "Spirometry", name: "FEV1" }
    );
    pw.rec(spiroDay, "vitals", "Forced Vital Capacity (FVC)", 3.4, "L", null, {
      panel: "Spirometry",
      name: "FVC",
    });
    pw.rec(spiroDay, "vitals", "FEV1/FVC Ratio", 69, "%", "≥70%", {
      panel: "Spirometry",
    });
    priya.reconcileFlags(priya.profileId, pw.ids);
    addDocument(priya, {
      filename: "pulmonology-spirometry-report.pdf",
      docType: "lab_report",
      dateDaysAgo: 40,
      hashSeed: "priy",
      linkCategory: "lab",
    });
    encounter(priya, priya.daysAgo(40), "Pulmonology follow-up", "Asthma");
    appointment(
      priya,
      priya.daysAgo(-50),
      "11:00",
      "Asthma review",
      "Pulmonology Clinic",
      "scheduled"
    );

    completeOnboarding(ctx, "self", ["medications", "metrics-labs"]);
  },
};

const biohacker: SeedPersona = {
  name: "biohacker",
  title: "Kai, 36 — optimization enthusiast with Oura + Withings",
  description:
    "A 20-item supplement stack with stacks/splits and a deliberate zinc " +
    "UL overshoot, sauna + cold plunge + red light as protocol-owned " +
    "practices, an NMN self-experiment, optimal-range bloodwork, a fasting " +
    "habit the app cannot yet track — and Oura + Withings connected: " +
    "staged sleep with HRV and wearable resting HR nightly, smart-scale " +
    "weigh-ins with body composition beside the manual weekly log.",
  routes: [
    "/nutrition",
    "/longevity",
    "/supplies",
    "/upcoming",
    "/results/clinical-results",
    "/trends",
    "/history",
    "/sleep",
    "/integrations",
  ],
  gaps: [
    "No fasting model: time-restricted eating has no first-class surface, so " +
      "the habit can only be represented as a freeform goal.",
  ],
  dashboard: {
    expect: ["checkin.mood", "healthspan.pillar"],
    absent: ["weight.bootstrap"],
  },
  apply(ctx) {
    setAttrs(ctx, {
      name: "Kai",
      sex: "male",
      birthdate: ctx.daysAgo(36 * 365 + 250),
    });

    const intake = intakeWriter(ctx);
    const stack = (
      name: string,
      amount: string,
      time: string,
      food = "any",
      extra: {
        brand?: string;
        stack?: string;
        notes?: string;
        obligation?: "must" | "should" | "may";
      } = {}
    ) =>
      intake.supplement({
        name,
        brand: extra.brand ?? null,
        stack: extra.stack ?? null,
        notes: extra.notes ?? null,
        obligation: extra.obligation ?? "should",
        doses: [[amount, time, food]],
      });

    stack("Vitamin D3", "5000 IU", "Morning", "with_fat", {
      stack: "AM stack",
    });
    stack("Vitamin K2", "200 mcg", "Morning", "with_fat", {
      stack: "AM stack",
    });
    stack("Omega-3", "2 g", "Morning", "with_fat", {
      brand: "Nordic Naturals",
      stack: "AM stack",
    });
    stack("Creatine Monohydrate", "5 g", "Morning", "any", {
      stack: "AM stack",
    });
    stack("NMN", "500 mg", "Morning", "empty_stomach", {
      stack: "Longevity stack",
    });
    stack("Resveratrol", "500 mg", "Morning", "with_fat", {
      stack: "Longevity stack",
    });
    stack("CoQ10", "200 mg", "Morning", "with_fat", {
      stack: "Longevity stack",
    });
    stack("Berberine", "500 mg", "Midday", "with_food", {
      notes: "Glucose control",
    });
    stack("Curcumin", "1 g", "Midday", "with_food");
    stack("B-Complex", "1 capsule", "Morning", "with_food");
    stack("Lion's Mane", "1 g", "Morning", "any", { notes: "Focus" });
    stack("Rhodiola Rosea", "300 mg", "Morning", "empty_stomach");
    stack("Ashwagandha", "600 mg", "Evening", "any", { stack: "Sleep stack" });
    stack("Magnesium L-Threonate", "2 g", "Evening", "any", {
      stack: "Sleep stack",
    });
    stack("Glycine", "3 g", "Before sleep", "any", { stack: "Sleep stack" });
    stack("L-Theanine", "200 mg", "Before sleep", "any", {
      stack: "Sleep stack",
    });
    stack("Taurine", "2 g", "Evening", "any");
    stack("Alpha-GPC", "300 mg", "Morning", "any");
    // The UL overshoot: two zinc sources totalling ~40 mg supplemental.
    stack("Zinc Picolinate", "25 mg", "Evening", "with_food");
    stack("Zinc", "15 mg", "Morning", "with_food", {
      notes: "In the AM formula too — stack total exceeds the UL",
    });
    logAdherence(ctx);

    // Practices as protocol-owned frequency targets + logged sessions.
    const addPractice = (
      practice: string,
      perWeek: number,
      perWeekMax: number | null,
      durationMin: number,
      dayMod: number[]
    ) => {
      const targetId = Number(
        ctx.db
          .prepare(
            `INSERT INTO frequency_targets
               (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max, created_at)
             VALUES (?, 'practice', ?, ?, ?, ?, ?)`
          )
          .run(
            ctx.profileId,
            practice,
            practice.toLowerCase(),
            perWeek,
            perWeekMax,
            `${ctx.daysAgo(42)} 09:00:00`
          ).lastInsertRowid
      );
      ctx.db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, end_date, notes, outcome_keys, situation,
              frequency_target_id, owns_frequency_target)
           VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, 1)`
        )
        .run(
          ctx.profileId,
          `${practice} ${perWeek}${perWeekMax ? `–${perWeekMax}` : ""}×/week`,
          ctx.daysAgo(42),
          JSON.stringify(["metric:resting_hr"]),
          targetId
        );
      const session = ctx.db.prepare(
        `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min, logged_via)
         VALUES (?, ?, ?, ?, ?, ${VIA_SEEDED})`
      );
      for (let d = 41; d >= 0; d--) {
        if (dayMod.includes(d % 7)) {
          session.run(
            ctx.profileId,
            practice,
            ctx.daysAgo(d),
            "07:00",
            durationMin
          );
        }
      }
    };
    addPractice("Sauna", 3, 5, 20, [0, 2, 4, 6]);
    addPractice("Cold plunge", 3, null, 4, [1, 3, 5]);
    addPractice("Red light therapy", 5, null, 10, [0, 1, 3, 4, 6]);

    // The N-of-1: NMN vs resting HR, linked to the NMN intake item.
    const nmnId = (
      ctx.db
        .prepare(
          `SELECT id FROM intake_items WHERE profile_id = ? AND name = 'NMN'`
        )
        .get(ctx.profileId) as { id: number }
    ).id;
    ctx.db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, notes, outcome_keys, situation, intake_item_id)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`
      )
      .run(
        ctx.profileId,
        "NMN 500 mg/day",
        ctx.daysAgo(45),
        "Self-experiment: does NMN move resting HR or weight?",
        JSON.stringify(["metric:resting_hr", "metric:weight"]),
        nmnId
      );

    // Fasting is NOT a supported model — a freeform goal is the closest fit.
    ctx.db
      .prepare(
        `INSERT INTO goals (profile_id, title, description, category, target_value, current_value, unit, target_date, status)
         VALUES (?,?,?,?,?,?,?,?,'active')`
      )
      .run(
        ctx.profileId,
        "16:8 fasting six days a week",
        "No app surface tracks eating windows — logged as a manual goal",
        null,
        6,
        5,
        "days/week",
        ctx.daysAgo(-60)
      );

    // Optimal-chasing bloodwork, two draws.
    const w = recordWriter(ctx);
    for (const [ago, panel] of [
      [95, "Function Health"],
      [8, "Function Health"],
    ] as const) {
      const day = ctx.daysAgo(ago);
      w.rec(
        day,
        "lab",
        "High-Sensitivity C-Reactive Protein (hs-CRP)",
        ago > 50 ? 0.6 : 0.4,
        "mg/L",
        "<3",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "LDL Cholesterol",
        ago > 50 ? 92 : 88,
        "mg/dL",
        "<100",
        { panel }
      );
      w.rec(day, "lab", "HDL Cholesterol", 64, "mg/dL", ">40", { panel });
      w.rec(day, "lab", "Triglycerides", 58, "mg/dL", "<150", { panel });
      w.rec(
        day,
        "lab",
        "Glucose, Fasting",
        ago > 50 ? 86 : 83,
        "mg/dL",
        "65-99",
        { panel }
      );
      w.rec(day, "lab", "Hemoglobin A1c", 5.1, "%", "<5.7", { panel });
      w.rec(
        day,
        "lab",
        "Testosterone, Total",
        ago > 50 ? 690 : 725,
        "ng/dL",
        "300-1000",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Insulin-Like Growth Factor 1 (IGF-1)",
        165,
        "ng/mL",
        "88-246",
        { panel }
      );
      w.rec(day, "lab", "Ferritin", 96, "ng/mL", "30-400", { panel });
      w.rec(
        day,
        "lab",
        "Vitamin B12",
        ago > 50 ? 820 : 905,
        "pg/mL",
        "232-1245",
        { panel }
      );
      w.rec(
        day,
        "lab",
        "Vitamin D, 25-Hydroxy",
        ago > 50 ? 52 : 58,
        "ng/mL",
        "30-100",
        { panel }
      );
      w.rec(day, "lab", "Uric Acid", 4.9, "mg/dL", "3.5-7.2", { panel });
    }
    ctx.reconcileFlags(ctx.profileId, w.ids);

    // Connected wearables: Oura (sleep/HRV/RHR) + Withings (scale).
    connectIntegration(ctx, "oura", {});
    connectIntegration(ctx, "withings", {});

    // 30 Oura nights: staged sleep + HRV keyed on the bedtime window, and the
    // night's resting HR as an oura-sourced body_metrics row (the mapOuraSleep
    // shape). Deterministic jitter keeps the series realistic.
    for (let i = 0; i <= 29; i++) {
      const wakeDay = ctx.daysAgo(i);
      const jitter = ((i * 9) % 25) - 12;
      ouraNight(ctx, wakeDay, {
        totalMin: 455 + jitter,
        deep: 82 + (jitter % 9),
        rem: 104 + (jitter % 11),
        hrv: 58 + (jitter % 13),
        rhr: 49 + (i % 3),
      });
    }
    // Two weeks of smart-scale weigh-ins beside the manual weekly log — the
    // same quantity from two sources, the metric_source_priority subject.
    for (let d = 13; d >= 0; d--) {
      const j = (d * 3) % 7;
      withingsWeighIn(ctx, ctx.daysAgo(d), {
        kg: Math.round((78.2 + j * 0.1) * 10) / 10,
        fatPct: Math.round((14.3 + (j % 3) * 0.2) * 10) / 10,
        muscleKg: 36.5,
        waterKg: 45.2,
      });
    }
    for (let wk = 9; wk >= 0; wk--) {
      bodyMetric(
        ctx,
        ctx.daysAgo(wk * 7 + 1),
        78.5,
        14.5,
        52 - Math.floor((9 - wk) / 4)
      );
      strengthSession(ctx, ctx.daysAgo(wk * 7 + 3), "Full-body strength", [
        ["Back Squat", 100, [5, 5, 5]],
        ["Barbell Bench Press", 80, [5, 5, 5]],
        ["Pull Up", 0, [10, 8, 8]],
      ]);
      cardioSession(
        ctx,
        ctx.daysAgo(wk * 7 + 5),
        "Cycling",
        "Zone 2 ride",
        60,
        25,
        "easy"
      );
    }

    const date = ctx.daysAgo(6);
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "vo2max",
      value: 50,
      rawInput: { method: "watch", watchValue: 50 },
    });
    ctx.saveFitnessEntry(ctx.profileId, { date, testKey: "grip", value: 54 });
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "plank",
      value: 160,
      durationSec: 160,
    });
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "restinghr",
      value: 50,
    });
    ctx.saveFitnessEntry(ctx.profileId, {
      date,
      testKey: "bodyfat",
      value: 14.2,
    });

    completeOnboarding(ctx, "self", ["fitness", "metrics-labs"]);
  },
};

export const PERSONAS: readonly SeedPersona[] = [
  bodybuilder,
  marathonRunner,
  household,
  pregnant,
  diabeticCgm,
  biohacker,
];

export type PersonaSelection =
  | { kind: "none" }
  | { kind: "found"; persona: SeedPersona }
  | { kind: "unknown"; raw: string; known: string[] };

// Parse SEED_PERSONA from a caller-supplied env record (pure, like
// seedFromEnv). Unset/empty ⇒ none (the baseline story). An unknown name is
// returned as such so the entrypoint can FAIL LOUDLY — unlike SEED_RNG, where
// a typo falls back to the baseline because the baseline is the labeled look,
// a persona typo would produce data that contradicts the census label.
export function personaFromEnv(
  env: Record<string, string | undefined>
): PersonaSelection {
  const raw = env.SEED_PERSONA?.trim();
  if (!raw) return { kind: "none" };
  const persona = PERSONAS.find((p) => p.name === raw);
  if (persona) return { kind: "found", persona };
  return { kind: "unknown", raw, known: PERSONAS.map((p) => p.name) };
}
