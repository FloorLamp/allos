import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import AllergyForm from "@/app/(app)/records/problems/allergies/AllergyForm";
import ConditionForm from "@/app/(app)/records/problems/conditions/ConditionForm";
import AudiogramList from "@/app/(app)/records/specialty/hearing/AudiogramList";
import type { Allergy } from "@/lib/types";
import { loudIn as loudLabels } from "./loud-controls";

// THE RECORDS FORMS' ONE LOUD CONTROL, ASSERTED AS THE WHOLE SURFACE'S BUDGET
// (#4978, ruling 6 and ruling 10).
//
// These forms carried thirteen raw `btn-ghost` mounts. Nine were the Cancel
// beside a `variant="primary"` commit, and that pairing is the reason the two
// halves are asserted TOGETHER rather than one mount at a time: `btn-ghost`
// renders 14px type and the commit's control box renders 12px, so until this
// slice every one of these forms shipped a Cancel LARGER than its Add. That is
// the interim state the owner declined in ruling (3) of 2026-09-05, and a
// mount that silently fell back to the raw family would restore it.
//
// Read off the RENDERED classes, never the call site, so a mount that lost its
// `variant` in a refactor reddens here too.
//
// The budget is collected rather than sampled, and it comes from the one
// definition in `./loud-controls` rather than a list private to this file
// (#5696). The two wrapper utilities that used to paint a fill onto a rank-LESS
// child — which is why this file once carried a four-selector list — now state
// their rank on the button, so the rank classes are the whole census.

vi.mock("@/app/(app)/records/problems/allergies/actions", () => ({}));
vi.mock("@/app/(app)/records/problems/conditions/actions", () => ({}));

const RAW_FAMILY = /\b(btn|btn-ghost|btn-danger|btn-sm)\b/;
// Every quiet control the primitive owns, as RENDERED: on the one control box,
// off the retiring raw family, and carrying no rank.
function expectQuiet(el: HTMLElement) {
  expect(el.hasAttribute("data-button-control")).toBe(true);
  expect(el.className).toContain("button-control");
  expect(el.className).not.toMatch(RAW_FAMILY);
  expect(el.className).not.toContain("button-control-primary");
  expect(el.className).not.toContain("button-control-danger");
}

const allergy: Allergy = {
  id: 1,
  onset_date: null,
  substance: "Peanut",
  substance_code: null,
  substance_code_system: null,
  reaction: "Hives",
  severity: "moderate",
  status: "active",
  criticality: null,
  verification_status: null,
  reactions: [
    { manifestation: "Hives", severity: "moderate" },
    { manifestation: "Wheeze", severity: "severe" },
  ],
  notes: null,
  provider_id: null,
  encounter_id: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

function wrap(node: React.ReactNode) {
  return render(
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );
}

afterEach(cleanup);

describe("a records form spends its one loud control on its own commit", () => {
  it("fills the allergy form's commit and quiets every helper beside it", () => {
    wrap(
      <AllergyForm
        action={async () => ({ ok: true as const })}
        allergy={allergy}
        onDone={() => {}}
      />
    );
    const form = screen.getByTestId("allergy-form-actions").closest("form")!;

    // Ruling 6: the commit is the one control allowed to be loud here.
    expect(loudLabels(form)).toEqual(["Save"]);

    // Ruling 6 again — neither helper is this form's commit.
    expectQuiet(screen.getByRole("button", { name: "Cancel" }));
    expectQuiet(screen.getByTestId("allergy-add-reaction-1"));

    // Ruling 10: a per-row destructive control in a repeated list stays quiet
    // rather than taking `danger`. Two manifestation rows, so both render.
    const removes = screen.getAllByRole("button", { name: /^Remove reaction/ });
    expect(removes).toHaveLength(2);
    for (const el of removes) expectQuiet(el);
  });

  it("quiets the condition form's suggestion helper", () => {
    wrap(
      <ConditionForm
        action={async () => ({ ok: true as const })}
        condition={{
          id: 1,
          name: "Asthma",
          code: null,
          code_system: null,
          status: "active",
          laterality: null,
          severity: null,
          stage: null,
          onset_date: null,
          resolved_date: null,
          notes: null,
          source: null,
          document_id: null,
          external_id: null,
          edited: 1,
          created_at: "2026-09-01T10:00:00Z",
        }}
        onDone={() => {}}
      />
    );
    const form = screen.getByTestId("condition-form-actions").closest("form")!;
    expect(loudLabels(form)).toEqual(["Save"]);
    expectQuiet(screen.getByRole("button", { name: "Cancel" }));
  });

  it("keeps the per-card audiogram Delete quiet under ruling 10", () => {
    wrap(
      <AudiogramList
        audiograms={[
          { date: "2026-08-01", readings: [], reportedPtas: [], notes: null },
          { date: "2026-02-01", readings: [], reportedPtas: [], notes: null },
        ]}
        baseline={null}
        onDelete={async () => ({ ok: true as const })}
      />
    );
    // Two repeated cards, and the whole surface spends nothing loud: a Delete
    // per card is the repeated-row destructive shape, not a standalone one.
    expect(loudLabels(document.body)).toEqual([]);
    for (const date of ["2026-08-01", "2026-02-01"]) {
      const card = screen.getByTestId(`audiogram-${date}`);
      expectQuiet(within(card).getByRole("button", { name: "Delete" }));
    }
  });
});
