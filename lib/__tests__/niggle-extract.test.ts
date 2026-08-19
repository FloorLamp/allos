import { describe, expect, it } from "vitest";
import { detectNiggles, niggleChipPrompt } from "../niggle-extract";
import {
  NIGGLE_BODY_TERMS,
  NIGGLE_SENTIMENT_TERMS,
  bodyTermRegion,
} from "../curated/niggle-lexicon";
import { REGION_SCOPES } from "../lifts";
import {
  NIGGLE_QUIET_DAYS,
  isNiggleLive,
  liveNiggles,
  niggleExpiresAt,
  niggleKey,
  niggleLabel,
} from "../niggle-model";

// Issue #2948 parts 1 and 2. The two REAL prod notes are the acceptance fixtures and are
// named as such: the `injuries` table is empty while these two lines sit in
// `activities.notes`, which is the whole reason this tier exists.
const REAL_NOTE_KNEE = "right knee weird";
const REAL_NOTE_HIP = "left hip no good";

describe("the two real notes from #2948", () => {
  it("reads 'right knee weird' as a right-side Legs candidate", () => {
    const { candidates } = detectNiggles(REAL_NOTE_KNEE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].region).toBe("Legs");
    expect(candidates[0].laterality).toBe("right");
    expect(candidates[0].bodyTerm).toBe("knee");
    expect(candidates[0].sentimentTerm).toBe("weird");
  });

  it("reads 'left hip no good' as a left-side Glutes candidate", () => {
    const { candidates } = detectNiggles(REAL_NOTE_HIP);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].region).toBe("Glutes");
    expect(candidates[0].laterality).toBe("left");
    expect(candidates[0].bodyTerm).toBe("hip");
    // "no good" must win over the bare negator "no" — otherwise the note reads as a
    // negated nothing and the real signal is lost.
    expect(candidates[0].sentimentTerm).toBe("no good");
  });

  it("offers both when one note carries both, split on the comma", () => {
    const { candidates } = detectNiggles(`${REAL_NOTE_KNEE}, ${REAL_NOTE_HIP}`);
    expect(candidates.map((c) => `${c.laterality} ${c.bodyTerm}`)).toEqual([
      "right knee",
      "left hip",
    ]);
  });
});

describe("one region vocabulary (#2948 invariant)", () => {
  it("resolves every curated body term into REGION_SCOPES", () => {
    for (const entry of NIGGLE_BODY_TERMS)
      expect(REGION_SCOPES, entry.term).toContain(bodyTermRegion(entry));
  });

  it("emits only REGION_SCOPES regions from real notes", () => {
    for (const term of NIGGLE_BODY_TERMS) {
      const { candidates } = detectNiggles(`${term.term} sore`);
      for (const c of candidates) expect(REGION_SCOPES).toContain(c.region);
    }
  });
});

describe("ambiguity is answered, never guessed", () => {
  it("names no region when the sentiment word stands alone", () => {
    const r = detectNiggles("everything sore today");
    expect(r.candidates).toEqual([]);
    expect(r.sentimentWithoutRegion).toEqual(["everything sore today"]);
  });

  it("declines a clause naming two different regions", () => {
    const r = detectNiggles("knee and shoulder weird");
    expect(r.candidates).toEqual([]);
    expect(r.ambiguousRegion).toEqual(["knee and shoulder weird"]);
  });

  it("still answers when two body terms share one region", () => {
    const r = detectNiggles("quad and knee sore");
    expect(r.ambiguousRegion).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].region).toBe("Legs");
  });

  it("leaves laterality null when the note names no side", () => {
    const { candidates } = detectNiggles("knee sore");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].laterality).toBeNull();
  });

  it("refuses to promote a left-and-right pair to bilateral", () => {
    const r = detectNiggles("left and right knee sore");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].laterality).toBeNull();
    expect(r.ambiguousLaterality).toEqual(["left and right knee sore"]);
  });

  it("reads an explicit 'both' as bilateral — the only route to it", () => {
    const { candidates } = detectNiggles("both knees sore");
    expect(candidates[0].laterality).toBe("bilateral");
  });

  it("says nothing about a body part named without a complaint", () => {
    expect(detectNiggles("knee sleeves, belt").candidates).toEqual([]);
  });

  it("drops a negated complaint rather than inverting it", () => {
    const r = detectNiggles("knee not sore today");
    expect(r.candidates).toEqual([]);
    expect(r.sentimentWithoutRegion).toEqual([]);
  });

  it("de-duplicates a note that says the same thing twice", () => {
    const { candidates } = detectNiggles("right knee sore. right knee weird");
    expect(candidates).toHaveLength(1);
  });

  it("reads nothing out of an empty or absent note", () => {
    expect(detectNiggles(null).candidates).toEqual([]);
    expect(detectNiggles("   ").candidates).toEqual([]);
  });
});

