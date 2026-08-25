import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FLOW_KINDS } from "@/lib/offline/queue";
import { QUICK_LOG_IDS, type QuickLogId } from "@/lib/quick-log";
import { QUICK_LOG_ROW_CONTRACT } from "@/lib/quick-log-row-contract";

describe("quick-log row contract (#3275)", () => {
  it("declares exactly every QuickLogId", () => {
    expect(Object.keys(QUICK_LOG_ROW_CONTRACT).sort()).toEqual(
      [...QUICK_LOG_IDS].sort()
    );
  });

  it("names only real queue flows and requires an argument for exclusions", () => {
    for (const id of QUICK_LOG_IDS) {
      const story = QUICK_LOG_ROW_CONTRACT[id].offline;
      if (story.status === "covered") {
        expect(story.flows.length, id).toBeGreaterThan(0);
        for (const flow of story.flows) expect(FLOW_KINDS, id).toContain(flow);
      } else {
        expect(story.argument.length, id).toBeGreaterThan(40);
      }
    }
  });

  it("codifies the #3166 stool ruling as queue coverage", () => {
    expect(QUICK_LOG_ROW_CONTRACT["log-stool"].offline).toMatchObject({
      status: "covered",
      flows: ["stool"],
    });
    expect(QUICK_LOG_ROW_CONTRACT["log-stool"].offline.detail).toContain(
      "#3166"
    );
  });

  it("carries one stool event identity through the action and queue fallback", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/quick-entry/QuickStoolForm.tsx"),
      "utf8"
    );
    const capture = source.indexOf("const capture = {");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(source.indexOf("ledger.tap<StoolTap>"));
    expect(source).toContain(
      'const kept = await enqueue("stool", today, { type }, capture);'
    );
    expect(source).toContain('fd.set("event_key", capture.key);');
    expect(source).toContain('fd.set("captured_at", capture.capturedAt);');
  });

  it("does not borrow another dose surface's offline coverage", () => {
    expect(QUICK_LOG_ROW_CONTRACT["log-dose"].offline).toMatchObject({
      status: "excluded",
    });
    const story = QUICK_LOG_ROW_CONTRACT["log-dose"].offline;
    expect(story.status === "excluded" ? story.argument : "").toContain(
      "#3272"
    );
  });

  it("requires field-bearing submit forms to use inline alert plus toast", () => {
    for (const id of QUICK_LOG_IDS) {
      const failure = QUICK_LOG_ROW_CONTRACT[id].failure;
      if (failure.fields === "form") {
        expect(failure.channel, id).toBe("inline-and-toast");
      }
    }

    const helper = fs.readFileSync(
      path.join(process.cwd(), "components/useInlineToastFailure.ts"),
      "utf8"
    );
    expect(helper).toMatch(
      /setError\(message\);[\s\S]*toast\(message, \{ tone: "error" \}\);/
    );

    const sources = [
      "app/(app)/trends/MeasurementsQuickAdd.tsx",
      "components/UploadForm.tsx",
    ].map(
      (file) =>
        [file, fs.readFileSync(path.join(process.cwd(), file), "utf8")] as const
    );
    for (const [file, source] of sources) {
      expect(source, `${file}: visible inline failure`).toMatch(
        /\{error && \([\s\S]{0,500}role=["']alert["'][\s\S]{0,500}\{error\}/
      );
      expect(source, `${file}: exact paired helper adoption`).toMatch(
        /const \{ error, clearError, fail \} = useInlineToastFailure\(\);/
      );
      expect(source, `${file}: no unpaired inline-only setter`).not.toMatch(
        /setError\(/
      );
      expect(source, `${file}: no unpaired error toast`).not.toMatch(
        /toast\([\s\S]{0,200}\{ tone: "error" \}/
      );
    }

    const measurements = sources[0][1];
    for (const failure of [
      'fail("Enter at least one measurement.")',
      'fail("Enter a weight to save a note.")',
      "fail(firstError)",
      "fail(OFFLINE_CAPTURE_REFUSED_MESSAGE)",
      `fail("You're offline — reconnect to save these measurements.")`,
      `fail("Couldn't save these measurements. Try again.")`,
    ]) {
      expect(measurements, failure).toContain(failure);
    }

    const upload = sources[1][1];
    expect(upload).toMatch(
      /const message = "Couldn't attach the photo\. Try again\.";\s*fail\(message\);\s*return message;/
    );
    expect(upload).toContain('fail("Couldn’t upload the files. Try again.")');
    expect(upload).toContain('fail("Choose at least one file to upload.")');
  });

  it("uses the canonical action verbs and makes every divergence an argued exception", () => {
    const exceptionVerbs: Partial<Record<QuickLogId, string | null>> = {
      "log-activity": null,
      "live-workout": "Start workout / Resume workout",
      "log-food": "Add a serving / Add protein grams",
      "log-mood": "Log mood",
      "log-period": "Start period / End period / Reopen period",
      "log-stool": "Log type",
      "log-substance": "Log a use / Log a standard drink",
      "add-document": "Upload",
    };
    const exceptions: QuickLogId[] = [];
    for (const id of QUICK_LOG_IDS) {
      const commit = QUICK_LOG_ROW_CONTRACT[id].commit;
      if (commit.kind === "action") {
        expect(["Mark taken", "Log now"], id).toContain(commit.verb);
      }
      if (commit.kind === "form")
        expect(commit.verb, id).toMatch(/^Save(?:\s|$)/);
      if (commit.kind === "exception") {
        expect(commit.argument.length, id).toBeGreaterThan(40);
        expect(commit.verb, id).toBe(exceptionVerbs[id]);
        exceptions.push(id);
      }
    }
    expect(exceptions).toEqual([
      "log-activity",
      "live-workout",
      "log-food",
      "log-mood",
      "log-period",
      "log-stool",
      "log-substance",
      "add-document",
    ]);
  });
});
