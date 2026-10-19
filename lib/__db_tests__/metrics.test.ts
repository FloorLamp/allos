import { expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Metrics, metrics, recordSyncMetric } from "@/lib/metrics";
import {
  metricsServer,
  observeEventLoop,
  observeRequests,
  routeMatcher,
  startMetrics,
} from "@/lib/metrics-runtime";
import { db } from "@/lib/db";
import * as runtime from "@/lib/metrics-runtime";
import { register } from "../../instrumentation";
import {
  seedSyncMetrics,
  recordSyncEvent,
} from "@/lib/integrations/connections";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

it("exposes completed requests by template and excludes probes and forwarded scrapes", async () => {
  const registry = new Metrics();
  const stop = observeRequests(
    registry,
    routeMatcher([
      "/(app)/training/activity/[id]/page",
      "/api/items/[id]/route",
      "/healthz/route",
    ])
  );
  const app = createServer((_req, res) => res.writeHead(201).end());
  const scrape = metricsServer(registry);
  try {
    const appUrl = await listen(app);
    const scrapeUrl = await listen(scrape);
    await fetch(
      `${appUrl}/training/activity/private-person?email=private@example.test`
    );
    await fetch(`${appUrl}/api/items/private-id`, { method: "POST" });
    await fetch(`${appUrl}/healthz`);
    const response = await fetch(`${scrapeUrl}/metrics`);
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    const body = await response.text();
    expect(body).toContain("# TYPE http_request_duration_seconds histogram");
    expect(body).toContain(
      'http_request_duration_seconds_count{route="/training/activity/[id]",method="GET",status="201"} 1'
    );
    expect(body).toContain(
      'http_request_duration_seconds_bucket{route="/api/items/[id]",method="POST",status="201",le="+Inf"} 1'
    );
    expect(body).not.toMatch(/private|email|healthz|metrics"/);
    for (const header of ["x-forwarded-for", "x-forwarded-host"]) {
      expect(
        (
          await fetch(`${scrapeUrl}/metrics`, {
            headers: { [header]: "proxy" },
          })
        ).status
      ).toBe(404);
    }
    expect((await fetch(`${scrapeUrl}/other`)).status).toBe(404);
  } finally {
    stop();
    await close(app);
    await close(scrape);
  }
});

it("keeps AI labels bounded and emits known token usage and latency", () => {
  const registry = new Metrics();
  registry.ai({
    feature: "ask",
    model: "patient@example.test",
    status: "ok",
    durationMs: 250,
    usage: { in: 100, out: 20 },
  });
  registry.ai({
    feature: "ask",
    model: "claude-sonnet-5",
    status: "failed",
    durationMs: 50,
  });
  registry.ai({ feature: "ask", status: "skipped" });
  const text = registry.render();
  expect(text).toContain(
    'allos_ai_calls_total{feature="ask",model="other",outcome="ok"} 1'
  );
  expect(text).toContain(
    'allos_ai_tokens_total{feature="ask",model="other",outcome="ok",direction="input"} 100'
  );
  expect(text).toContain(
    'allos_ai_call_duration_seconds_sum{feature="ask",model="claude-sonnet-5",outcome="error"} 0.05'
  );
  expect(text).not.toMatch(/patient|skipped/);
});

it("seeds the latest persisted successful sync across profiles without identities", () => {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("metrics-private-person").lastInsertRowid
  );
  db.prepare(
    "INSERT INTO integration_sync_events (profile_id, source_id, at, ok) VALUES (?, 'garmin', ?, ?)"
  ).run(profileId, "2026-10-01T12:00:00.000Z", 1);
  db.prepare(
    "INSERT INTO integration_sync_events (profile_id, source_id, at, ok) VALUES (?, 'garmin', ?, ?)"
  ).run(profileId, "2026-10-02T12:00:00.000Z", 0);
  seedSyncMetrics(profileId);
  expect(metrics.render()).toContain(
    `allos_task_last_success_timestamp_seconds{task="garmin"} ${Date.parse("2026-10-01T12:00:00Z") / 1000}`
  );
  expect(metrics.render()).not.toContain("metrics-private-person");
});

it("refreshes successes written by the scheduler between scrapes", async () => {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("scheduler-metrics").lastInsertRowid
  );
  const insert = db.prepare(
    "INSERT INTO integration_sync_events (profile_id, source_id, at, ok) VALUES (?, 'strava', ?, ?)"
  );
  // Direct SQL models another process: it cannot update the web's memory metrics.
  insert.run(profileId, "2090-10-01T12:00:00Z", 1);
  seedSyncMetrics(profileId);
  const server = startMetrics(() => seedSyncMetrics(profileId))!;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const gauge = (at: string) =>
      `allos_task_last_success_timestamp_seconds{task="strava"} ${Date.parse(at) / 1000}`;
    expect(await (await fetch(`${url}/metrics`)).text()).toContain(
      gauge("2090-10-01T12:00:00Z")
    );
    insert.run(profileId, "2090-10-02T12:00:00Z", 1);
    insert.run(profileId, "2090-10-03T12:00:00Z", 0);
    expect(await (await fetch(`${url}/metrics`)).text()).toContain(
      gauge("2090-10-02T12:00:00Z")
    );
  } finally {
    await close(server);
  }
});

