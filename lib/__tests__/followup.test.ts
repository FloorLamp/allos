import { describe, it, expect } from "vitest";
import {
  isFollowUpOverdue,
  followUpState,
  followUpSuppressionPolicy,
  isFollowUpHidden,
  normalizeResolution,
  FOLLOWUP_PREFIX,
} from "@/lib/followup";
import { isItemHiddenBySuppression } from "@/lib/upcoming-suppress";
import {
  imagingSourceLabel,
  imagingFollowUpTitle,
  findResolvingImagingStudy,
  imagingResolvingLabel,
} from "@/lib/followup-imaging";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import type { ImagingStudy } from "@/lib/types";
import type { FollowUpItemLike } from "@/lib/followup";

const TODAY = "2026-07-17";

function study(over: Partial<ImagingStudy> & { id: number }): ImagingStudy {
  return {
    id: over.id,
    modality: over.modality ?? "ct",
    body_region: over.body_region ?? null,
    laterality: over.laterality ?? null,
    contrast: over.contrast ?? false,
    contrast_agent: null,
    study_date: over.study_date ?? null,
    dose_msv: over.dose_msv ?? null,
    impression: over.impression ?? null,
    indication: null,
    status: null,
    ordering_provider_id: null,
    reading_provider_id: null,
    notes: null,
    source: null,
    document_id: null,
    external_id: null,
    created_at: "2026-01-01",
  };
}

const followUp: FollowUpItemLike = {
  id: 5,
  title: "Follow-up CT",
  plannedDate: "2026-03-01",
  recommendedIntervalDays: 365,
  source: { kind: "imaging", recordId: 1 },
  resolution: null,
};

describe("followup core — state machine", () => {
  it("isFollowUpOverdue is true only strictly past the planned date", () => {
    expect(isFollowUpOverdue("2026-07-16", TODAY)).toBe(true);
    expect(isFollowUpOverdue("2026-07-17", TODAY)).toBe(false); // today isn't overdue
    expect(isFollowUpOverdue("2026-08-01", TODAY)).toBe(false);
    expect(isFollowUpOverdue(null, TODAY)).toBe(false); // undated intent
  });

  it("followUpState: resolvable wins over date; else overdue vs upcoming", () => {
    // A resolving record present ⇒ resolvable, regardless of the date.
    expect(followUpState("2020-01-01", TODAY, true)).toBe("resolvable");
    expect(followUpState("2030-01-01", TODAY, true)).toBe("resolvable");
    // No resolving record: past date ⇒ overdue, else upcoming.
    expect(followUpState("2026-07-01", TODAY, false)).toBe("overdue");
    expect(followUpState("2026-08-01", TODAY, false)).toBe("upcoming");
    expect(followUpState(null, TODAY, false)).toBe("upcoming");
  });

  it("only an overdue follow-up is snooze-only (care-persistent)", () => {
    expect(followUpSuppressionPolicy("overdue")).toBe("snooze-only");
    expect(followUpSuppressionPolicy("upcoming")).toBe("normal");
    expect(followUpSuppressionPolicy("resolvable")).toBe("normal");
  });

  it("normalizeResolution accepts only the closed set (case-insensitive)", () => {
    expect(normalizeResolution("resolved")).toBe("resolved");
    expect(normalizeResolution("STABLE")).toBe("stable");
    expect(normalizeResolution(" Changed ")).toBe("changed");
    expect(normalizeResolution("grew")).toBeNull();
    expect(normalizeResolution("")).toBeNull();
    expect(normalizeResolution(undefined)).toBeNull();
  });

  it("dedupeKey prefix is registered so the finding is guardable (#448)", () => {
    expect(dedupeKeyHasKnownPrefix(`${FOLLOWUP_PREFIX}5`)).toBe(true);
  });
});

