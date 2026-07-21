import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Bare `/records` → the default landing pane, recent Visits (#1079 — the
// highest-touch surface), forwarding any query so an old `/records?new=1&title=…`
// booking deep link reaches the Visits form. A real page (not a next.config
// redirect) keeps `/records` a valid typedRoute so the top-level nav href stays
// #285-checked.
export default async function RecordsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const q = qs.toString();
  redirect(q ? `/records/history/visits?${q}` : "/records/history/visits");
}
