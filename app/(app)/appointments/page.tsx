import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Appointments merged into the unified Visits page (issue #288). This route now
// redirects to /encounters, preserving any query string so a stale preventive
// "Book" CTA / calendar link / command-palette focus (?new=1&title=…&kind=…) still
// lands on the merged page's booking form. Internal links were all updated to
// /encounters; this covers external bookmarks and any missed deep link.
export default async function AppointmentsRedirect(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else if (value != null) {
      qs.set(key, value);
    }
  }
  const query = qs.toString();
  redirect(query ? `/encounters?${query}` : "/encounters");
}
