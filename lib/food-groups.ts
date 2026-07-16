// Typed accessors over the curated food-group catalog (issue #579), migrated onto the
// curated-dataset framework in #860 Track B. This is now a thin re-export of
// lib/datasets/food-groups.ts (which loads lib/datasets/data/food-groups.json via the
// framework loader + matcher), so every existing `@/lib/food-groups` importer is
// unchanged. Pure — no DB/network — importable from the pure test tier, the query
// layer, and client components alike. Regenerate the JSON with `npm run gen:food-groups`.

export * from "./datasets/food-groups";
