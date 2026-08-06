import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import { readZip } from "../lib/zip";
import { workerDbPath, workerDir } from "./worker-env";

// Export completeness (#1846), in the browser.
//
// Two gaps shipped together and are closed together here:
//   • `dental_procedures` / `skin_lesions` were in NO bundle — first-class record
//     types with their own pages and no way out of the app. They are flat datasets
//     now, so the ZIP must carry their JSON + CSV with the real rows in them.
//   • Photos and clips had no opt-in at all. "Include photo & video files" beside
//     the download is that opt-in: OFF by default (the archive stays media-free),
//     and when ON the ZIP carries the files under media/<domain>/ with an index.
//
// Spec-owned fixtures (the #868 rule): this spec inserts its own lesion + dental +
// photo rows through a raw connection, writes the photo bytes into the worker
// server's own data/uploads tree (its CWD), and removes both afterward — so it
// never leans on a shared-seed row's incidental shape and never exact-counts one.

const DB_PATH = workerDbPath();
const PROFILE_ID = 1; // the seed's bootstrap admin profile (the active profile)

const LESION_LABEL = "E2E-1846 upper back mole";
const DENTAL_NAME = "E2E-1846 composite restoration";
const PROGRESS_CAPTION = "E2E-1846 progress front";
const LESION_CAPTION = "E2E-1846 lesion month 1";

// The server runs with the worker directory as its CWD, so the stores' repo-relative
// stored_path values resolve under here.
const LESION_FILE = path.join(
  "data",
  "uploads",
  "lesion-photos",
  String(PROFILE_ID),
  "e2e-1846-lesion.jpg"
);
const PROGRESS_FILE = path.join(
  "data",
  "uploads",
  "progress-photos",
  String(PROFILE_ID),
  "e2e-1846-progress.jpg"
);

