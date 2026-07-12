// Shared <datalist> powering the provider picker's create-on-type combobox
//. The registry is GLOBAL, so every surface that lets a user set a
// record's provider renders one of these (with the same id its inputs point at)
// and links a plain `<input list="…">` to it. A server component — it holds no
// state; typing a new name just creates the provider on save.
export default function ProviderDatalist({
  names,
  id = "provider-names",
}: {
  names: string[];
  id?: string;
}) {
  // Providers are keyed by id, not name, and names legitimately recycle —
  // two distinct rows can share a display name (see #536's "E2E Duplicate Lab"
  // fixture / #534). A datalist is a suggestion list whose <option value> IS
  // the identity, so two identical values are redundant AND collide as React
  // keys (#574). Dedupe to one option per distinct name.
  const distinct = Array.from(new Set(names));
  return (
    <datalist id={id}>
      {distinct.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
