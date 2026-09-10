// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE ONE-TAP PRN GATHER. One shape (`PrnMedForQuickLog`) and one gather behind two
// doors — medications only for the med surfaces, kind-neutral for the quick-log
// sheet — carrying each item's day count, its display clock, and the ingredient-FAMILY
// arming the redose line is allowed to render from.
//
// A READ, and the reason it is not next to the writers: it decides what a surface may
// OFFER, never what happens when the offer is taken. Its one pairing of the event
// column with the capture stamp is the "last 4:02pm" DISPLAY clock; the safety half
// (`familyArming`) never falls back to a capture stamp, and holding those two answers
// side by side in one row is easier to keep honest here than in a file that also
// writes the ledger.
import type { MedFamilyItem } from "../../medication-family";
import { prnLabelIdentityFor } from "../../prn-defaults";
import { parseRxcuiIngredients } from "../../rxnorm";
import { hoistedStatement, today } from "../../db";
import { now as clockNow } from "../../clock";
import {
  ARMING_ORDER,
  armingFromRow,
  getMedicationFamilyStates,
} from "./prn-family";
import { ceilingWindowEndMinute } from "../../prn-redose";
import type { FamilyArming, PrnDayExposure } from "../../prn-redose";
import type { IntakeItemKind } from "../../types";
import { intakeShortLabels } from "../../intake-short-name";
import { getIntakeItems } from "./schedule";

// One PRN med surfaced for one-tap logging (dashboard presentation + med card): its id,
// name, and today's administration count + latest intake time. Since #798 it also
// carries the confirmed redose interval/max (null when not configured) so each surface
// can render a marker-agnostic "redose open / next in ~Xh" status line without a
// second query (the same window math the notice uses, via redoseWindowStatus).
// Since #1027 it ALSO carries the ingredient-FAMILY counters — the combined count,
// latest administration, and most conservative confirmed max across every active med
// sharing the ingredient — which are what the redose window math must consume (an
// OTC ibuprofen dose an hour ago holds the Rx item's "redose OK"). For a solo item
// the family values equal the per-item ones. The per-item count/lastGivenAt stay for
// the "N today · last 4:02pm" day label (the item's own administrations).
//
// TWO CONSUMERS, TWO ANSWERS (#4686). `lastGivenAt` is a DISPLAY column and keeps its
// capture fallback: deleting it would make a PRN medication read "No doses logged"
// after any past-day check-off, hiding a dose that happened. `familyArming` is the
// SAFETY answer and never falls back to it — including on the non-medication path,
// which has no ingredient family and now reads its own arming halves rather than
// inheriting the display column.
export interface PrnMedForQuickLog {
  // Complete label identity. Its name is the linked bottle's product name when one
  // exists, otherwise the item's display name; confirmed CUIs retain precedence.
  identity: Omit<MedFamilyItem, "id">;
  id: number;
  name: string;
  kind: IntakeItemKind;
  displayName?: string;
  product: string | null;
  amount: string | null;
  // The item's OWN administrations on the profile-local day — the "2 today · last
  // 4:02pm" label, which genuinely renders a DAY and is untouched by #4686.
  count: number;
  lastGivenAt: string | null;
  minIntervalHours: number | null;
  maxDailyCount: number | null;
  // The ingredient family's administrations inside the trailing 24 hours (#4686) —
  // the ceiling's basis.
  familyCount: number;
  // What arms the interval clock (#4686). A discriminated value rather than a nullable
  // instant, so the "logged but unplaced" state cannot collapse onto "nothing logged"
  // — or onto the display column above.
  familyArming: FamilyArming;
  // min confirmed max across the family; falls back to the item's own max.
  familyMaxDailyCount: number | null;
  // The family's amount-aware window exposure (#1854) from the ONE family gather —
  // null when no ceiling is confirmed. Feeds prnQuickLogRedoseStatus so the
  // quick-log/card/Telegram "N of M" line reads milligrams when they're known.
  familyExposure: PrnDayExposure | null;
  // Number of active items in the ingredient family (1 for a solo item) — lets the
  // quick-log content note that the counters span sibling items.
  familyMemberCount: number;
}