// The care-tier persistence CONTRACT (#700 ask 5 / #449) — the load-bearing pin:
// an overdue follow-up produced past its date is NOT silenced by a blanket
// (dismiss) bus suppression, but a deliberate time-boxed snooze still defers it.
describe("followup core — care-tier persistence contract", () => {
  const overduePolicy = followUpSuppressionPolicy(
    followUpState("2026-03-01", TODAY, false) // past ⇒ overdue
  );

  it("an OVERDUE follow-up RESISTS an indefinite dismiss", () => {
    expect(overduePolicy).toBe("snooze-only");
    const dismissed = {
      snooze_until: null,
      dismissed_at: "2026-07-01T00:00:00Z",
    };
    // The blanket dismiss must NOT hide the overdue safety follow-up.
    expect(isFollowUpHidden(overduePolicy, dismissed, TODAY)).toBe(false);
  });

  it("an OVERDUE follow-up HONORS a live snooze, and reappears once it expires", () => {
    const liveSnooze = { snooze_until: "2026-07-25", dismissed_at: null };
    expect(isFollowUpHidden(overduePolicy, liveSnooze, TODAY)).toBe(true);
    const expiredSnooze = { snooze_until: "2026-07-10", dismissed_at: null };
    expect(isFollowUpHidden(overduePolicy, expiredSnooze, TODAY)).toBe(false);
    expect(isFollowUpHidden(overduePolicy, undefined, TODAY)).toBe(false);
  });

  it("an UPCOMING follow-up is fully suppressible (dismiss hides it)", () => {
    const upcoming = followUpSuppressionPolicy(
      followUpState("2026-09-01", TODAY, false)
    );
    const dismissed = {
      snooze_until: null,
      dismissed_at: "2026-07-01T00:00:00Z",
    };
    expect(isFollowUpHidden(upcoming, dismissed, TODAY)).toBe(true);
  });

  it("the shared item dispatcher enforces the same contract via carePersistent", () => {
    const dismissed = {
      snooze_until: null,
      dismissed_at: "2026-07-01T00:00:00Z",
    };
    // carePersistent item resists the dismiss…
    expect(
      isItemHiddenBySuppression({ carePersistent: true }, dismissed, TODAY)
    ).toBe(false);
    // …but an ordinary item is hidden by it.
    expect(isItemHiddenBySuppression({}, dismissed, TODAY)).toBe(true);
    // A live snooze still hides the carePersistent item.
    expect(
      isItemHiddenBySuppression(
        { carePersistent: true },
        { snooze_until: "2026-07-25", dismissed_at: null },
        TODAY
      )
    ).toBe(true);
  });
});

describe("imaging adapter", () => {
  it("labels the source finding from the impression + study month", () => {
    const s = study({
      id: 1,
      modality: "ct",
      body_region: "Chest",
      study_date: "2026-03-04",
      impression: "6 mm RLL nodule, recommend follow-up CT in 12 months",
    });
    const label = imagingSourceLabel(s);
    expect(label).toContain("6 mm RLL nodule");
    expect(label).toContain("(2026-03)");
  });

  it("falls back to the study display label when there's no impression", () => {
    const s = study({
      id: 1,
      modality: "mri",
      body_region: "Knee",
      laterality: "left",
      study_date: "2026-02-01",
    });
    expect(imagingSourceLabel(s)).toContain("MRI");
  });

  it("names the follow-up by modality (+ region)", () => {
    expect(imagingFollowUpTitle(study({ id: 1, modality: "ct" }))).toBe(
      "Follow-up CT"
    );
    expect(
      imagingFollowUpTitle(
        study({ id: 1, modality: "ct", body_region: "Chest" })
      )
    ).toBe("Follow-up CT chest");
  });

  it("resolves against a LATER same-modality study, never a cross-modality one", () => {
    const source = study({
      id: 1,
      modality: "ct",
      body_region: "Chest",
      study_date: "2026-03-04",
    });
    const laterCt = study({
      id: 2,
      modality: "ct",
      body_region: "Chest w/o contrast",
      study_date: "2027-03-10",
    });
    const laterUltrasound = study({
      id: 3,
      modality: "ultrasound",
      body_region: "Chest",
      study_date: "2027-04-01",
    });
    const earlierCt = study({
      id: 4,
      modality: "ct",
      body_region: "Chest",
      study_date: "2025-01-01",
    });
    const candidates = [source, laterCt, laterUltrasound, earlierCt];
    const resolving = findResolvingImagingStudy(source, followUp, candidates);
    expect(resolving?.id).toBe(2); // the later CT, not the ultrasound, not the earlier CT
  });

  it("returns null when only earlier or the source itself is present", () => {
    const source = study({ id: 1, modality: "ct", study_date: "2026-03-04" });
    expect(findResolvingImagingStudy(source, followUp, [source])).toBeNull();
    const undatedSource = study({ id: 1, modality: "ct", study_date: null });
    expect(
      findResolvingImagingStudy(undatedSource, followUp, [
        undatedSource,
        study({ id: 2, modality: "ct", study_date: "2027-01-01" }),
      ])
    ).toBeNull();
  });

  it("picks the MOST RECENT qualifying later study", () => {
    const source = study({ id: 1, modality: "ct", study_date: "2026-01-01" });
    const a = study({ id: 2, modality: "ct", study_date: "2026-06-01" });
    const b = study({ id: 3, modality: "ct", study_date: "2027-06-01" });
    expect(
      findResolvingImagingStudy(source, followUp, [source, a, b])?.id
    ).toBe(3);
  });

  it("imagingResolvingLabel is compact and dated", () => {
    const s = study({
      id: 2,
      modality: "ct",
      body_region: "Chest",
      study_date: "2027-03-10",
    });
    expect(imagingResolvingLabel(s)).toContain("2027-03");
  });
});
