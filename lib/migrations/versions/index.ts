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
];
