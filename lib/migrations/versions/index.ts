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
import { migration as m097 } from "./097-progress-photos";
import { migration as m098 } from "./098-videos";
import { migration as m099 } from "./099-practice-targets-and-logs";
import { migration as m100 } from "./100-weather-uv-cache";
import { migration as m101 } from "./101-recover-blank-name-prescriptions";
import { migration as m102 } from "./102-session-view-profiles";
import { migration as m103 } from "./103-canonical-name-abbreviation-consolidation";
import { migration as m104 } from "./104-login-own-profile";
import { migration as m105 } from "./105-login-notification-channels";
import { migration as m106 } from "./106-medical-record-report-category";
import { migration as m107 } from "./107-activity-elapsed-min";
import { migration as m108 } from "./108-intake-pause-situation";
import { migration as m109 } from "./109-health-connect-token-hash";
import { migration as m110 } from "./110-integration-sync-rows";
import { migration as m111 } from "./111-symptom-episode-photo-links";
import { migration as m112 } from "./112-shared-supply-pools";
import { migration as m113 } from "./113-saved-items";
import { migration as m114 } from "./114-standard-metric-seeds";
import { migration as m115 } from "./115-metric-sample-edit-lock";
import { migration as m116 } from "./116-food-event-meal-slot";
import { migration as m117 } from "./117-fitbit-activity-components";
import { migration as m118 } from "./118-imported-practice-logs";
import { migration as m119 } from "./119-practice-sync-provenance";
import { migration as m120 } from "./120-lab-result-lifecycle";
import { migration as m121 } from "./121-goal-equipment-context";
import { migration as m122 } from "./122-records-safety-passport";
import { migration as m123 } from "./123-practice-target-unique";
import { migration as m124 } from "./124-intake-obligation";
import { migration as m125 } from "./125-lesion-allergy-encounter-link";
import { migration as m126 } from "./126-intake-cadence";
import { migration as m127 } from "./127-api-tokens";
import { migration as m128 } from "./128-portal-identity";
import { migration as m129 } from "./129-weather-daily-cache";
import { migration as m130 } from "./130-acquirer-provenance";
import { migration as m131 } from "./131-portal-accounts";
import { migration as m132 } from "./132-portal-run-reports";
import { migration as m133 } from "./133-portal-sync-requests";
import { migration as m134 } from "./134-tombstone-label";
import { migration as m135 } from "./135-notify-message-pointers";
import { migration as m136 } from "./136-clinical-content-key";
import { migration as m137 } from "./137-episode-stopped-med-snapshot";
import { migration as m138 } from "./138-document-coverage-markers";
import { migration as m139 } from "./139-notify-message-title";
import { migration as m140 } from "./140-prn-max-daily-mg";
import { migration as m141 } from "./141-followup-settle";
import { migration as m142 } from "./142-trend-views-cleanup";
import { migration as m143 } from "./143-portal-software-open-enum";
import { migration as m144 } from "./144-condition-laterality-severity";
import { migration as m145 } from "./145-family-history-death-lineage";
import { migration as m146 } from "./146-sync-report-provenance";
import { migration as m147 } from "./147-goal-biomarker-target";
import { migration as m148 } from "./148-retire-run-milestones";
import { migration as m149 } from "./149-weather-hourly-precipitation";
import { migration as m150 } from "./150-substance-log-notes";
import { migration as m151 } from "./151-dose-schedule-versions";
import { migration as m152 } from "./152-notify-message-kind-index";
import { migration as m153 } from "./153-notify-message-prose";
import { migration as m154 } from "./154-food-eating-time";
import { migration as m155 } from "./155-fitbit-sleep-instants";
import { migration as m156 } from "./156-intake-log-item-given";
import { migration as m157 } from "./157-injury-scope";
import { migration as m158 } from "./158-notify-times-minute-grain";
import { migration as m159 } from "./159-cycling-telemetry";
import { migration as m160 } from "./160-integration-backfill-jobs";
import { migration as m161 } from "./161-condition-edit-lock";
import { migration as m162 } from "./162-immunizations-share-kind";
import { migration as m163 } from "./163-sync-ledger-utc-instants";
import { migration as m164 } from "./164-hr-minutes-utc-instants";
import { migration as m165 } from "./165-observation-occurred-at";
import { migration as m166 } from "./166-digest-mode";
import { migration as m167 } from "./167-notify-lifecycle-utc-instant";
import { migration as m168 } from "./168-appointment-day-time-split";
import { migration as m169 } from "./169-illness-episode-day-window";
import { migration as m170 } from "./170-tap-message-provenance";
import { migration as m171 } from "./171-temperature-note-times";
import { migration as m172 } from "./172-unclassified-activity-type";
import { migration as m173 } from "./173-intake-log-recorded-at";
import { migration as m174 } from "./174-canonical-alias-merge";
import { migration as m175 } from "./175-telemetry-stream-summary";
import { migration as m176 } from "./176-unqualified-glucose-unflag";
import { migration as m177 } from "./177-assessment-category";
import { migration as m178 } from "./178-canonical-name-qualifiers";
import { migration as m179 } from "./179-stream-frontiers";
import { migration as m180 } from "./180-waist-circumference-metric";
import { migration as m181 } from "./181-notify-message-receipt-keyboard";
import { migration as m182 } from "./182-goal-achieved-at";

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
  m097,
  m098,
  m099,
  m100,
  m101,
  m102,
  m103,
  m104,
  m105,
  m106,
  m107,
  m108,
  m109,
  m110,
  m111,
  m112,
  m113,
  m114,
  m115,
  m116,
  m117,
  m118,
  m119,
  m120,
  m121,
  m122,
  m123,
  m124,
  m125,
  m126,
  m127,
  m128,
  m129,
  m130,
  m131,
  m132,
  m133,
  m134,
  m135,
  m136,
  m137,
  m138,
  m139,
  m140,
  m141,
  m142,
  m143,
  m144,
  m145,
  m146,
  m147,
  m148,
  m149,
  m150,
  m151,
  m152,
  m153,
  m154,
  m155,
  m156,
  m157,
  m158,
  m159,
  m160,
  m161,
  m162,
  m163,
  m164,
  m165,
  m166,
  m167,
  m168,
  m169,
  m170,
  m171,
  m172,
  m173,
  m174,
  m175,
  m176,
  m177,
  m178,
  m179,
  m180,
  m181,
  m182,
];