function writeFixtureFile(relPath: string, bytes: string): void {
  const abs = path.join(workerDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

// Open the Data page's "Manage & export" section. It's a NavTabs section rendered
// server-side from ?section=, so the direct navigation already paints it.
async function openManageTab(page: import("@playwright/test").Page) {
  await page.goto("/data?section=manage");
  await expect(
    page.getByRole("tab", { name: "Manage & export" })
  ).toBeVisible();
}

function cleanup(handle: InstanceType<typeof Database>): void {
  handle
    .prepare(`DELETE FROM lesion_photos WHERE profile_id = ? AND caption = ?`)
    .run(PROFILE_ID, LESION_CAPTION);
  handle
    .prepare(`DELETE FROM skin_lesions WHERE profile_id = ? AND label = ?`)
    .run(PROFILE_ID, LESION_LABEL);
  handle
    .prepare(`DELETE FROM dental_procedures WHERE profile_id = ? AND name = ?`)
    .run(PROFILE_ID, DENTAL_NAME);
  handle
    .prepare(`DELETE FROM progress_photos WHERE profile_id = ? AND caption = ?`)
    .run(PROFILE_ID, PROGRESS_CAPTION);
}

test.beforeAll(() => {
  const handle = new Database(DB_PATH);
  try {
    // Idempotent under --repeat-each: drop any prior run's rows first.
    cleanup(handle);

    handle
      .prepare(
        `INSERT INTO dental_procedures
           (profile_id, name, status, tooth, tooth_system, surface, cdt_code,
            procedure_date, finding, follow_up_interval_days, source)
         VALUES (?, ?, 'watch', '19', 'universal', 'MO', 'D2392', '2026-02-11',
                 'Recheck margin', 180, 'manual')`
      )
      .run(PROFILE_ID, DENTAL_NAME);

    const lesionId = Number(
      handle
        .prepare(
          `INSERT INTO skin_lesions
             (profile_id, label, body_region, body_side, size_mm, asymmetry, border,
              color, diameter, evolving, status, observed_date, finding,
              follow_up_interval_days, source)
           VALUES (?, ?, 'back', 'left', 6.5, 1, 1, 0, 1, 1, 'watch', '2026-04-02',
                   'Asymmetric, re-check in 6 months', 180, 'manual')`
        )
        .run(PROFILE_ID, LESION_LABEL).lastInsertRowid
    );

    writeFixtureFile(LESION_FILE, "E2E-1846-LESION-BYTES");
    handle
      .prepare(
        `INSERT INTO lesion_photos
           (profile_id, lesion_id, date, stored_path, caption)
         VALUES (?, ?, '2026-04-02', ?, ?)`
      )
      .run(PROFILE_ID, lesionId, LESION_FILE, LESION_CAPTION);

    writeFixtureFile(PROGRESS_FILE, "E2E-1846-PROGRESS-BYTES");
    handle
      .prepare(
        `INSERT INTO progress_photos
           (profile_id, date, pose, stored_path, content_hash, caption)
         VALUES (?, '2026-04-01', 'front', ?, 'e2e-1846-hash', ?)`
      )
      .run(PROFILE_ID, PROGRESS_FILE, PROGRESS_CAPTION);
  } finally {
    handle.close();
  }
});

test.afterAll(() => {
  const handle = new Database(DB_PATH);
  try {
    cleanup(handle);
  } finally {
    handle.close();
  }
  for (const rel of [LESION_FILE, PROGRESS_FILE]) {
    fs.rmSync(path.join(workerDir(), rel), { force: true });
  }
});

test.describe("Export completeness (#1846)", () => {
  test("dental and lesion records ship in the default bundle, media does not", async ({
    page,
  }) => {
    await openManageTab(page);

    const toggle = page.getByTestId("export-media-toggle");
    await expect(toggle).toBeVisible();
    // Excluding photos and clips stays the DEFAULT.
    await expect(toggle).not.toBeChecked();

    const link = page.getByTestId("export-all-link");
    await expect(link).toHaveAttribute("href", "/api/export/full");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const entries = readZip(fs.readFileSync((await download.path())!));
    const names = entries.map((e) => e.name);

    // The two datasets that used to be in no bundle at all.
    for (const key of ["dental_procedures", "skin_lesions"]) {
      expect(names).toContain(`datasets/${key}.json`);
      expect(names).toContain(`datasets/${key}.csv`);
    }
    const lesions = JSON.parse(
      entries
        .find((e) => e.name === "datasets/skin_lesions.json")!
        .data.toString("utf8")
    ) as Record<string, unknown>[];
    expect(lesions.map((r) => r.label)).toContain(LESION_LABEL);
    const mine = lesions.find((r) => r.label === LESION_LABEL)!;
    expect(mine.size_mm).toBe(6.5);
    expect(mine.follow_up_interval_days).toBe(180);

    const dentalCsv = entries
      .find((e) => e.name === "datasets/dental_procedures.csv")!
      .data.toString("utf8");
    expect(dentalCsv).toContain(DENTAL_NAME);
    expect(dentalCsv).toContain("D2392");

    // …and NOT one byte of media, because this download did not ask for it.
    expect(names.filter((n) => n.startsWith("media/"))).toEqual([]);
    const manifest = JSON.parse(
      entries.find((e) => e.name === "manifest.json")!.data.toString("utf8")
    );
    expect(manifest.contents).not.toHaveProperty("media");
    expect(manifest.totals).not.toHaveProperty("mediaFiles");
  });

  test("the media toggle puts photos and clips in the bundle with an index", async ({
    page,
  }) => {
    await openManageTab(page);

    const toggle = page.getByTestId("export-media-toggle");
    // A pure client toggle: the state is the download href, so assert on that.
    await hydratedClick(page, toggle);
    await expect(toggle).toBeChecked();

    const link = page.getByTestId("export-all-link");
    await expect(link).toHaveAttribute("href", "/api/export/full?media=1");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const entries = readZip(fs.readFileSync((await download.path())!));
    const names = entries.map((e) => e.name);

    // Files land under their per-domain directory, and the bytes are the originals.
    const lesionEntry = entries.find(
      (e) =>
        e.name.startsWith("media/lesion-photos/") &&
        e.name.endsWith("e2e-1846-lesion.jpg")
    );
    expect(lesionEntry).toBeTruthy();
    expect(lesionEntry!.data.toString("utf8")).toBe("E2E-1846-LESION-BYTES");
    expect(
      names.some(
        (n) =>
          n.startsWith("media/progress-photos/") &&
          n.endsWith("e2e-1846-progress.jpg")
      )
    ).toBe(true);

    // The index carries the row context that makes each file readable — which for
    // these tables IS the row export, since they are not datasets.
    const index = JSON.parse(
      entries.find((e) => e.name === "media/index.json")!.data.toString("utf8")
    ) as Record<string, Record<string, unknown>[]>;
    const indexedLesion = index["lesion-photos"].find(
      (r) => r.caption === LESION_CAPTION
    )!;
    expect(indexedLesion.file).toBe(lesionEntry!.name);
    expect(indexedLesion.lesion_label).toBe(LESION_LABEL);
    expect(indexedLesion.date).toBe("2026-04-02");
    expect(indexedLesion).not.toHaveProperty("stored_path");
    expect(
      index["progress-photos"].some((r) => r.caption === PROGRESS_CAPTION)
    ).toBe(true);

    // The manifest names the media section so a reader knows this archive has it.
    const manifest = JSON.parse(
      entries.find((e) => e.name === "manifest.json")!.data.toString("utf8")
    );
    expect(manifest.contents.media.directory).toBe("media/");
    expect(manifest.contents.media.index).toBe("media/index.json");
    expect(manifest.contents.media.count).toBeGreaterThanOrEqual(2);
    expect(manifest.totals.mediaFiles).toBe(manifest.contents.media.count);
  });
});