it("omits attended success gauges from persisted and live syncs while retaining run metrics", () => {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("scheduled-metrics-fixture").lastInsertRowid
  );
  for (const task of ["fitbit-takeout", "patient-portals", "strava"]) {
    recordSyncEvent(profileId, task, { ok: true });
  }
  seedSyncMetrics(profileId);
  for (const task of ["fitbit-takeout", "patient-portals"]) {
    expect(metrics.render()).not.toContain(
      `allos_task_last_success_timestamp_seconds{task="${task}"}`
    );
    recordSyncEvent(profileId, task, { ok: true, durationSeconds: 0.25 });
    const text = metrics.render();
    expect(text).not.toContain(
      `allos_task_last_success_timestamp_seconds{task="${task}"}`
    );
    expect(text).toContain(
      `allos_task_runs_total{task="${task}",outcome="ok"}`
    );
    expect(text).toContain(`allos_task_duration_seconds_count{task="${task}"}`);
  }
  recordSyncMetric("strava:ride-details", true, 0.25);
  for (const task of ["strava", "strava:ride-details"]) {
    expect(metrics.render()).toContain(
      `allos_task_last_success_timestamp_seconds{task="${task}"}`
    );
  }
});

it("counts a timed sync once when its audit log also contains a disclosure", () => {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("sync-metrics-fixture").lastInsertRowid
  );
  const before = Number(
    metrics
      .render()
      .match(
        /allos_task_runs_total\{task="health-connect",outcome="ok"\} (\d+)/
      )?.[1] ?? 0
  );
  recordSyncEvent(profileId, "health-connect", {
    ok: true,
    durationSeconds: 0.25,
  });
  recordSyncEvent(profileId, "health-connect", {
    ok: true,
    details: "supplementary disclosure",
  });
  expect(metrics.render()).toContain(
    `allos_task_runs_total{task="health-connect",outcome="ok"} ${before + 1}`
  );
});

it("retains strictly over 200 ms breaches across scrapes and stops sampling on cleanup", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const clock = vi.spyOn(performance, "now");
  let now = 0;
  clock.mockImplementation(() => now);
  const registry = new Metrics();
  const monitor = observeEventLoop(registry);
  const scrape = () => {
    monitor.collect();
    return registry.render();
  };
  const sample = (delay: number) => {
    now += 20 + delay;
    vi.advanceTimersByTime(20);
  };
  try {
    sample(199);
    sample(200);
    expect(scrape()).toContain("nodejs_eventloop_lag_breaches_total 0\n");
    sample(200.001);
    expect(scrape()).toContain("nodejs_eventloop_lag_breaches_total 1\n");
    expect(scrape()).toContain("nodejs_eventloop_lag_breaches_total 1\n");
    sample(500);
    sample(0);
    expect(scrape()).toContain("nodejs_eventloop_lag_breaches_total 2\n");
    monitor.stop();
    sample(500);
    expect(scrape()).toContain("nodejs_eventloop_lag_breaches_total 2\n");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    monitor.stop();
    clock.mockRestore();
    vi.useRealTimers();
  }
});

it("refreshes weather successes written by the sidecar after web startup", async () => {
  let collect: () => void = () => {};
  const start = vi
    .spyOn(runtime, "startMetrics")
    .mockImplementation((callback) => {
      collect = callback ?? (() => {});
      return undefined;
    });
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "");
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('metrics-sidecar')").run()
      .lastInsertRowid
  );
  const insert = db.prepare(
    "INSERT INTO integration_sync_events (profile_id, source_id, at, ok) VALUES (?, 'weather', ?, ?)"
  );
  const scrape = metricsServer(metrics, () => collect());
  try {
    await register();
    const url = await listen(scrape);
    const first = "2090-10-18T20:10:00Z";
    const next = "2090-10-19T14:10:00Z";
    insert.run(profileId, first, 1);
    expect(await (await fetch(`${url}/metrics`)).text()).toContain(
      `allos_task_last_success_timestamp_seconds{task="weather"} ${Date.parse(first) / 1000}`
    );
    // Direct SQL models another process: it cannot update the web's registry.
    insert.run(profileId, next, 1);
    insert.run(profileId, "2090-10-19T15:10:00Z", 0);
    expect(await (await fetch(`${url}/metrics`)).text()).toContain(
      `allos_task_last_success_timestamp_seconds{task="weather"} ${Date.parse(next) / 1000}`
    );
  } finally {
    await close(scrape);
    start.mockRestore();
    vi.unstubAllEnvs();
  }
});
