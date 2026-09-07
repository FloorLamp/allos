import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import ReprocessDiffPanel from "../ReprocessDiffPanel";
import {
  previewReprocess,
  applyReprocessPreview,
} from "@/app/(app)/medical/document-actions";

vi.mock("@/app/(app)/medical/document-actions", () => ({
  previewReprocess: vi.fn(),
  applyReprocessPreview: vi.fn(),
}));

const preview = vi.mocked(previewReprocess);
const apply = vi.mocked(applyReprocessPreview);
const diff = {
  hasChanges: true,
  entities: [],
  totals: { added: 1, removed: 0, changed: 0, unchanged: 0 },
};

beforeEach(() => {
  preview.mockReset();
  apply.mockReset();
});

async function click(name: string) {
  await act(async () => screen.getByRole("button", { name }).click());
}

it("shows a refused save and lets the person preview again before retrying", async () => {
  preview
    .mockResolvedValueOnce({ status: "ok", diff, previewToken: "old" })
    .mockResolvedValueOnce({ status: "ok", diff, previewToken: "new" });
  apply
    .mockResolvedValueOnce({
      mode: "refused",
      error: "Preview changes again before saving.",
    })
    .mockResolvedValueOnce({ mode: "committed-preview" });
  render(<ReprocessDiffPanel id={42} filename="record.xml" />);
  await click("Preview changes");
  await click("Save changes");
  expect(screen.getByRole("alert").textContent).toContain(
    "Preview changes again"
  );
  expect(apply.mock.calls[0][0].get("previewToken")).toBe("old");
  expect(apply.mock.calls[0][0].get("force")).toBeNull();

  await click("Preview changes");
  await click("Save changes");
  expect(apply.mock.calls[1][0].get("previewToken")).toBe("new");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sends explicit extraction intent only from Re-extract anyway", async () => {
  preview.mockResolvedValue({
    status: "skipped",
    message: "No preview available.",
  });
  apply.mockResolvedValue({ mode: "re-extracted" });
  render(<ReprocessDiffPanel id={42} filename="record.xml" />);
  await click("Preview changes");
  await click("Re-extract anyway");
  const submitted = apply.mock.calls[0][0];
  expect(submitted.get("force")).toBe("true");
  expect(submitted.get("previewToken")).toBeNull();
});
