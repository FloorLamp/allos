// Typed accessors over the curated mobility-move catalog (issue #840), on the
// curated-dataset framework. A thin re-export of lib/datasets/mobility-moves.ts (which
// loads lib/datasets/data/mobility-moves.json via the framework loader + matcher). Pure
// — no DB/network — importable from the pure test tier, the query layer, and client
// components alike. Regenerate the JSON with `npm run gen:mobility-moves`.

export * from "./datasets/mobility-moves";
