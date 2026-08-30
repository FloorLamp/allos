import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import {
  EXPECTED_REGISTRY_SIZE,
  LEAD_MAX_CHARS,
  leadDefects,
  sentenceCount,
} from "@/lib/lead-fold-census";

// THE PURE HALF of the lead+fold census (#3488, #3490). It asks the source
// question — "can a wall of text still ship in a field called `lead`?" — and it is
// paired with e2e/lead-fold-census.mobile.spec.ts, which asks the rendered one.
//
// Everything here is deliberately ABSENCE-shaped ("no lead exceeds the budget"),
// which fails OPEN, so the file carries the three things #3509 asks of that shape:
// a CENSUS FLOOR (the registry's size, asserted, so a scan that finds nothing
// fails), SYNTHETIC OFFENDERS (leads authored to break the rule, required back),
// and SILENCE on the benign neighbours the rule must not touch.

describe("the lead rule can SEE a wall of text", () => {
  // The offenders are the REAL shipped strings this issue pair was filed about,
  // not invented ones: a guard proved against a fabricated defect has not been
  // proved against the defect. These are verbatim from registry.ts at
  // 60cf8dc0 — the tree #3490 measured.
  const SHIPPED_WALLS: { id: string; blurb: string }[] = [
    {
      id: "health-connect (72 words, seven lines at 390px)",
      blurb:
        "Sync weight, body fat, resting heart rate, steps, heart rate, and workouts " +
        "from your Android phone. An exporter app on the phone pushes Health Connect " +
        "data to this app on a schedule. It's also the supported way to bring in " +
        "nutrition: food trackers like MyFitnessPal, Cronometer, Lose It!, and Yazio " +
        "write your logged macros to Health Connect, so calories and protein/carbs/fat " +
        "flow through here and chart on Trends → Nutrition → Macros.",
    },
    {
      id: "weather (73 words)",
      blurb:
        "Bring in the actual UV index and solar irradiance at your home location, so " +
        "your outdoor daylight time becomes a two-sided UV dose — enough sun for " +
        "vitamin D and circadian light, but a heads-up before you'd burn. Powered by " +
        "Open-Meteo: no API key or account, and its free historical archive backfills " +
        "the UV for activities you already logged. Needs only your home location " +
        "(Settings → Profile); works offline with a clear-sky estimate.",
    },
    {
      id: "fitbit-takeout (146 words, the registry's longest)",
      blurb:
        "Import a Fitbit account export downloaded from Google Takeout. This is the " +
        "only way to bring in body composition from a scale that syncs to Fitbit: " +
        "Fitbit does not forward weight or body fat to Health Connect, so those " +
        "readings — often years of them — are invisible to the phone exporter.",
    },
    {
      id: "the Import intro's standards wall (#3488)",
      blurb:
        "Drop in a lab report or scan (PDF, image, or spreadsheet) and the AI reads " +
        "your results — or a health-record export (a MyChart “Download Summary” " +
        "CCD/XDM package, a SMART Health Card, or a FHIR bundle from Epic / Apple " +
        "Health) to import your immunizations, labs, and vitals directly.",
    },
  ];

  it("flags every wall this issue pair was filed about", () => {
    for (const { id, blurb } of SHIPPED_WALLS) {
      expect(
        leadDefects(blurb, { maxSentences: 1 }),
        `the census must SEE the ${id} wall — a rule blind to the exact string ` +
          `that was shipped is worse than no rule, because it converts "nobody ` +
          `has done this" into "nobody can do this"`
      ).not.toEqual([]);
    }
  });

  it("flags a one-sentence lead that is merely too long", () => {
    // The subtler offender: obeys the sentence rule, still four lines on a phone.
    const long =
      "Sync weight, body fat, resting heart rate, steps, heart rate, workouts, " +
      "sleep, blood pressure, glucose and hydration from your Android phone.";
    expect(sentenceCount(long)).toBe(1);
    expect(leadDefects(long, { maxSentences: 1 }).map((d) => d.kind)).toEqual([
      "too-long",
    ]);
  });

  it("flags a short lead that is three sentences", () => {
    const chatty = "Sync your phone. It pushes on a schedule. Nutrition too.";
    expect(chatty.length).toBeLessThanOrEqual(LEAD_MAX_CHARS);
    expect(leadDefects(chatty, { maxSentences: 1 }).map((d) => d.kind)).toEqual(
      ["too-many-sentences"]
    );
  });

  it("flags an empty lead rather than calling it clean", () => {
    // The fail-open shape in miniature: "" satisfies every ceiling.
    expect(leadDefects("   ", { maxSentences: 1 }).map((d) => d.kind)).toEqual([
      "empty",
    ]);
  });
});