describe("conservative-list discipline", () => {
  it("keeps the bare word 'back' out of the vocabulary", () => {
    // "back squat felt weird" must not become a Back-region niggle.
    expect(detectNiggles("back squat felt weird").candidates).toEqual([]);
    // The qualified form still lands.
    expect(detectNiggles("lower back tight").candidates[0].region).toBe("Back");
  });

  it("keeps 'off' and 'bad' out of the sentiment vocabulary", () => {
    expect(NIGGLE_SENTIMENT_TERMS).not.toContain("off");
    expect(NIGGLE_SENTIMENT_TERMS).not.toContain("bad");
    expect(detectNiggles("knee felt off").candidates).toEqual([]);
  });

  it("does not read single-letter side shorthand as a side", () => {
    expect(detectNiggles("r knee sore").candidates[0].laterality).toBeNull();
  });
});

describe("the chip's copy", () => {
  it("asks rather than announces, and names the person's own word", () => {
    const c = detectNiggles(REAL_NOTE_KNEE).candidates[0];
    expect(niggleChipPrompt(c)).toBe(
      "Sounds like a right knee niggle — track it?"
    );
  });

  it("says both sides explicitly rather than picking one", () => {
    const c = detectNiggles("both knees sore").candidates[0];
    expect(niggleChipPrompt(c)).toContain("both sides");
  });
});

describe("the quiet spell (#2948 part 1)", () => {
  const day = (n: number) =>
    new Date(Date.UTC(2026, 7, 1) + n * 86_400_000).toISOString().slice(0, 19) +
    "Z";

  it("names the expiry window as a constant in the decided range", () => {
    expect(NIGGLE_QUIET_DAYS).toBeGreaterThanOrEqual(10);
    expect(NIGGLE_QUIET_DAYS).toBeLessThanOrEqual(14);
  });

  it("is live right up to the boundary and expired at it", () => {
    const n = { lastReportedAt: day(0) };
    expect(isNiggleLive(n, day(NIGGLE_QUIET_DAYS - 1))).toBe(true);
    expect(isNiggleLive(n, day(NIGGLE_QUIET_DAYS))).toBe(false);
  });

  it("expires exactly NIGGLE_QUIET_DAYS after the last report", () => {
    expect(niggleExpiresAt(day(0))).toBe(day(NIGGLE_QUIET_DAYS));
  });

  it("treats an undateable stamp as expired, never as immortal", () => {
    expect(isNiggleLive({ lastReportedAt: "not a date" }, day(0))).toBe(false);
  });

  it("keeps input order in the live subset", () => {
    const rows = [
      { lastReportedAt: day(0) },
      { lastReportedAt: day(20) },
      { lastReportedAt: day(19) },
    ];
    expect(liveNiggles(rows, day(20))).toEqual([rows[1], rows[2]]);
  });
});

describe("niggle identity and label", () => {
  it("keeps an unstated side distinct from a stated one", () => {
    expect(niggleKey("Legs", null)).not.toBe(niggleKey("Legs", "right"));
  });

  it("says the person's own word, with the side they gave", () => {
    expect(
      niggleLabel({ region: "Legs", laterality: "right", bodyTerm: "knee" })
    ).toBe("right knee");
    expect(
      niggleLabel({ region: "Glutes", laterality: null, bodyTerm: "hip" })
    ).toBe("hip");
    expect(
      niggleLabel({ region: "Legs", laterality: null, bodyTerm: null })
    ).toBe("Legs");
  });
});
