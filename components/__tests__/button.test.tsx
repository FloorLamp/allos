import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import Button, { SubmitActionChip } from "@/components/Button";
import { DestinationActionLink } from "@/components/DestinationLink";

describe("Button", () => {
  it("owns one ordinary treatment, semantics, and disclosure metadata", () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button
        ref={ref}
        onClick={onClick}
        onKeyDown={onKeyDown}
        aria-haspopup="menu"
        aria-expanded={false}
        aria-controls="more-results"
        data-testid="subject"
      >
        +3 more
      </Button>
    );

    const button = screen.getByRole("button", { name: "+3 more" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("more-results");
    expect(button.getAttribute("data-button-control")).toBe("");
    expect(button.className).toBe("button-control");
    expect(button.className).not.toContain("tap-target");
    expect(ref.current).toBe(button);
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  // THE ONE PRIMARY VARIANT (#3982). The claim is not "the classes differ" — a
  // swap to `.btn` would satisfy that while quietly taking `whitespace-nowrap`,
  // the reserved border and the box away with it. The claim is that primary is
  // secondary PLUS one paint utility, so every geometry and focus declaration is
  // literally the same declaration in both. Read as a set comparison, which is
  // what makes the "and nothing was removed" half assertable at all.
  it("adds paint for the one primary variant and removes nothing", () => {
    render(
      <>
        <Button data-testid="secondary">Add entry</Button>
        <Button variant="primary" data-testid="primary">
          + Log
        </Button>
      </>
    );

    const secondary = screen.getByTestId("secondary").className.split(" ");
    const primary = screen.getByTestId("primary").className.split(" ");
    expect(secondary).toEqual(["button-control"]);
    expect(primary).toEqual(["button-control", "button-control-primary"]);
    // Both are the typed primitive, so every spec that locates one by this
    // attribute keeps working across the rank.
    expect(
      screen.getByTestId("primary").getAttribute("data-button-control")
    ).toBe("");
  });

  // THE ONE DESTRUCTIVE PAINT (#4978). Same claim shape as the primary test
  // above: danger is button-control plus one paint utility, never a swap, so
  // the box, focus ring and spinner stay the same declarations as every rank.
  it("adds paint for the one destructive variant and removes nothing", () => {
    render(
      <>
        <Button data-testid="secondary">Cancel</Button>
        <Button variant="danger" data-testid="danger">
          Delete
        </Button>
      </>
    );

    expect(screen.getByTestId("secondary").className.split(" ")).toEqual([
      "button-control",
    ]);
    expect(screen.getByTestId("danger").className.split(" ")).toEqual([
      "button-control",
      "button-control-danger",
    ]);
    expect(
      screen.getByTestId("danger").getAttribute("data-button-control")
    ).toBe("");
  });

  // THE CLOSED LAYOUT SET (owner ruling 2026-09-04, #4978). Layout is ADDED to
  // the same box and never replaces the rank's paint, which is what lets the
  // two mounts that had grown wrapper elements drop them. The type refuses a
  // third value, so there is no runtime check here to write and none below —
  // the row that would test it does not compile.
  it.each([
    { layout: undefined, expected: ["button-control"] },
    { layout: "block" as const, expected: ["button-control", "w-full"] },
    {
      layout: "hidden-below-sm" as const,
      expected: ["button-control", "hidden", "sm:inline-flex"],
    },
  ])("layout $layout adds only layout", ({ layout, expected }) => {
    render(
      <Button layout={layout} data-testid="laid-out">
        Apply
      </Button>
    );
    expect(screen.getByTestId("laid-out").className.split(" ")).toEqual(
      expected
    );
  });

  it("composes layout with a rank rather than replacing it", () => {
    render(
      <Button variant="primary" layout="block" data-testid="both">
        Save
      </Button>
    );
    expect(screen.getByTestId("both").className.split(" ")).toEqual([
      "button-control",
      "button-control-primary",
      "w-full",
    ]);
  });

  // PENDING AND DISABLED ON `danger` REUSE PRIMARY'S TREATMENT (#4978 AC).
  // Both rank utilities scope their paint to
  // `:not(:disabled):not([aria-disabled="true"])` in app/globals.css, so the
  // ONE shared muted-disabled rule on `button-control` itself is what paints
  // a not-yet-actionable button of EITHER rank — never a faded rank colour.
  // The component's half of that contract is to never special-case a rank's
  // class list for disabled or pending state; table-driven across both ranks
  // so a mutation that gives `danger` its own disabled/pending treatment reds
  // only that row while `primary`'s stays green, proving the reuse rather than
  // asserting it.
  it.each([
    { variant: "primary" as const, paintClass: "button-control-primary" },
    { variant: "danger" as const, paintClass: "button-control-danger" },
  ])(
    "keeps the $variant paint class through disabled and pending",
    async ({ variant, paintClass }) => {
      const expectedClass = `button-control ${paintClass}`;

      const { unmount } = render(
        <Button variant={variant} disabled data-testid="ranked">
          Go
        </Button>
      );
      const disabledButton = screen.getByTestId("ranked");
      expect(disabledButton.className).toBe(expectedClass);
      expect((disabledButton as HTMLButtonElement).disabled).toBe(true);
      unmount();

      const result = Promise.withResolvers<void>();
      const submitted = vi.fn((_formData: FormData) => result.promise);
      render(
        <form action={submitted}>
          <SubmitActionChip variant={variant} data-testid="ranked-submit">
            Go
          </SubmitActionChip>
        </form>
      );
      const submitButton = screen.getByTestId("ranked-submit");
      fireEvent.click(submitButton);
      await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
      expect(submitButton.getAttribute("aria-busy")).toBe("true");
      expect((submitButton as HTMLButtonElement).disabled).toBe(true);
      expect(submitButton.className).toBe(expectedClass);

      await act(async () => result.resolve());
    }
  );

  it("keeps a destination a link under the same closed treatment", () => {
    render(
      <DestinationActionLink href="/upcoming" data-testid="destination">
        Review screening
      </DestinationActionLink>
    );

    const link = screen.getByRole("link", { name: "Review screening" });
    expect(link.getAttribute("href")).toBe("/upcoming");
    expect(link.getAttribute("data-button-control")).toBe("");
    expect(link.className).toBe("button-control");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("forwards its submitter and owns the pending label, spinner, and state", async () => {
    const result = Promise.withResolvers<void>();
    const submitted = vi.fn((_formData: FormData) => result.promise);
    const runtimeProps = { type: "button" } as unknown as Parameters<
      typeof SubmitActionChip
    >[0];
    render(
      <form action={submitted}>
        <SubmitActionChip {...runtimeProps} name="intent" value="archive">
          Archive
        </SubmitActionChip>
      </form>
    );

    const button = screen.getByRole("button", { name: "Archive" });
    expect(button.getAttribute("type")).toBe("submit");
    fireEvent.click(button);

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted.mock.calls[0][0].get("intent")).toBe("archive");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe("Archive");
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await act(async () => result.resolve());
    await waitFor(() => expect(button.textContent).toBe("Archive"));
  });
});
