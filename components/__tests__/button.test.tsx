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
    expect(button.className).toBe("button-control shrink-0");
    expect(button.className).not.toContain("tap-target");
    expect(ref.current).toBe(button);
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps a destination a link under the same closed treatment", () => {
    render(
      <DestinationActionLink href="/upcoming" data-testid="destination">
        Review screening
      </DestinationActionLink>
    );

    const link = screen.getByRole("link", { name: "Review screening" });
    expect(link.getAttribute("href")).toBe("/upcoming");
    expect(link.getAttribute("data-button-control")).toBe("");
    expect(link.className).toBe("button-control shrink-0");
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
