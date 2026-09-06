import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PracticeWeeklyProgress from "@/components/practices/PracticeWeeklyProgress";
import type { FrequencyPace } from "@/lib/frequency-targets";

afterEach(cleanup);

// The badge is a VERDICT, and a quiet week has none (#5395): the row prints its count
// and no word, where it used to print "On pace" over a week nothing had happened in.
// The weekly maximum outranks every pace, quiet included.
describe("the practice row's pace badge", () => {
  it.each<{ pace: FrequencyPace; atCeiling: boolean; badge: string | null }>([
    { pace: "quiet", atCeiling: false, badge: null },
    { pace: "on-pace", atCeiling: false, badge: "On pace" },
    { pace: "behind", atCeiling: false, badge: "Behind" },
    { pace: "met", atCeiling: false, badge: "On track" },
    { pace: "quiet", atCeiling: true, badge: "Weekly maximum reached" },
  ])("$pace, atCeiling $atCeiling → $badge", ({ pace, atCeiling, badge }) => {
    render(
      <PracticeWeeklyProgress
        count={0}
        perWeek={2}
        perWeekMax={null}
        pace={pace}
        atCeiling={atCeiling}
        testId="row"
      />
    );
    const row = screen.getByTestId("row");
    expect(row.textContent).toContain("No days this week");
    const badges = row.querySelectorAll(".badge");
    expect(badges).toHaveLength(badge == null ? 0 : 1);
    if (badge != null) expect(badges[0].textContent).toBe(badge);
  });
});
