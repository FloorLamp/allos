import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import { DISCLAIMER_SECTIONS } from "@/lib/disclaimers";

export const dynamic = "force-dynamic";

// The single Disclaimer surface (issue #1049). All of the app's disclaimer copy
// consolidates here: the generic informational-not-medical-advice line, the not-a-
// diagnosis framing, the curated-subset dataset caveat, the extraction-may-err note,
// emergency guidance, and the data-locality note. It renders DISCLAIMER_SECTIONS from
// the canonical lib/disclaimers.ts — the ONE place the wording is maintained.
//
// Always reachable via the persistent footer link in the shared sidebar
// (components/SidebarContent.tsx, both viewports) and a Settings → Preferences link.
export default async function DisclaimerPage() {
  await requireSession();

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Disclaimer"
        subtitle="What Allos is — and what it is not."
      />
      <div className="card space-y-6" data-testid="disclaimer-full">
        {DISCLAIMER_SECTIONS.map((s) => (
          <section key={s.title} className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {s.title}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {s.body}
            </p>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}
