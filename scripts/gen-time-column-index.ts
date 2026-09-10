// Regenerate the marked table in docs/internals/time-columns.md from
// lib/time-columns.ts, preserving surrounding prose. Run npm run gen:time-columns.
// Existing time-columns tests verify the committed table matches the registry.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TIME_COLUMN_INDEX_DOC,
  spliceTimeColumnIndex,
} from "../lib/time-columns";

const DOC = path.join(
  path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  TIME_COLUMN_INDEX_DOC
);

const doc = fs.readFileSync(DOC, "utf8");
const next = spliceTimeColumnIndex(doc);
if (next === doc) {
  console.log(`${TIME_COLUMN_INDEX_DOC} already current`);
} else {
  fs.writeFileSync(DOC, next);
  console.log(`wrote ${TIME_COLUMN_INDEX_DOC}`);
}