describe("the lead rule stays QUIET on the benign neighbours", () => {
  it("does not count the period inside a product name or an abbreviation", () => {
    // "Lose It!" is a real food tracker named in the health-connect detail, and a
    // sentence counter that scores it as a terminator would flag correct copy.
    expect(sentenceCount("Trackers like Lose It! write macros here")).toBe(1);
    expect(sentenceCount("Works with Dr. Chen's portal")).toBe(1);
    expect(sentenceCount("Backfills 2.5 years of UV")).toBe(1);
  });

  it("accepts a lead sitting exactly on the budget", () => {
    const exact = "x".repeat(LEAD_MAX_CHARS);
    expect(leadDefects(exact, { maxSentences: 1 })).toEqual([]);
  });

  it("does not require a terminal period — a fragment is one sentence", () => {
    expect(
      leadDefects("Runs, rides, and other activities", { maxSentences: 1 })
    ).toEqual([]);
  });
});

describe("every shipped integration lead obeys the rule", () => {
  // THE CENSUS FLOOR. Every assertion below is "no entry is bad", which passes
  // trivially over an empty list — so the size of what was examined is asserted
  // first, and against a recorded number rather than against itself.
  it("examines the whole registry", () => {
    expect(
      INTEGRATIONS.length,
      "the registry changed size: raise EXPECTED_REGISTRY_SIZE in the same change " +
        "that adds or removes an integration, so this census cannot go green by " +
        "scanning a list that quietly emptied"
    ).toBe(EXPECTED_REGISTRY_SIZE);
  });

  it("gives each entry a one-sentence lead inside the two-line budget", () => {
    for (const def of INTEGRATIONS) {
      expect(
        leadDefects(def.lead, { maxSentences: 1 }),
        `${def.id}: ${def.lead}`
      ).toEqual([]);
    }
  });

  it("puts the long-form claims in `detail`, not in the lead", () => {
    // #3490's fourth acceptance criterion: no factual claim from the old blurbs is
    // deleted. The three worst entries are the ones whose material had to go
    // somewhere, so each is required to HAVE a fold with real content behind it —
    // an empty `detail` would mean the words were dropped rather than folded.
    for (const id of ["fitbit-takeout", "weather", "health-connect"]) {
      const def = INTEGRATIONS.find((d) => d.id === id)!;
      expect(def.detail, `${id} must keep its folded detail`).toBeTruthy();
      expect(def.detail!.length).toBeGreaterThan(LEAD_MAX_CHARS);
    }
  });

  it("keeps the vendor names findable, folded rather than front-loaded", () => {
    // The named ones from #3490 ("Vendor names people recognize … live in the
    // detail, findable but not front-loaded"). Asserted in BOTH directions: present
    // in the detail, absent from the lead.
    const hc = INTEGRATIONS.find((d) => d.id === "health-connect")!;
    for (const vendor of ["MyFitnessPal", "Cronometer", "Lose It!", "Yazio"]) {
      expect(hc.detail, `${vendor} must stay findable`).toContain(vendor);
      expect(hc.lead).not.toContain(vendor);
    }
  });
});

