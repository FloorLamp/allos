// The session twin of /v1/board/<doseId> (docs/device-api.md, *Web twins*).
export { POST } from "@/app/v1/board/[doseId]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
