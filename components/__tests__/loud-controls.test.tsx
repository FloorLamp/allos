import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Button from "@/components/Button";
import { DestructiveSubmit } from "@/components/SubmitButton";
import { loudIn } from "./loud-controls";

// THE LOUD-CONTROL DEFINITION ITSELF (#5696). The rank specs across the #4978
// programme count a card's fills; this pins what they are counting, in the one
// case that used to escape every one of them.

afterEach(cleanup);

function card(children: React.ReactNode) {
  render(
    <div className="card" data-testid="card">
      {children}
    </div>
  );
  return screen.getByTestId("card");
}

describe("a card's loud controls", () => {
  it("counts a DestructiveSubmit beside the card's commit", () => {
    // The commit alone: one loud control, which is the budget ruling 6 allows.
    expect(loudIn(card(<Button variant="primary">Save</Button>))).toEqual([
      "Save",
    ]);
    cleanup();

    // Add a destructive submit beside it and the card is loud TWICE. This is the
    // assertion that used to be impossible: `.destructive-submit` painted the
    // fill onto a rank-less child, so a card-budget spec expecting `["Save"]`
    // stayed green while the card rendered a second solid control. Every rank
    // spec that expects an exact array now reddens when one is added.
    const withDestructive = card(
      <>
        <Button variant="primary">Save</Button>
        <DestructiveSubmit>Disconnect</DestructiveSubmit>
      </>
    );
    expect(loudIn(withDestructive)).toEqual(["Save", "Disconnect"]);

    // The rank is on the BUTTON, not on the wrapper: the wrapper still supplies
    // the `.btn-danger` geometry, and it is a fill only because the button says
    // so — which is what keeps the paint and the rank from drifting apart again.
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect.className).toContain("button-control-danger");
    expect(disconnect.parentElement?.className).toBe("destructive-submit");
  });

  it("leaves a control with no rank out of the count", () => {
    expect(
      loudIn(
        card(
          <>
            <Button variant="primary">Save</Button>
            <Button>Cancel</Button>
          </>
        )
      )
    ).toEqual(["Save"]);
  });
});
