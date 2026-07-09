"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Status + kind filters for the /import log (issue #208). Each writes its choice
// into a query param (`status` / `kind`) on the current path, which the server
// component reads back to filter the rows. Modeled on the app's other
// query-param filter selects (e.g. the biomarkers range filter).

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "done", label: "Done" },
  { value: "partial", label: "Partial" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  { value: "document", label: "Documents" },
  { value: "job", label: "Paste / CSV" },
];

export default function ImportLogFilters({
  status,
  kind,
}: {
  status?: string;
  kind?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set(key, next);
    else sp.delete(key);
    const s = sp.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <span className="font-medium">Status</span>
        <select
          className="input w-auto"
          value={status ?? ""}
          onChange={(e) => setParam("status", e.target.value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <span className="font-medium">Kind</span>
        <select
          className="input w-auto"
          value={kind ?? ""}
          onChange={(e) => setParam("kind", e.target.value)}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
