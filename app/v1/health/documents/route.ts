import { authenticateDevice } from "@/lib/device-logins";
import { healthWorkflowRequest } from "@/lib/health-workflow-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  return healthWorkflowRequest(req, "documents", auth);
}
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:log");
  return healthWorkflowRequest(req, "documents", auth);
}
