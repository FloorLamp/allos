import { authenticateDevice, refuse } from "@/lib/device-logins";
import { getActivityById } from "@/lib/queries/training/activities";
import { getAllergy, getCondition } from "@/lib/queries/clinical";
import { getEncounter } from "@/lib/queries/medical/encounters";
import {
  getClinicalObservations,
  getMedicalDocument,
} from "@/lib/queries/medical/records";
import { getProtocol } from "@/lib/queries/protocols";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One record by a find row's `key` (`<kind>:<id>`, or the marker's name for a clinical
// result), read through the kind's own profile-scoped getter and projected to its
// scalar fields. Kinds without a single-row getter answer 404 `kind`; a find row still
// carries `href` for those.
const READERS: Record<
  string,
  (profileId: number, id: string) => object | null | undefined
> = {
  condition: (p, id) => getCondition(p, Number(id)),
  allergy: (p, id) => getAllergy(p, Number(id)),
  encounter: (p, id) => getEncounter(p, Number(id)),
  document: (p, id) => getMedicalDocument(p, Number(id)),
  protocol: (p, id) => getProtocol(p, Number(id)),
  activity: (p, id) => getActivityById(p, Number(id)),
  "clinical-result": (p, name) =>
    getClinicalObservations(p, { current: true }).find(
      (r) => (r.canonical_name?.trim() || r.name).toLowerCase() === name
    ),
};

// Never on the wire: ownership, storage and extraction internals.
const HIDDEN = new Set([
  "profile_id",
  "stored_path",
  "raw_extraction",
  "content_hash",
  "import_report",
]);

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const colon = key.indexOf(":");
  const kind = colon > 0 ? key.slice(0, colon) : "";
  const id = key.slice(colon + 1);
  const read = READERS[kind];
  if (!read || !id) return Response.json({ error: "kind" }, { status: 404 });
  const row = read(auth.profile.id, id);
  if (!row) return Response.json({ error: "record" }, { status: 404 });
  const fields = Object.fromEntries(
    Object.entries(row).filter(
      ([k, v]) =>
        !HIDDEN.has(k) &&
        !k.endsWith("_json") &&
        (v === null || ["string", "number", "boolean"].includes(typeof v))
    )
  );
  return Response.json(
    { profile: auth.profile.id, kind, key, record: fields },
    { headers: { "Cache-Control": "no-store" } }
  );
}
