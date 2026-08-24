import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TOAST_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "components", "Toast.tsx"),
  "utf8"
);

describe("Toast compact viewport boundary (#3534)", () => {
  it("uses the shared viewport hook instead of owning a media query", () => {
    expect(TOAST_SOURCE).toContain(
      'import { useCompactViewport } from "@/components/useCompactViewport";'
    );
    expect(TOAST_SOURCE).toContain("const snackbar = useCompactViewport();");
    expect(TOAST_SOURCE).not.toMatch(
      /matchMedia|SNACKBAR_QUERY|useSnackbarViewport/
    );
  });
});