// Active PRN (as-needed) medications for the shared quick-log content, each with today's
// administration count + latest intake time. Recently-used float to the top (most
// recent last-administration first — the quick-log content's ordering), then
// alphabetical. One profile-scoped read so every surface agrees;
// the #1027 family counters are overlaid from the ONE getMedicationFamilyStates
// gather so every redose surface widens identically.
const PRN_QUICK_LOG_STMT = hoistedStatement(
  `SELECT s.id AS id, s.name AS name, s.kind AS kind, s.product AS product,
              s.supply_id AS supply_id,
              s.rxcui, s.rxcui_ingredients,
              (SELECT ss.name FROM shared_supplies ss
                WHERE ss.id = s.supply_id) AS supply_name,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
              (SELECT COUNT(*) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.date = ? AND l.status = 'taken')
                AS count,
              (SELECT MAX(COALESCE(l.occurred_at, l.recorded_at)) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.status = 'taken')
                AS lastGivenAt,
              -- The item's OWN arming row, under the SAME ordering the family gather
              -- and the per-item fallback use, and with no COALESCE: the only consumer
              -- is the non-medication fallback below, which has no ingredient family to
              -- ask. A NULL armingAt beside a non-null armingId is the unplaced arm.
              (SELECT l.id FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.status = 'taken'
                ORDER BY ${ARMING_ORDER} LIMIT 1) AS armingId,
              (SELECT l.occurred_at FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.status = 'taken'
                ORDER BY ${ARMING_ORDER} LIMIT 1) AS armingAt,
              s.min_interval_hours AS minIntervalHours,
              s.max_daily_count AS maxDailyCount
        FROM intake_items s
        WHERE s.profile_id = ? AND s.active = 1
          AND s.obligation = 'may' AND (? = 0 OR s.kind = 'medication')
        ORDER BY (lastGivenAt IS NULL), lastGivenAt DESC, s.name`
);

function getPrnQuickLogItems(
  profileId: number,
  medicationsOnly: boolean
): PrnMedForQuickLog[] {
  const date = today(profileId);
  const rows = PRN_QUICK_LOG_STMT.all(
    date,
    profileId,
    medicationsOnly ? 1 : 0
  ) as (Omit<
    PrnMedForQuickLog,
    | "identity"
    | "familyCount"
    | "familyArming"
    | "familyMaxDailyCount"
    | "familyExposure"
    | "familyMemberCount"
  > & {
    rxcui: string | null;
    rxcui_ingredients: string | null;
    supply_id: number | null;
    supply_name: string | null;
    armingId: number | null;
    armingAt: string | null;
  })[];
  const families = getMedicationFamilyStates(
    profileId,
    ceilingWindowEndMinute(clockNow())
  );
  return rows.map(
    ({
      rxcui,
      rxcui_ingredients,
      supply_id,
      supply_name,
      armingId,
      armingAt,
      ...r
    }) => {
      const fam = families.get(r.id);
      return {
        ...r,
        identity: prnLabelIdentityFor({
          name: r.name,
          supplyId: supply_id,
          supplyName: supply_name,
          rxcui,
          rxcuiIngredients: parseRxcuiIngredients(rxcui_ingredients),
        }),
        familyCount: fam?.countInWindow ?? r.count,
        // The family answer when there is one, else THIS item's own union — never the
        // display column beside it. A PRN supplement has no ingredient family, and
        // before #4686 it inherited `lastGivenAt`, which is how the unknown arm was
        // unreachable on the whole non-medication path.
        familyArming:
          fam?.arming ??
          armingFromRow(
            armingId == null
              ? undefined
              : { id: armingId, givenAt: armingAt, itemId: r.id }
          ),
        familyMaxDailyCount: fam?.minConfirmedMax ?? r.maxDailyCount,
        familyExposure: fam?.exposure ?? null,
        familyMemberCount: fam?.memberIds.length ?? 1,
      };
    }
  );
}

export function getPrnMedicationsForQuickLog(
  profileId: number
): PrnMedForQuickLog[] {
  return getPrnQuickLogItems(profileId, true);
}

export type PrnIntakeItemForQuickLog = PrnMedForQuickLog & {
  displayName: string;
};

// Dashboard-only sibling: illness, medication Today/detail, and Telegram stay
// medication-scoped. Labels resolve against the whole profile item set so a shorter
// supplement name cannot collide with a control outside today's quick-log subset.
export function getPrnIntakeItemsForQuickLog(
  profileId: number
): PrnIntakeItemForQuickLog[] {
  const allItems = getIntakeItems(profileId);
  const labels = intakeShortLabels(allItems);
  const labelById = new Map(allItems.map((item, i) => [item.id, labels[i]]));
  return getPrnQuickLogItems(profileId, false).map((item) => ({
    ...item,
    displayName: labelById.get(item.id) ?? item.name,
  }));
}
