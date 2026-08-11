import { permanentRedirect } from "next/navigation";

// Compatibility route for bookmarks created before #2482. Reading pages now live
// under one route family; preserve every filter/add-form parameter while moving
// callers to the canonical list.
export default async function LegacyBiomarkersPage(props: {
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
    suffix ? `/results/readings?${suffix}` : "/results/readings"
  );
}
