import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import type { ExtractionState } from "@/lib/toaster-poll";

// Medical-document extraction liveness for components/ExtractionToaster
// (issue #1878). The sibling of /api/jobs/imports, and for the same reason: a
// Server Action's response carries a freshly rendered page tree, so polling one
// repainted the page under a half-typed record form outside everything the
// dirty-form registry gates. A `fetch` of this endpoint cannot. See
// lib/toaster-poll.ts.
//
// AUTH — cookie-authoritative getCurrentSession(); a missing session is a 401 the
// poller retries rather than reading as "no documents".
//
// The table is small (one row per uploaded document) and the client needs the
// whole set to diff statuses, so it returns all of the ACTIVE profile's rows.
// Filenames are health-adjacent but are the profile's own, and the toast the
// client raises shows them to that same person.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }
  const states = db
    .prepare(
      `SELECT id, filename, extraction_status AS status, extracted_count AS count,
              extraction_error AS error
         FROM medical_documents WHERE profile_id = ?`
    )
    .all(session.profile.id) as ExtractionState[];
  return Response.json(
    { ok: true, states },
    { headers: { "Cache-Control": "no-store" } }
  );
}
