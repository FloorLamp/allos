// DB INTEGRATION TIER — the clinical-result detail page's "Seen it" stays SECONDARY,
// and this pins that it is held rather than overlooked (#4014, 2026-09-10).
//
// WHAT IS BEING HELD. Mechanically the control is a form's one commit, so #4978's
// 2026-09-04 13:05 UTC form rule ("the surface is the FORM") would fill it, and a
// census of unpromoted form commits lands on it every time. But that rule ranks
// controls without weighing what they do. This block renders only for
// `isNotableFlag`, so its surface is always an ABNORMAL result, and one tap writes
// the shared analyte acknowledgment that quiets the flag, the trajectory watch and
// the dashboard atom together. The Recheck scheduler beside it does the opposite.
// Filling this one would make the loudest control on the page the one that silences
// the warning. That is visible safety direction and belongs to the owner, so the
// promotion is withheld pending their ruling.
//
// SO THE FAILURE THIS CATCHES IS A MECHANICAL RE-PROMOTION: the next lane sweeping
// form commits promotes this mount on the rule alone, gates stay green, and the
// held decision is lost silently. The page comment explains why; this makes it fail.
// When the owner rules, this test is updated or deleted in the change that applies
// the ruling — it pins a held state, not a permanent one.
//
// WHY THIS TIER. The control has no component of its own — it is inline in a server
// page that reads the session and the record through the real query layer — so this
// is the cheapest place that can render it. It reads the rendered markup rather than
// the call site, because `ButtonProps` is closed and both wrappers forward by name.
//
// THE POSITIVE CONTROL IS REAL, NOT ASSUMED. This asserts an ABSENCE, so the last
// case renders a known `variant="primary"` through the same markup-and-match path
// and requires the detector to call it loud. A harness that had stopped seeing the
// primary class would pass the two absence checks and fail that one.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { db } from "@/lib/db";
import Button from "@/components/Button";
import { ToastProvider } from "@/components/Toast";
import ClinicalResultDetailPage from "@/app/(app)/results/clinical-results/view/page";
import { seedActor } from "../__action_tests__/harness";

const CONTROL = /<button[^>]*data-button-control[^>]*>/g;
const isLoud = (control: string | undefined) =>
  control?.includes("button-control-primary") ?? false;

async function renderFlaggedResult(): Promise<string> {
  const { profile } = seedActor();
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
     VALUES (?, '2026-03-15', 'lab', 'CHOLESTEROL, TOTAL', 'Total Cholesterol',
             '300', 300, 'mg/dL', 'high')`
  ).run(profile.id);
  const page = await ClinicalResultDetailPage({
    searchParams: Promise.resolve({ name: "Total Cholesterol" }),
  });
  // The page mounts the star, whose toast channel is a provider higher in the app
  // shell; supplying it renders the page rather than the shell.
  return renderToStaticMarkup(
    createElement(ToastProvider, null, page as ReactNode)
  );
}

describe("the clinical result's acknowledgment rank (#4014)", () => {
  it("leaves 'Seen it' quiet, and the page spends no loud control", async () => {
    const controls = (await renderFlaggedResult()).match(CONTROL) ?? [];

    const seenIt = controls.find((c) =>
      c.includes('data-testid="result-acknowledge-submit"')
    );
    expect(seenIt).toBeDefined();
    expect(isLoud(seenIt)).toBe(false);

    // The Recheck scheduler is the second form on the same card, and the control
    // that keeps the finding in view. It is quiet too, so neither outranks the other.
    const recheck = controls.find((c) =>
      c.includes('aria-label="Track follow-up"')
    );
    expect(recheck).toBeDefined();
    expect(isLoud(recheck)).toBe(false);

    expect(controls.filter(isLoud)).toHaveLength(0);
  });

  it("would see a loud control if one were there", () => {
    // `children` goes IN the props object: `ButtonProps.children` is required, and
    // `createElement`'s positional children never satisfy a required `children` in the
    // props type. Moving "Loud" back out to a third argument is a compile error.
    const markup = renderToStaticMarkup(
      createElement(Button, { variant: "primary" as const, children: "Loud" })
    );
    expect(isLoud((markup.match(CONTROL) ?? [])[0])).toBe(true);
  });
});
