import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SectionHeading from "@/components/SectionHeading";

describe("SectionHeading", () => {
  it.each([
    [2, undefined, "font-semibold text-slate-800 dark:text-slate-100"],
    [3, undefined, "font-semibold text-slate-800 dark:text-slate-100"],
    [2, "lg", "text-lg font-semibold text-slate-800 dark:text-slate-100"],
    [3, "base", "text-base font-semibold text-slate-800 dark:text-slate-100"],
    [2, "sm", "text-sm font-semibold text-slate-800 dark:text-slate-100"],
    [3, "sm", "text-sm font-semibold text-slate-800 dark:text-slate-100"],
  ] as const)("level %i, size %s owns its class", (level, size, className) => {
    render(
      <SectionHeading level={level} size={size}>
        Title
      </SectionHeading>
    );
    expect(
      screen.getByRole("heading", { level, name: "Title" }).className
    ).toBe(className);
  });

  it("sets a trailing caption beside the heading", () => {
    render(
      <SectionHeading level={2} trailing={<span>last 28 nights</span>}>
        Title
      </SectionHeading>
    );
    const row = screen.getByRole("heading", { name: "Title" }).parentElement!;
    expect(row.className).toBe(
      "flex flex-wrap items-baseline justify-between gap-2"
    );
    expect(row.textContent).toBe("Titlelast 28 nights");
  });
});
