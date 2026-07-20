import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";

// Optical-prescription CRUD on /vision (#697): add a structured Rx through the real
// form, see it in the list with its per-eye sphere shown, edit it, then delete it.
// Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB, #868): a distinctive marker sphere scopes
// every action and a raw-connection cleanup in beforeAll AND afterAll makes the spec
// idempotent across CI retries — it only ever touches rows it created (a create-and-
// clean block, the same pattern the imaging spec uses). The marker sphere (-6.25) is
// far from any seeded value so it can't collide with the seed's progression rows.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const MARKER = -6.25;
// The transposition test's marker is the CANONICAL (stored) sphere both of its
// notations transpose to — cleanup keys on what actually lands in the DB (#1036).
const TRANSPOSE_MARKER = -7.25;

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM optical_prescriptions WHERE od_sphere IN (?, ?)")
      .run(MARKER, TRANSPOSE_MARKER);
  } finally {
    handle.close();
  }
}

test.describe("Optical prescriptions — add → view → edit → delete (#697)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured prescription and shows it factually", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/vision");
    const form = page.getByTestId("optical-prescription-form");
    await expect(form).toBeVisible();

    // Add a glasses Rx with the marker OD sphere.
    await form.getByLabel("Type").selectOption("glasses");
    await form.getByLabel("Sphere").first().fill(String(MARKER));
    await form.getByLabel("PD (mm)").fill("64");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Prescription saved")).toBeVisible();

    // It appears in the list with its factual per-eye identity.
    const list = page.getByTestId("optical-prescription-list");
    const row = list.getByRole("row").filter({ hasText: "-6.25" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Glasses");

    // Edit it: change the OS (left eye) sphere — the second "Sphere" input — to a
    // distinctive value and confirm the row reflects it. OD stays the -6.25 marker.
    await row.getByRole("button", { name: "Edit" }).click();
    const editForm = list.getByTestId("optical-prescription-form");
    await editForm.getByLabel("Sphere").nth(1).fill("-3.50");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Prescription updated")).toBeVisible();
    await expect(
      list.getByRole("row").filter({ hasText: "-6.25" })
    ).toContainText("OS -3.50");

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the
    // dialog — the page carries a per-row Delete button for every seeded Rx too.
    const survivor = list.getByRole("row").filter({ hasText: "-6.25" });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      list.getByRole("row").filter({ hasText: "-6.25" })
    ).toHaveCount(0);
  });

  test("a plus-cylinder Rx saves in canonical minus-cyl notation and a mixed-notation history trends flat (#1036)", async ({
    page,
  }) => {
    test.slow();

    // Self-clean the transposition marker BEFORE running (not just in the
    // afterAll): under --repeat-each the file-scoped afterAll doesn't run between
    // repeats, and a leftover pair would break this test's exact-count and
    // flat-net assertions. Scoped to THIS test's marker only, so a concurrently
    // running neighbor test is untouched.
    {
      const handle = new Database(DB_PATH);
      try {
        handle
          .prepare("DELETE FROM optical_prescriptions WHERE od_sphere = ?")
          .run(TRANSPOSE_MARKER);
      } finally {
        handle.close();
      }
    }

    await page.goto("/vision");
    const form = page.getByTestId("optical-prescription-form");
    await expect(form).toBeVisible();

    // One eye's four inputs render per eye row: index 0 = OD, 1 = OS.
    const fillEye = async (
      idx: number,
      sphere: string,
      cyl: string,
      axis: string
    ) => {
      await form.getByLabel("Sphere").nth(idx).fill(sphere);
      await form.getByLabel("Cyl").nth(idx).fill(cyl);
      await form.getByLabel("Axis").nth(idx).fill(axis);
    };

    // Rx 1 — minus-cyl (optometry) notation, dated OLDER than every seeded Rx so
    // it is the progression's first point: −7.25 −1.00 ×180 both eyes.
    await fillEye(0, String(TRANSPOSE_MARKER), "-1.00", "180");
    await fillEye(1, String(TRANSPOSE_MARKER), "-1.00", "180");
    await form.getByLabel("Issued").fill("2010-01-01");
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Prescription saved").first()).toBeVisible();

    // Rx 2 — the SAME refraction in plus-cyl (ophthalmology) notation, dated
    // NEWER than every seeded Rx so it is the progression's last point:
    // −8.25 +1.00 ×090 ≡ −7.25 −1.00 ×180. Without transposition the stored
    // sphere would differ by the full cylinder and fake a −1.00 D progression.
    await fillEye(0, "-8.25", "+1.00", "90");
    await fillEye(1, "-8.25", "+1.00", "90");
    await form.getByLabel("Issued").fill("2035-01-01");
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );

    // Both rows display the CANONICAL sphere (−7.25) — the plus-cyl entry was
    // transposed on save; its as-typed −8.25 sphere appears nowhere.
    const list = page.getByTestId("optical-prescription-list");
    await expect(
      list.getByRole("row").filter({ hasText: "OD -7.25" })
    ).toHaveCount(2);
    await expect(list.getByText("-8.25")).toHaveCount(0);

    // The sphere-over-time card brackets the seeded history with these two
    // equivalent Rx (2010 first, 2035 last), so the net first→last change per eye
    // is exactly 0 — no spurious progression from the notation switch.
    const progression = page.getByTestId("optical-progression");
    await expect(progression).toBeVisible();
    await expect(progression.getByText("OD 0.00 D")).toBeVisible();
    await expect(progression.getByText("OS 0.00 D")).toBeVisible();
  });
});
