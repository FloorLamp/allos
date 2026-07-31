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
//
// `strict` (#1642) elects "only this source": no fallback on the days it didn't
// cover. It is only meaningful WITH a source, so clearing the source clears the
// mode with it — a strict flag on an empty source is ignored rather than stored.
export async function setMetricPrimarySource(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const metric = String(formData.get("metric") ?? "");
  const source = String(formData.get("source") ?? "").trim();
  const strict = String(formData.get("strict") ?? "") === "1";
  if (!isComparableMetricKey(metric)) return;
  if (source !== "" && !isValidSourceId(source)) return;
  setMetricSourcePriorityEntry(
    profile.id,
    metric,
    source === "" ? null : source,
    source !== "" && strict
  );
  revalidatePath("/trends", "layout");
  revalidatePath("/sleep");
  revalidatePath("/");
}
