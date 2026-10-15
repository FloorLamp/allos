// Operational aggregates only. Shared across Next's separately bundled entrypoints.
import type { AiEvent } from "./ai-log";
import { INTEGRATIONS } from "./integrations/registry";

function knownTask(task: string): boolean {
  return INTEGRATIONS.some(
    (source) =>
      source.id === task ||
      source.backfills?.some(
        (backfill) => `${source.id}:${backfill.id}` === task
      )
  );
}

export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];
type Labels = Record<string, string>;
type Series = {
  labels: Labels;
  value: number;
  buckets?: number[];
  sum?: number;
};
export class Metrics {
  private families = new Map<
    string,
    { type: string; series: Map<string, Series> }
  >();

  private series(name: string, type: string, labels: Labels): Series {
    let family = this.families.get(name);
    if (!family) {
      family = { type, series: new Map() };
      this.families.set(name, family);
    }
    const key = JSON.stringify(labels);
    let series = family.series.get(key);
    if (!series) {
      series = { labels, value: 0 };
      family.series.set(key, series);
    }
    return series;
  }

  gauge(name: string, labels: Labels, value: number) {
    if (Number.isFinite(value))
      this.series(name, "gauge", labels).value = value;
  }

  count(name: string, labels: Labels, value = 1) {
    if (Number.isFinite(value) && value >= 0)
      this.series(name, "counter", labels).value += value;
  }

  observe(name: string, labels: Labels, seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const s = this.series(name, "histogram", labels);
    s.value++;
    s.sum = (s.sum ?? 0) + seconds;
    s.buckets ??= DURATION_BUCKETS.map(() => 0);
    DURATION_BUCKETS.forEach((limit, i) => {
      if (seconds <= limit) s.buckets![i]++;
    });
  }

  success(task: string, timestamp: number) {
    if (!knownTask(task) || !Number.isFinite(timestamp)) return;
    const s = this.series(
      "allos_task_last_success_timestamp_seconds",
      "gauge",
      { task }
    );
    s.value = Math.max(s.value, timestamp);
  }

  ai(event: Omit<AiEvent, "id" | "time">) {
    if (!event.model || event.status === "skipped" || event.durationMs == null)
      return;
    // Model settings are arbitrary strings; expose only known public model names.
    const model = [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
    ].includes(event.model)
      ? event.model
      : "other";
    const labels = {
      feature: event.feature,
      model,
      outcome: event.status === "ok" ? "ok" : "error",
    };
    this.count("allos_ai_calls_total", labels);
    this.observe(
      "allos_ai_call_duration_seconds",
      labels,
      event.durationMs / 1000
    );
    if (event.usage) {
      this.count(
        "allos_ai_tokens_total",
        { ...labels, direction: "input" },
        event.usage.in
      );
      this.count(
        "allos_ai_tokens_total",
        { ...labels, direction: "output" },
        event.usage.out
      );
    }
  }

  render(): string {
    const lines: string[] = [];
    const labelText = (labels: Labels) => {
      const entries = Object.entries(labels);
      return entries.length
        ? `{${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`
        : "";
    };
    for (const [name, family] of this.families) {
      lines.push(`# TYPE ${name} ${family.type}`);
      for (const s of family.series.values()) {
        if (family.type === "histogram") {
          DURATION_BUCKETS.forEach((limit, i) =>
            lines.push(
              `${name}_bucket${labelText({ ...s.labels, le: String(limit) })} ${s.buckets![i]}`
            )
          );
          lines.push(
            `${name}_bucket${labelText({ ...s.labels, le: "+Inf" })} ${s.value}`
          );
          lines.push(`${name}_sum${labelText(s.labels)} ${s.sum}`);
          lines.push(`${name}_count${labelText(s.labels)} ${s.value}`);
        } else lines.push(`${name}${labelText(s.labels)} ${s.value}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
const shared = globalThis as typeof globalThis & { allosMetrics?: Metrics };
export const metrics = (shared.allosMetrics ??= new Metrics());

export function recordSyncMetric(task: string, ok: boolean, seconds: number) {
  if (!knownTask(task)) return;
  metrics.count("allos_task_runs_total", {
    task,
    outcome: ok ? "ok" : "error",
  });
  metrics.observe("allos_task_duration_seconds", { task }, seconds);
  if (ok) metrics.success(task, Date.now() / 1000);
}
