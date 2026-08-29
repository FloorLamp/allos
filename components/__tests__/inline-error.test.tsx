import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InlineError from "@/components/InlineError";

describe("InlineError", () => {
  // The nullable contract is the whole reason the twenty-six adopters could drop
  // their own `{error && (…)}` wrappers: an absent message must render NOTHING,
  // not an empty live region that announces itself the moment it mounts.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
  ])("renders nothing for %s content", (_label, content) => {
    const { container } = render(<InlineError>{content}</InlineError>);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces present content through one alert paragraph", () => {
    render(<InlineError>Pick a date first.</InlineError>);
    const alert = screen.getByRole("alert");
    expect(alert.tagName).toBe("P");
    expect(alert.textContent).toBe("Pick a date first.");
    expect(alert.className).toBe("text-sm text-rose-600 dark:text-rose-400");
  });

  // The id exists so a field can point `aria-describedby` at the failure; the
  // linkage only works if the id lands on the element the role is on.
  it("carries the description id and test id on the alert itself", () => {
    render(
      <>
        <input aria-describedby="dose-error" aria-label="Dose" />
        <InlineError id="dose-error" data-testid="dose-error-text">
          Enter a dose.
        </InlineError>
      </>
    );
    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("dose-error");
    expect(alert.getAttribute("data-testid")).toBe("dose-error-text");
    const described = screen
      .getByRole("textbox", { name: "Dose" })
      .getAttribute("aria-describedby");
    expect(described).toBe(alert.id);
    expect(document.getElementById(described!)?.textContent).toBe(
      "Enter a dose."
    );
  });
});
