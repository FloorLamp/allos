// SERVER-ACTION TIER — the risk-factors review marker (issue #1045).
//
// saveRiskFactors gained a write beyond setRiskAttributes: it stamps the
// risk-attributes-REVIEWED marker so the data-quality "review risk factors" gap clears
// once the user has looked at the list — even when they leave every flag off (absence
// of flags can't distinguish an intentional empty review from a fresh profile). The
// pure/DB tiers can't see the auth-gated action write, so this pins it: after the
// action, getRiskAttributesReviewed is true (and the attributes wrote through), and the
// data-quality builder no longer emits the risk gap for an adult.
//
// #2299 gave that empty submission a CONTROL — the form's "None of these apply"
// footer button, which posts the current all-false payload through this same action.
// The last case pins what that write may touch: the marker row and nothing else,
// twice over.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveRiskFactors } from "@/app/(app)/medical/background/actions";
import {
  getRiskAttributesReviewed,
  getRiskAttributes,
  setUserBirthdate,
} from "@/lib/settings";
import { buildDataQualityFindings } from "@/lib/rule-findings";
import { dataQualityDedupeKey } from "@/lib/data-quality";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("saveRiskFactors — review marker (#1045)", () => {
  it("stamps reviewed even with every flag left off, and clears the data-quality gap", () => {
    const { profile } = seedActor();
    setUserBirthdate(profile.id, "1985-01-01"); // adult → the risk gap is eligible

    // Before review: the adult profile shows the risk-attributes gap.
    const before = buildDataQualityFindings(profile.id).map((f) => f.dedupeKey);
    expect(before).toContain(dataQualityDedupeKey("risk-attributes"));
    expect(getRiskAttributesReviewed(profile.id)).toBe(false);

    // Submit the form with NO flags checked — an intentional empty review.
    return saveRiskFactors(fd({})).then(() => {
      expect(getRiskAttributesReviewed(profile.id)).toBe(true);
      // The empty submission left every attribute false…
      expect(getRiskAttributes(profile.id)).toEqual({
        healthcareWorker: false,
        immunocompromised: false,
        dialysis: false,
        pregnant: false,
        noiseExposure: false,
      });
      // …yet the gap is gone (the review happened).
      const after = buildDataQualityFindings(profile.id).map(
        (f) => f.dedupeKey
      );
      expect(after).not.toContain(dataQualityDedupeKey("risk-attributes"));
      // It revalidates the dashboard so the widget refreshes.
      expect(revalidate).toHaveBeenCalledWith("/");
    });
  });

  // #2299: the footer's "None of these apply" button submits exactly this payload —
  // the current, all-false attributes — so what it writes IS the negative
  // declaration and nothing more. Asserted on the ROWS, not the getter: an
  // all-false getter result would also be satisfied by five stored "0" values, and
  // "declaring the negative writes no flag" is the property the footer promises.
  // A second press must be a no-op beyond re-stamping the marker.
  it("the negative declaration writes NO risk_* flag row, and repeats idempotently", async () => {
    const { profile } = seedActor();
    const riskRows = () =>
      db
        .prepare(
          `SELECT key, value FROM profile_settings
            WHERE profile_id = ? AND key LIKE 'risk\\_%' ESCAPE '\\'
            ORDER BY key`
        )
        .all(profile.id) as { key: string; value: string }[];

    expect(riskRows()).toEqual([]);

    await saveRiskFactors(fd({}));
    // The ONLY risk_* row is the review marker — no flag was invented to record
    // the absence of flags.
    expect(riskRows()).toEqual([
      { key: "risk_attributes_reviewed", value: "1" },
    ]);

    // Pressing again (or a stale tab replaying it) changes nothing.
    await saveRiskFactors(fd({}));
    expect(riskRows()).toEqual([
      { key: "risk_attributes_reviewed", value: "1" },
    ]);
    expect(getRiskAttributesReviewed(profile.id)).toBe(true);
  });

  it("persists a checked flag through the same action", () => {
    const { profile } = seedActor();
    return saveRiskFactors(fd({ immunocompromised: "1" })).then(() => {
      expect(getRiskAttributes(profile.id).immunocompromised).toBe(true);
      expect(getRiskAttributesReviewed(profile.id)).toBe(true);
    });
  });
});
