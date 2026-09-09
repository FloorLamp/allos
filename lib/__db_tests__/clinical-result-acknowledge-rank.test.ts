// DB INTEGRATION TIER — the clinical-result detail page's "Seen it" is its form's
// commit, so it carries the primary paint (#4014, under #4978's 2026-09-04
// 13:05 UTC form rule: the surface is the FORM).
//
// WHY THIS TIER AND NOT THE COMPONENT ONE. The control has no component of its
// own — it is inline in the page, and the page is a server component that reads
// the session and the record through the real query layer. The cheapest place
// that can render it is here, where the database already exists; the component
// tier would have to mock the whole read layer to reach the same markup.
//
// WHAT IT CATCHES. The rank is a class the primitive paints, and both wrappers
// forward props BY NAME through a closed `ButtonProps` — a rank that stopped
// being forwarded would typecheck, lint, and quietly render the secondary
// treatment. So this reads the rendered markup, not the call site.
//
// The second half is the rule's other half: the surface spends exactly one loud
// control. The page renders two typed controls in total, and the Recheck
// scheduler's commit — a DIFFERENT form, still quiet — is the positive control
// that proves this harness can see a secondary rather than matching everything.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { ToastProvider } from "@/components/Toast";
import { db } from "@/lib/db";
import ClinicalResultDetailPage from "@/app/(app)/results/clinical-results/view/page";
import { seedActor } from "../__action_tests__/harness";

const CONTROL = /<button[^>]*data-button-control[^>]*>/g;

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
  // The page mounts the star, whose toast channel is a provider higher in the
  // app shell; supplying it renders the page rather than the shell.
  return renderToStaticMarkup(
    createElement(ToastProvider, null, page as ReactNode)
  );
}

describe("the clinical result's acknowledgment rank (#4014)", () => {
  it("paints 'Seen it' as its form's primary, and spends only that one", async () => {
    const html = await renderFlaggedResult();
    const controls = html.match(CONTROL) ?? [];

    const seenIt = controls.find((c) =>
      c.includes('data-testid="result-acknowledge-submit"')
    );
    expect(seenIt).toContain("button-control-primary");

    // The Recheck scheduler's commit is a second form on the same card and stays
    // quiet — the positive control for the count below.
    const recheck = controls.find((c) =>
      c.includes('aria-label="Track follow-up"')
    );
    expect(recheck).toBeDefined();
    expect(recheck).not.toContain("button-control-primary");

    expect(html.match(/button-control-primary/g) ?? []).toHaveLength(1);
  });
});
