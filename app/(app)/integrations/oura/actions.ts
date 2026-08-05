"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setOuraToken, disconnectOura } from "@/lib/integrations/connections";
import { validateOuraToken } from "@/lib/integrations/oura-sync";
import { createLogger } from "@/lib/log";

const log = createLogger("oura");

// Connect: validate the pasted personal access token with the Oura v2 whoami
// (GET /v2/usercollection/personal_info) BEFORE storing it, so a typo/expired token
// is rejected up front instead of failing silently on the first hourly sync. On
// success the token + captured identity are stored and the connection goes live; the
// page re-renders in its connected state.
export async function connectOura(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect("/integrations/oura?error=missing_token");

  let res;
  try {
    res = await validateOuraToken(token);
  } catch (err) {
    log.error("oura validate threw", { err: String(err) });
    redirect("/integrations/oura?error=validation_failed");
  }
  if (!res.ok) {
    redirect(
      `/integrations/oura?error=${res.status === 401 ? "invalid_token" : "validation_failed"}`
    );
  }
  setOuraToken(profile.id, token, res.info);
  revalidatePath("/integrations/oura");
  revalidatePath("/data");
}

export async function disconnectOuraAction() {
  const { profile } = await requireWriteAccess();
  disconnectOura(profile.id);
  revalidatePath("/integrations/oura");
  revalidatePath("/data");
}
