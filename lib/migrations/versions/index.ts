import type { Migration } from "../runner";
import { migration as m001 } from "./001-baseline";
import { migration as m002 } from "./002-edit-lock-flags";
import { migration as m003 } from "./003-preventive-tracking";
import { migration as m004 } from "./004-extraction-lease";
import { migration as m005 } from "./005-dose-history";
import { migration as m006 } from "./006-fk-link-integrity";
import { migration as m007 } from "./007-appointment-kind";
import { migration as m008 } from "./008-dose-skip-state";
import { migration as m009 } from "./009-activity-est-calories";
import { migration as m010 } from "./010-protocols";
import { migration as m011 } from "./011-intake-schema-debt";
import { migration as m012 } from "./012-medication-rxcui";
import { migration as m013 } from "./013-rxcui-ingredients";
import { migration as m014 } from "./014-hr-minutes-per-source";
import { migration as m015 } from "./015-import-job-committing-state";
import { migration as m016 } from "./016-goal-status-drop-archived";
import { migration as m017 } from "./017-equipment-retire";
import { migration as m018 } from "./018-equipment-category-enum";
import { migration as m019 } from "./019-activity-equipment";
import { migration as m020 } from "./020-medical-records-created-index";
import { migration as m021 } from "./021-dose-lifetime";
import { migration as m022 } from "./022-integration-refresh-claim";
import { migration as m023 } from "./023-import-tombstones";
import { migration as m024 } from "./024-appointment-import-provenance";
import { migration as m025 } from "./025-protocol-equipment-practice";
import { migration as m026 } from "./026-appointment-encounter-link";
import { migration as m027 } from "./027-exercise-set-warmup";
import { migration as m028 } from "./028-coverage-gaps";
import { migration as m029 } from "./029-situations";
import { migration as m030 } from "./030-food-log";
import { migration as m031 } from "./031-frequency-target-food-group";
import { migration as m032 } from "./032-activity-routes";
import { migration as m033 } from "./033-sync-event-edited-count";
import { migration as m034 } from "./034-medical-record-loinc";
import { migration as m035 } from "./035-metric-sample-activity-link";
import { migration as m036 } from "./036-genomic-variants";
import { migration as m037 } from "./037-imaging-studies";
import { migration as m038 } from "./038-food-habit-unique";
import { migration as m039 } from "./039-routines";
import { migration as m040 } from "./040-exercise-set-rpe";
import { migration as m041 } from "./041-administration-ledger";
import { migration as m042 } from "./042-symptom-logs";
import { migration as m043 } from "./043-prn-redose";
import { migration as m044 } from "./044-episode-share-links";
import { migration as m045 } from "./045-medication-rx-flag";
import { migration as m046 } from "./046-illness-episodes";
import { migration as m047 } from "./047-medication-last-fill";
import { migration as m048 } from "./048-medications-share-kind";
import { migration as m049 } from "./049-symptom-photos";
import { migration as m050 } from "./050-followup-chain";
import { migration as m051 } from "./051-protocol-intake-item";
import { migration as m052 } from "./052-blood-type-parts";
import { migration as m053 } from "./053-protein-log";
import { migration as m054 } from "./054-injuries";
import { migration as m055 } from "./055-fitness-assessments";
import { migration as m056 } from "./056-food-log-events";
import { migration as m057 } from "./057-endurance-plans";
import { migration as m058 } from "./058-recovery-activity-type";
import { migration as m059 } from "./059-frequency-target-mobility-region";
import { migration as m060 } from "./060-followup-labs";
import { migration as m061 } from "./061-notify-lifecycle";
import { migration as m062 } from "./062-stable-episode-conditions";
import { migration as m063 } from "./063-cycles";
import { migration as m064 } from "./064-login-email";
import { migration as m065 } from "./065-optical-prescriptions";
import { migration as m066 } from "./066-instrument-responses";
import { migration as m067 } from "./067-dental-procedures";
import { migration as m068 } from "./068-canonical-cycle-phase-ranges";
import { migration as m069 } from "./069-equipment-hearing-aid";
import { migration as m070 } from "./070-skin-lesions";
import { migration as m071 } from "./071-imaging-dose";
import { migration as m072 } from "./072-substance-frequency-target";
import { migration as m073 } from "./073-mood-logs";
import { migration as m074 } from "./074-imported-temperature-degf";
import { migration as m075 } from "./075-extraction-completed-at";
import { migration as m076 } from "./076-encounter-type-code";
import { migration as m077 } from "./077-optical-minus-cylinder";
import { migration as m078 } from "./078-imaging-modality-expansion";
import { migration as m079 } from "./079-intake-log-product";
import { migration as m080 } from "./080-intake-log-supply-adjusted";
import { migration as m081 } from "./081-visit-record-links";
import { migration as m082 } from "./082-episode-visit-link";
import { migration as m083 } from "./083-metric-sample-origin";
import { migration as m084 } from "./084-provider-registry-lifecycle";
import { migration as m085 } from "./085-provider-affiliations";
import { migration as m086 } from "./086-medication-links";
import { migration as m087 } from "./087-medication-link-decisions";
import { migration as m088 } from "./088-backfill-prescriber-links";
import { migration as m089 } from "./089-optical-dental-encounter-link";
import { migration as m090 } from "./090-medical-record-category-classes";
import { migration as m091 } from "./091-medication-course-attribution";
import { migration as m092 } from "./092-consolidate-imported-prescriptions";
import { migration as m093 } from "./093-retire-notify-last-upcoming";
import { migration as m094 } from "./094-episode-encounters";
import { migration as m095 } from "./095-episode-stopped-meds";
import { migration as m096 } from "./096-substance-log";

// The ordered, append-only list of schema migrations (issue #119). ORDER IS THE
// CONTRACT: a migration's position (1-based) must equal its `id`, and the runner
// stamps `PRAGMA user_version` with it. To add a schema change, create the next
// `NNN-<slug>.ts`, export a `Migration` from it, append it here, and add its hash
// to lib/migrations/manifest.json (the immutability guard). NEVER edit or reorder
// a shipped entry — append a corrective migration instead.
export const MIGRATIONS: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
  m016,
  m017,
  m018,
  m019,
  m020,
  m021,
  m022,
  m023,
  m024,
  m025,
  m026,
  m027,
  m028,
  m029,
  m030,
  m031,
  m032,
  m033,
  m034,
  m035,
  m036,
  m037,
  m038,
  m039,
  m040,
  m041,
  m042,
  m043,
  m044,
  m045,
  m046,
  m047,
  m048,
  m049,
  m050,
  m051,
  m052,
  m053,
  m054,
  m055,
  m056,
  m057,
  m058,
  m059,
  m060,
  m061,
  m062,
  m063,
  m064,
  m065,
  m066,
  m067,
  m068,
  m069,
  m070,
  m071,
  m072,
  m073,
  m074,
  m075,
  m076,
  m077,
  m078,
  m079,
  m080,
  m081,
  m082,
  m083,
  m084,
  m085,
  m086,
  m087,
  m088,
  m089,
  m090,
  m091,
  m092,
  m093,
  m094,
  m095,
  m096,
];
