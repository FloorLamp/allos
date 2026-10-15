// The session twin of /v1/me (docs/device-api.md, *Web twins*): the same handler, authenticated by the session cookie.
export { GET } from "@/app/v1/me/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
