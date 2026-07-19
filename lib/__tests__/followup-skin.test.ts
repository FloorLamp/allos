import { describe, it, expect } from "vitest";
import {
  skinFollowUpAdapter,
  skinSourceLabel,
  skinFollowUpTitle,
  findResolvingSkinRecord,
  skinResolvingLabel,
  SKIN_FOLLOWUP_KIND,
} from "@/lib/followup-skin";
import type { SkinLesion } from "@/lib/types";

function les(p: Partial<SkinLesion>): SkinLesion {
  return {
    id: 1,
    label: "Left forearm mole",
    body_region: "forearm",
    body_side: "left",
    size_mm: 5,
    asymmetry: 0,
    border: 0,
    color: 0,
    diameter: 0,
    evolving: 0,
    status: "watch",
    observed_date: "2026-03-01",
    finding: null,
    follow_up_interval_days: 90,
    provider_id: null,
    notes: null,
    source: null,
    document_id: null,
    external_id: null,
    created_at: "2026-03-01",
    ...p,
  };
}

describe("skin follow-up adapter (#715 ask 3)", () => {
  it("source label leads with the lesion + body map, appends ABCDE letters + a YYYY-MM tail", () => {
    expect(skinSourceLabel(les({ asymmetry: 1, evolving: 1 }))).toBe(
      "Left forearm mole · Left forearm · ABCDE A·E (2026-03)"
    );
    // No ABCDE set → just the lesion + map + month.
    expect(skinSourceLabel(les({}))).toBe(
      "Left forearm mole · Left forearm (2026-03)"
    );
  });

  it("follow-up title names the lesion when labeled", () => {
    expect(skinFollowUpTitle(les({}))).toBe(
      "Recheck skin lesion — Left forearm mole"
    );
    expect(
      skinFollowUpTitle(
        les({ label: null, body_region: null, body_side: null })
      )
    ).toBe("Recheck skin lesion");
  });

  it("resolves against a LATER record of the SAME lesion", () => {
    const source = les({ id: 1, observed_date: "2026-03-01" });
    const laterSame = les({
      id: 2,
      status: "active",
      observed_date: "2026-06-01",
    });
    const laterOther = les({
      id: 3,
      label: "Right shoulder mole",
      body_region: "shoulder",
      body_side: "right",
      observed_date: "2026-07-01",
    });
    const earlierSame = les({ id: 4, observed_date: "2026-01-01" });
    const resolving = findResolvingSkinRecord(source, {} as never, [
      source,
      laterSame,
      laterOther,
      earlierSame,
    ]);
    expect(resolving?.id).toBe(2);
    expect(skinResolvingLabel(laterSame)).toBe("Left forearm mole · 2026-06");
  });

  it("returns null when no later same-lesion record exists", () => {
    const source = les({ id: 1, observed_date: "2026-03-01" });
    const other = les({
      id: 3,
      label: "Right shoulder mole",
      body_region: "shoulder",
      body_side: "right",
      observed_date: "2026-10-01",
    });
    expect(
      findResolvingSkinRecord(source, {} as never, [source, other])
    ).toBeNull();
  });

  it("exposes the adapter shape with kind='skin'", () => {
    expect(skinFollowUpAdapter.kind).toBe(SKIN_FOLLOWUP_KIND);
    expect(SKIN_FOLLOWUP_KIND).toBe("skin");
  });
});
