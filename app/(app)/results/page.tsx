import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Bare `/results` → the first tab (#1079), forwarding any query so an old
// `/results?q=…` deep link keeps its Biomarkers filter. Keeping a real page here
// (rather than a next.config redirect) keeps `/results` a valid typedRoute so the
// top-level nav href stays #285-checked.
export default async function ResultsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const q = qs.toString();
  redirect(q ? `/results/biomarkers?${q}` : "/results/biomarkers");
}
