import type { NextRequest } from "next/server";
import { tailAiLog, aiLogSize, readAiEvents } from "@/lib/ai-log";
import { getCurrentSession } from "@/lib/auth";

// Server-Sent Events stream of new AI log events. Tails data/logs/ai.jsonl by
// byte offset and pushes each appended event. Node runtime (uses fs).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 1500;

export async function GET(req: NextRequest) {
  // This SSE stream carries AI-log events with medical content mixed across every
  // profile, so it's admin-only — cookie-authoritative gate (the Edge middleware
  // only checks cookie presence). A member gets 404 (not 403) so the endpoint's
  // existence isn't confirmed.
  const session = await getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (session.login.role !== "admin") {
    return new Response("Not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const lastEventId = req.headers.get("last-event-id");
  let offset = aiLogSize();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const frame = (id: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`)
        );

      // On reconnect, replay events newer than the client's last id (no dupes,
      // no gap). On a fresh connect the SSR page already showed existing events,
      // so we only stream new ones from the current end.
      if (lastEventId) {
        for (const ev of readAiEvents(2000).reverse()) {
          if (ev.id > lastEventId) frame(ev.id, ev);
        }
      }

      const tick = () => {
        try {
          const { events, size } = tailAiLog(offset);
          offset = size;
          for (const ev of events) frame(ev.id, ev);
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // best-effort; keep the stream alive
        }
      };
      timer = setInterval(tick, POLL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (timer) clearInterval(timer);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering of the stream
    },
  });
}