describe("the Import intro is the same primitive, adopted", () => {
  // The Import card's lead is JSX, not a registry string, so the pure tier reads
  // the source. That is a weaker check than the registry's and it is not the
  // guard for this surface — e2e/lead-fold-census.mobile.spec.ts measures the
  // rendered box. What this asserts is the ADOPTION: that the surface goes
  // through the shared primitive rather than growing a second one, which is the
  // whole reason #3488 and #3490 were built together.
  const source = readFileSync(
    join(process.cwd(), "components/UploadForm.tsx"),
    "utf8"
  );

  it("renders through LeadFold", () => {
    expect(source).toContain('import LeadFold from "@/components/LeadFold"');
    expect(source).toContain("<LeadFold");
  });

  it("names the standards alphabet only inside the fold", () => {
    // MATCHED ON THE PROPS, not on the file (#3404's lesson: a file-level grep is
    // wrong in both directions at once). CCD/XDM, SMART Health Card and FHIR all
    // appear in this file's HEADER COMMENT, which is documentation and must stay;
    // what #3488 moved is where they appear in the RENDERED intro. So the check
    // slices the two JSX props apart and asks each one separately.
    const lead = propBlock(source, "lead=");
    const detail = propBlock(source, "detail=");
    for (const term of ["CCD/XDM", "SMART Health Card", "FHIR"]) {
      expect(lead, `${term} must not lead`).not.toContain(term);
      expect(detail, `${term} must stay findable in the fold`).toContain(term);
    }
    // And the lead is the sentence #3488 specified, so a future edit that quietly
    // grows it back is a diff somebody has to justify.
    expect(lead).toContain(
      "Drop in a lab report, scan, or health-record export"
    );
    expect(lead).toContain("Several files at once is fine");
  });

  it("keeps ONE control named Upload, and it is the submit", () => {
    // #3488 fix 2, tightened by #3286. "Choose files" used to appear TWICE — the
    // desktop dropzone's label and the mobile button that took it — because there
    // were two viewport-shaped doors. There is now ONE door on every width
    // (<MediaInput>'s trigger), so one occurrence is the convergence landing, not
    // a door going missing. "Upload" still survives exactly once, on the submit,
    // which is the property this case has always been about.
    const labels = [...source.matchAll(/^\s+(Upload|Choose files)$/gm)].map(
      (m) => m[1]
    );
    expect(labels.filter((l) => l === "Choose files")).toHaveLength(1);
    expect(labels.filter((l) => l === "Upload")).toHaveLength(1);
    // Order matters for the defect being closed: the picker's label comes first
    // in the form, the submit's last.
    expect(labels.at(-1)).toBe("Upload");
  });

  it("renders the submit row only once something is selected", () => {
    // #3488 fix 2's second half: the post-submit explainer used to render above an
    // empty card. The gate is asserted on the SOURCE here and on the rendered DOM
    // in the e2e probe.
    expect(source).toContain("{selected.length > 0 && (");
    expect(source).toContain('data-testid="medical-upload-submit"');
  });
});

/**
 * The text of one JSX prop's value, from `name` to the line that closes it.
 *
 * Crude on purpose and safe for exactly this shape: both props are written as
 * `lead={ … }` / `detail={ … }` blocks in `components/UploadForm.tsx`, and the
 * closing `        }` at the prop's own indentation is unambiguous there. If this
 * ever stops matching, the assertions above go RED (an empty slice contains
 * nothing), which is the direction a scope error should fail in.
 */
function propBlock(source: string, name: string): string {
  const start = source.indexOf(name);
  expect(start, `${name} must exist in UploadForm.tsx`).toBeGreaterThan(0);
  const end = source.indexOf("\n        }", start);
  expect(end, `${name} must be a braced block`).toBeGreaterThan(start);
  const block = source.slice(start, end);
  expect(block.length, `${name} block must not be empty`).toBeGreaterThan(20);
  return block;
}
