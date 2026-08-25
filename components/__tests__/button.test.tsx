import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import Button from "@/components/Button";
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
});
