import { deviceJsonBody, refuse, type DeviceAuth } from "./device-logins";
import { accessibleProfilesForLogin, writableProfileIdsForLogin } from "./auth";
import {
  applyHealthWorkflow,
  listHealthWorkflow,
  WorkflowError,
  type HealthWorkflow,
  type WorkflowActor,
} from "./health-workflows";
import { revalidateRoute } from "./revalidate";
import { readTx } from "./db";
import { AUDIT_ACTIONS } from "./audit-actions";
import { recordAudit } from "./audit";

export async function healthWorkflowRequest(
  req: Request,
  kind: HealthWorkflow,
  auth: DeviceAuth
): Promise<Response> {
  const write = req.method === "POST";
  if (!auth.ok) return refuse(auth);
  const params = new URL(req.url).searchParams;
  if (!params.get("profile")) return refuse({ status: 400, error: "profile" });
  const actor = (): WorkflowActor => {
    const profiles = accessibleProfilesForLogin(auth.login.id);
    if (!profiles.some((p) => p.id === auth.profile.id))
      throw new WorkflowError(403, "profile");
    const writable = writableProfileIdsForLogin(auth.login.id);
    return {
      profileId: auth.profile.id,
      loginId: auth.login.id,
      writable: writable.includes(auth.profile.id),
      destinations: profiles
        .filter((p) => writable.includes(p.id))
        .map((p) => ({ id: p.id, name: p.name })),
    };
  };
  try {
    if (!write)
      return Response.json(
        readTx(() =>
          listHealthWorkflow(
            actor(),
            kind,
            params.get("q") ?? "",
            params.get("cursor") ?? ""
          )
        ),
        { headers: { "Cache-Control": "no-store" } }
      );
    const body = await deviceJsonBody(req);
    if (!body) return refuse({ status: 400, error: "form" });
    applyHealthWorkflow(kind, body, actor);
    recordAudit({
      loginId: auth.login.id,
      profileId: auth.profile.id,
      action: AUDIT_ACTIONS.healthWorkflowApply,
      target: String(body.id),
      detail: `${kind}.${String(body.action)}`,
    });
    revalidateRoute([
      "/data",
      "/nutrition",
      "/medications",
      "/supplies",
      "/upcoming",
      "/history",
      "/results",
      "/trends",
      "/records",
      "/",
    ]);
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof WorkflowError)
      return Response.json(
        { error: err.message },
        { status: err.status, headers: { "Cache-Control": "no-store" } }
      );
    throw err;
  }
}
