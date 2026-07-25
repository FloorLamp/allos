// The "record list + add rail" two-pane shape, defined ONCE (issue #1450).
//
// Five sections — Results › Imaging, Results › Genomics, Records › Conditions,
// Records › Allergies and Longevity › Protocols — had each hand-written the same
// `grid gap-6 lg:grid-cols-3` with a `lg:col-span-2` list and a one-column rail.
// A third of the main column is not enough for a form: at 1280px the rail lands
// around 300px, and the forms inside then subdivide THAT with their own
// `grid-cols-2`, giving a field ~120px of box. That is what clipped
// "Only if the report prints one (rare)", "e.g. gadolinium", "ICD-10-CM /
// SNOMED CT", "Mild / Moderate / Severe" and the "No adherence tracking" select
// mid-word — the census's ~12 clipped-content sites are mostly this one layout,
// copied five times.
//
// So the rail gets a WIDTH rather than a fraction: 20rem from `lg`, 24rem from
// `xl`, with the list taking whatever remains (`minmax(0,1fr)` so it can still
// shrink — a bare `1fr` refuses to go below its content's min-content width and
// pushes the rail off instead). Below `lg` it stays a single stacked column, as
// before. Because it is one component, the next section to grow a rail inherits
// the fixed width instead of copying the thirds again.
export default function ListRailLayout({
  children,
  rail,
  listSpacing = "space-y-4",
}: {
  // The primary column — the record list and any cards above it.
  children: React.ReactNode;
  // The add/edit form column. Rendered second on every viewport, so it reads as
  // "the list, then the thing that adds to it" when stacked on a phone.
  rail: React.ReactNode;
  // The list column's vertical rhythm. Allergies stacks several cards and wants
  // the roomier step; everything else takes the default.
  listSpacing?: "space-y-4" | "space-y-6";
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className={`min-w-0 ${listSpacing}`}>{children}</div>
      <div className="min-w-0 space-y-4">{rail}</div>
    </div>
  );
}
