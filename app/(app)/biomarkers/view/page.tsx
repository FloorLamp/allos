import { permanentRedirect } from "next/navigation";

// Compatibility route for existing reading links. Keep the old URL resolvable,
// but make the canonical list and detail pages one `/results/readings` family.
export default async function LegacyBiomarkerViewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  permanentRedirect(
    suffix ? `/results/readings/view?${suffix}` : "/results/readings"
  );
}
