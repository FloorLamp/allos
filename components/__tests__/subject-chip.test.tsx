import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SubjectChip from "@/components/SubjectChip";

describe("SubjectChip", () => {
  it("owns identity, truncation, and access labeling", () => {
    const subject = {
      profileId: 42,
      name: "A deliberately long member name",
      photoPath: null,
      photoVersion: 0,
      access: "read" as const,
    };
    const { rerender } = render(<SubjectChip subject={subject} />);

    const chip = screen.getByTestId("subject-chip-42");
    expect(chip.textContent).toContain(subject.name);
    expect(chip.textContent).toContain("RO");
    expect(chip.className).toContain("max-w-full");
    expect(screen.getByText(subject.name).className).toContain("truncate");
    rerender(
      <SubjectChip subject={{ ...subject, profileId: 43, access: "write" }} />
    );

    expect(screen.getByTestId("subject-chip-43").textContent).toContain(
      subject.name
    );
    expect(screen.queryByText("RO")).toBeNull();
  });
});
