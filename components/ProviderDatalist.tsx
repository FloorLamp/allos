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
  return (
    <datalist id={id}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
