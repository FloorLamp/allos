import { channel } from "node:diagnostics_channel";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { normalizeAppPath } from "next/dist/shared/lib/router/utils/app-paths";
import { metrics, type Metrics } from "./metrics";

export function routeMatcher(appPaths: string[]) {
  const routes = getSortedRoutes(
    [...new Set(appPaths.map(normalizeAppPath))].filter(
      (route) => !route.startsWith("/_")
    )
  ).map((route) => ({ route, re: getRouteRegex(route).re }));
  return (url: string) => {
    let pathname: string;
    try {
      pathname = new URL(url, "http://localhost").pathname;
    } catch {
      return "unmatched";
    }
    return routes.find(({ re }) => re.test(pathname))?.route ?? "unmatched";
  };
}

export function observeRequests(
  registry: Metrics,
  match: (url: string) => string
) {
  const onRequest = (message: unknown) => {
    const { request, response } = message as {
      request: IncomingMessage;
      response: ServerResponse;
    };
    const pathname = (request.url ?? "/").split("?", 1)[0];
    const route = match(request.url ?? "/");
    if (["/metrics", "/healthz", "/api/health"].includes(pathname)) return;
    const start = performance.now();
    response.once("finish", () => {
      const method = request.method ?? "OTHER";
      registry.observe(
        "http_request_duration_seconds",
        {
          route,
          method: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "HEAD",
            "OPTIONS",
          ].includes(method)
            ? method
            : "OTHER",
          status: String(response.statusCode),
        },
        (performance.now() - start) / 1000
      );
    });
  };
  channel("http.server.request.start").subscribe(onRequest);
  return () => channel("http.server.request.start").unsubscribe(onRequest);
}

export function metricsServer(
  registry: Metrics,
  collect: () => void = () => {}
) {
  return createServer((req, res) => {
    if (
      req.url !== "/metrics" ||
      req.method !== "GET" ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-forwarded-host"]
    ) {
      res.writeHead(404).end();
      return;
    }
    collect();
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(registry.render());
  });
}

// Sampling is independent of HTTP scrapes: a diagnostic scrape cannot erase a
// breach. Count delayed samples, not milliseconds, with one label-free series.
export function observeEventLoop(registry: Metrics) {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  registry.count("nodejs_eventloop_lag_breaches_total", {}, 0);
  let previous = performance.now();
  const timer = setInterval(() => {
    const current = performance.now();
    if (current > previous + 20 + 200)
      registry.count("nodejs_eventloop_lag_breaches_total", {});
    previous = current;
  }, 20);
  timer.unref();
  return {
    collect() {
      registry.gauge(
        "nodejs_eventloop_lag_p50_seconds",
        {},
        lag.count > 0 ? lag.percentile(50) / 1e9 : 0
      );
      registry.gauge(
        "nodejs_eventloop_lag_p99_seconds",
        {},
        lag.count > 0 ? lag.percentile(99) / 1e9 : 0
      );
      registry.gauge("nodejs_eventloop_lag_max_seconds", {}, lag.max / 1e9);
      lag.reset();
    },
    stop() {
      clearInterval(timer);
      lag.disable();
    },
  };
}

// The web process exports these aggregates; notify and CLI processes stay separate.
export function startMetrics(collectSyncMetrics: () => void = () => {}) {
  const shared = globalThis as typeof globalThis & {
    allosMetricsStarted?: boolean;
  };
  if (shared.allosMetricsStarted) return;
  shared.allosMetricsStarted = true;
  const dist = process.env.NEXT_DIST_DIR || ".next";
  // Production's manifest includes every page and API route, without route groups.
  // Read from the cwd, which `next start <dir>` need not be (the e2e workers run in
  // their own dirs): unreadable, every route is "unmatched", never a server that
  // cannot start (the instrumentation hook's throw 500s every page).
  let appPaths: string[] = [];
  try {
    appPaths = Object.keys(
      JSON.parse(
        readFileSync(
          path.join(process.cwd(), dist, "server/app-paths-manifest.json"),
          "utf8"
        )
      )
    );
  } catch (error) {
    console.error("metrics: no route manifest", (error as Error).message);
  }
  const stopRequests = observeRequests(metrics, routeMatcher(appPaths));
  const lag = observeEventLoop(metrics);
  const server = metricsServer(metrics, () => {
    collectSyncMetrics();
    metrics.gauge("nodejs_heap_used_bytes", {}, process.memoryUsage().heapUsed);
    lag.collect();
  });
  const stop = () => {
    lag.stop();
    stopRequests();
    shared.allosMetricsStarted = false;
  };
  server.once("close", stop);
  server.on("error", (error) => {
    stop();
    console.error("metrics listener failed", error.message);
  });
  server.listen(9830, "0.0.0.0");
  server.unref();
}
