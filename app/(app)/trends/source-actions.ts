"use server";
import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { setMetricSourcePriorityEntry } from "@/lib/settings";
import {
  isComparableMetricKey,
  isValidSourceId,
} from "@/lib/metric-source-priority";

// Persist the profile's primary source for one metric (issue #14): the source
// single-value surfaces and the additive daily rollups read when several
// providers report the metric. An empty source clears the choice back to
// "automatic" (default provider preference). The metric key is allowlisted to
// the comparable set and the source id shape-checked, so a forged post can't
// stuff arbitrary keys/blobs into profile_settings.
export async function setMetricPrimarySource(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const metric = String(formData.get("metric") ?? "");
  const source = String(formData.get("source") ?? "").trim();
  if (!isComparableMetricKey(metric)) return;
  if (source !== "" && !isValidSourceId(source)) return;
  setMetricSourcePriorityEntry(
    profile.id,
    metric,
    source === "" ? null : source
  );
  revalidatePath("/trends");
  revalidatePath("/");
}
