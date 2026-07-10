"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { insertVitals } from "@/lib/offline/writes";

// Manual vitals write path (issue #16). Manual entry previously covered only the
// three body_metrics measures (weight/body-fat/resting-HR); blood pressure,
// glucose, SpO2, temperature, sleep, and HRV could ONLY arrive via the Health
// Connect exporter. The write itself now lives in lib/offline/writes.ts::
// insertVitals (normalize + validate + persist to the SAME tables/metric keys/
// canonical names the integration uses, tagged source='manual'), so the offline
// replay route (issue #28) runs identical validation. This action just resolves the
// session and revalidates.
//
// NEVER CLOBBERED BY INGEST (see insertVitals): manual medical_records rows carry
// external_id NULL and metric_samples rows carry source='manual', so a same-window
// Health Connect push can never match/overwrite them.
export async function addVitals(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const wrote = insertVitals(
    profile.id,
    String(formData.get("date") ?? "").trim(),
    {
      systolic: formData.get("systolic") as string | null,
      diastolic: formData.get("diastolic") as string | null,
      glucose: formData.get("glucose") as string | null,
      glucoseUnit: formData.get("glucose_unit") as string | null,
      spo2: formData.get("spo2") as string | null,
      temperature: formData.get("temperature") as string | null,
      tempUnit: formData.get("temp_unit") as string | null,
      sleepHours: formData.get("sleep_hours") as string | null,
      hrv: formData.get("hrv") as string | null,
      gripStrength: formData.get("grip_strength") as string | null,
      chairStand: formData.get("chair_stand") as string | null,
      balance: formData.get("balance") as string | null,
    }
  );
  // A rejected/empty vitals input is a no-op — skip revalidation.
  if (!wrote) return;
  revalidatePath("/trends");
  revalidatePath("/biomarkers");
  revalidatePath("/");
}
