import { readErrorEvents } from "@/lib/error-log";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import ErrorLogTable from "./ErrorLogTable";
import { clearErrors } from "./actions";

export const dynamic = "force-dynamic";

export default async function ErrorsPage() {
  // Error detail may carry PHI-adjacent text (a stack over a medical record, a
  // logged field) and mixes across every profile, so it's admin-only — a member
  // is redirected out by requireAdmin().
  await requireAdmin();
  const events = readErrorEvents(200);
  // Map profile ids → display names so an error tagged with a profile names it.
  const profileNames = Object.fromEntries(
    (
      db.prepare("SELECT id, name FROM profiles").all() as {
        id: number;
        name: string;
      }[]
    ).map((p) => [p.id, p.name])
  );
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Server error log — unexpected exceptions and route/500 failures, newest first. Clients still see a generic error; the cause lands here only. Written to data/logs/errors.jsonl."
      />
      <SettingsTabs isAdmin />
      <ErrorLogTable
        events={events}
        profileNames={profileNames}
        clearAction={clearErrors}
      />
    </div>
  );
}
