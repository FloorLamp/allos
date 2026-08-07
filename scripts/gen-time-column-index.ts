// Regenerate the temporal-column index table in docs/internals/time-columns.md
// (issue #2205, phase 3).
//
//   npm run gen:time-columns
//
// The prose around the table is hand-written and preserved; only the block between the
// two markers is replaced, from lib/time-columns.ts. Generated rather than written
// because #2090 was closed for exactly this: an index maintained by hand next to a
// schema that keeps moving is a document that quietly stops being true.
// lib/__tests__/time-columns.test.ts fails when the committed file is stale, so a
// registry change that skips this script cannot merge.

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
  // eslint-disable-next-line no-console
  console.log(`${TIME_COLUMN_INDEX_DOC} already current`);
} else {
  fs.writeFileSync(DOC, next);
  // eslint-disable-next-line no-console
  console.log(`wrote ${TIME_COLUMN_INDEX_DOC}`);
}
