import { authenticateDevice, refuse } from "@/lib/device-logins";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { buildTodayPanelModel } from "@/lib/medication-today";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import { isOnDemand } from "@/lib/intake-schedule";
import { getDisplayFormatPrefs, getUnitPrefs } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The medication board for the profile-local day: the Medications page's Today
// panel, from the same gather and the same pure model (lib/medication-today.ts) the
// panel renders, so a device and the page can never show one day two ways.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const { login, profile } = auth;
  const data = loadMedicationsData(
    profile.id,
    getUnitPrefs(login.id).weightUnit,
    getDisplayFormatPrefs(login.id).timeFormat
  );
  const timeFormat = getDisplayFormatPrefs(login.id).timeFormat;
  const due = data.current.filter(
    (d) => !isOnDemand(d.med) && d.due && d.doses.length > 0
  );
  const model = buildTodayPanelModel(
    due.map((d) => ({
      id: d.med.id,
      name: d.med.name,
      obligation: d.med.obligation,
      stack: d.med.stack,
      doses: d.doses.map((dose) => ({
        id: dose.id,
        timeOfDay: dose.time_of_day,
        label:
          formatMedicationDoseLine({
            amount: null,
            timeOfDay: dose.time_of_day,
            asNeeded: false,
            timeFormat,
          }) || "",
        resolved: data.taken.has(dose.id) || data.skipped.has(dose.id),
      })),
    })),
    data.nowHhmm
  );
  return Response.json(
    {
      profile: profile.id,
      day: data.todayStr,
      allDone: model.allDone,
      meds: model.meds.map((m) => ({
        id: m.id,
        name: m.name,
        doses: m.doses.map((d) => ({
          id: d.id,
          timeOfDay: d.timeOfDay,
          label: d.label,
          status: data.taken.has(d.id)
            ? "taken"
            : data.skipped.has(d.id)
              ? "skipped"
              : null,
          pastDue: d.pastDue,
        })),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
