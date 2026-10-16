import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const app = process.cwd();
const require = createRequire(path.join(app, "dist/restore-check.cjs"));
const Database = require("better-sqlite3");
const workspace = mkdtempSync(path.join(tmpdir(), "allos-image-tools-"));
const data = path.join(workspace, "data");
mkdirSync(data);
const database = path.join(data, "allos.db");
function run(tool, args = []) {
  return execFileSync(
    process.execPath,
    [path.join(app, "dist", tool), ...args],
    {
      cwd: workspace,
      env: { ...process.env, ALLOS_DB_PATH: database },
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}
try {
  // Initialize through a real CLI, then exercise the restore's profile readers.
  run("device-links.cjs", ["list"]);
  const db = new Database(database);
  db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Image fixture");
  db.close();
  const restored = run("restore-check.cjs", [data]);
  if (JSON.parse(restored.trim().split("\n").at(-1)).ok !== true)
    throw new Error(`Restore probe failed: ${restored}`);
  run("notify.cjs");
  console.log(
    "Standalone image tools passed: device-links, restore-check, notify"
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
