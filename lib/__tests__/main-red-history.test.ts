import { describe, it, expect } from "vitest";
import {
  detectorStanding,
  baseDetectorNotice,
} from "../../scripts/orchestration/merge-gate-core.mjs";
import {
  MARKER,
  mergePr,
  readHistory,
  renderHistory,
  verdictFor,
  verdictNote,
} from "../../scripts/orchestration/main-red-history.mjs";
import incident from "./__fixtures__/e2e-main-c6d2b2ed-incident.json";

// THE ACCEPTANCE FIXTURE IS THE INCIDENT (#5160). Every row of
// `e2e-main-c6d2b2ed-incident.json` is a real `e2e-main` verdict recorded from
// GitHub over main's 2026-09-04/05 heads, including the red at `c6d2b2ed` that
// went unchased and the red five merges later that got the blame. The point of
// recording it rather than inventing one: the states this tool must keep apart
// — a debounced head with no run at all, a push that ran nothing, the same
// failing test recurring across green heads — are shapes CI actually produced,
// not shapes chosen by the person writing the assertion.

/** The fixture stores name -> conclusion; the classifier reads check runs. */
const heads = (rows: typeof incident) =>
  rows.map((row) => ({
    sha: row.sha,
    subject: row.subject,
    failures: row.failures,
    runs: Object.entries(row.runs).map(([name, conclusion]) => ({
      name,
      status: "completed",
      conclusion,
    })),
  }));

const SLEEP =
  "[chromium] › e2e/sleep-page.spec.ts:600:7 › Sleep page (#1066) › the Add entry action opens the shared sleep and mood editor";
const FOOD =
  "[chromium] › e2e/offline-food-log.spec.ts:46:7 › protein quick-add hydration (#4399) › the arming fill survives a forced pre-hydration window";

const history = readHistory(heads(incident));
const at = (sha: string) => history.heads.findIndex((h) => h.sha === sha);

describe("the recorded c6d2b2ed incident", () => {
  // THE WHOLE ISSUE IN ONE ASSERTION. The false attribution named a2bb777e
  // (#5129); the same failing test had been red at c6d2b2ed five merges before.
  it("opens the record of failure at c6d2b2ed, not at the merge that got blamed", () => {
    expect(history.heads[history.firstRed].sha).toBe("c6d2b2ed");
    const report = renderHistory(history).join("\n");
    expect(report).toContain("First failing head in this window: c6d2b2ed");
    expect(report.indexOf("c6d2b2ed")).toBeLessThan(report.indexOf("a2bb777e"));
  });

  it("refuses to call the blamed merge the first failure", () => {
    const { headline, evidence } = verdictFor(history.heads, at("a2bb777e"));
    expect(headline).toContain("NOT NEW HERE");
    expect(headline).toContain("c6d2b2ed");
    expect(evidence.join("\n")).toContain(`already red at c6d2b2ed: ${SLEEP}`);
    // Four heads ran green between the two reds, which is what makes
    // "intermittent, cross-test, not this merge" a recorded RESULT.
    expect(evidence.join("\n")).toMatch(/4 observed-GREEN head\(s\).*INTERMITTENT/s);
  });

  // "First observed" is a fact about what RAN. The tool states the bound and
  // then states that the bound is not proof, in the same sentence.
  it("bounds the first observed failure without claiming the merge caused it", () => {
    const { headline } = verdictFor(history.heads, at("c6d2b2ed"));
    expect(headline).toContain("FIRST OBSERVED FAILURE");
    expect(headline).toContain("68b5db32");
    expect(headline).toContain("does not");
    expect(headline).not.toMatch(/introduc|caused by/i);
  });

  // A HEAD THAT NOBODY OBSERVED IS NOT A GREEN ONE, and it is not a red one
  // either. 38e36a85 landed between the two reds and the debounce collapsed it
  // into a later run: it has no `e2e-main` check run at all.
  it.each([
    ["38e36a85", "UNOBSERVED", "unobserved"],
    ["8c9ce64a", "NOTHING RAN", "nothing-ran"],
    ["1dbb1774", "green", "green"],
    ["a2bb777e", "RED", "red"],
  ])("prints %s as %s", (sha, label, kind) => {
    expect(history.heads[at(sha)].kind).toBe(kind);
    const line = renderHistory(history)
      .join("\n")
      .split("\n")
      .find((l) => l.trim().startsWith(sha));
    expect(line).toContain(label);
  });

  // ONE HEAD, TWO ANSWERS. db376bfa carried a failure that had been red since
  // 63901385 AND one appearing for the first time. Answering per head would
  // have buried whichever of the two the single answer did not describe.
  it("splits a head that carries an old failure and a new one", () => {
    const { headline, evidence } = verdictFor(history.heads, at("db376bfa"));
    expect(headline).toContain("PART CARRIED, PART NEW");
    expect(evidence.join("\n")).toContain(`already red at 63901385: ${FOOD}`);
    expect(evidence.join("\n")).toContain(
      "first red here: [mobile] › e2e/mobile-density-sweep.mobile.spec.ts:539:5"
    );
  });

  // The fixture must be able to produce every state this file asserts on;
  // a census whose pattern never matches is green for no reason (#5160 brief).
  it("reaches every state the assertions above discriminate", () => {
    const seen = new Set(history.heads.map((h) => h.kind));
    expect([...seen].sort()).toEqual([
      "green",
      "nothing-ran",
      "red",
      "unobserved",
    ]);
    expect(history.heads.filter((h) => h.kind === "red").length).toBe(7);
  });
});

describe("what the run of heads can and cannot say", () => {
  const run = (kind: string, sha: string, failures: string[] = []) => ({
    sha,
    subject: `subject for ${sha} (#4001)`,
    failures,
    runs:
      kind === "unobserved"
        ? []
        : [
            {
              name: "e2e-main (1)",
              status: kind === "pending" ? "in_progress" : "completed",
              conclusion:
                kind === "pending"
                  ? null
                  : kind === "red"
                    ? "failure"
                    : kind === "nothing-ran"
                      ? "skipped"
                      : kind === "cancelled"
                        ? "cancelled"
                        : "success",
            },
          ],
  });

  // EVERY HOLE IS A HOLE. Four different reasons a head carries no verdict,
  // and each one widens the range the same way — so none of them may be read
  // as "the previous head was fine".
  it.each(["unobserved", "nothing-ran", "cancelled", "pending"])(
    "widens the range across a %s head",
    (hole) => {
      const rows = readHistory([
        run("green", "aa000001"),
        run(hole, "bb000002"),
        run("red", "cc000003", ["spec one"]),
      ]);
      const { headline, evidence } = verdictFor(rows.heads, 2);
      expect(headline).toContain("FIRST OBSERVED FAILURE, over a gap");
      expect(headline).toContain("aa000001");
      expect(evidence.join("\n")).toContain("bb000002");
    }
  );

  it("says so when the window opens on a failing head", () => {
    const rows = readHistory([
      run("red", "dd000004", ["spec one"]),
      run("green", "ee000005"),
    ]);
    expect(verdictFor(rows.heads, 0).headline).toContain(
      "FIRST FAILING HEAD IN THIS WINDOW"
    );
    expect(renderHistory(rows).join("\n")).toContain(
      "THE WINDOW OPENS ON A FAILING HEAD"
    );
  });

  it("names a shard-set change rather than comparing shard numbers across it", () => {
    const rows = readHistory([
      run("green", "ff000006"),
      {
        sha: "aa000007",
        subject: "resharded (#4002)",
        failures: ["spec one"],
        runs: [
          { name: "e2e-main (1)", status: "completed", conclusion: "failure" },
          { name: "e2e-main (2)", status: "completed", conclusion: "success" },
        ],
      },
    ]);
    expect(verdictFor(rows.heads, 1).evidence.join("\n")).toContain(
      "SHARD SET CHANGED since ff000006"
    );
  });

  it("says when no annotation was readable rather than implying a match", () => {
    const rows = readHistory([run("green", "aa000008"), run("red", "bb000009")]);
    expect(verdictFor(rows.heads, 1).evidence.join("\n")).toContain(
      "no failing-test annotation was readable"
    );
  });
});

describe("a red carries a verdict or it carries none", () => {
  const note = (body: string) => [{ body, at: "2026-09-05T00:00:00Z", user: "someone" }];

  it.each([
    [`${MARKER}: c6d2b2ed intermittent, cross-test, not this merge`, true, false],
    [`${MARKER}: a2bb777e some other head`, false, false],
    ["nothing here names the head at all", false, false],
    [`> ${MARKER}: c6d2b2ed quoted from elsewhere`, false, true],
    ["```\n" + `${MARKER}: c6d2b2ed shown as an example\n` + "```", false, true],
  ])("reads %j as verdict=%s unread=%s", (body, found, unread) => {
    const result = verdictNote(note(body), "c6d2b2ed");
    expect(Boolean(result.verdict)).toBe(found);
    expect(Boolean(result.unread)).toBe(unread);
  });

  it("prints the line to post when a red has no verdict", () => {
    const rows = readHistory([
      {
        sha: "cc000010",
        subject: "a merge (#4003)",
        failures: ["spec one"],
        runs: [
          { name: "e2e-main (1)", status: "completed", conclusion: "failure" },
        ],
      },
    ]);
    const report = renderHistory(
      rows,
      new Map([["cc000010", { verdict: null, unread: null }]])
    ).join("\n");
    expect(report).toContain("UNEXAMINED");
    expect(report).toContain(`${MARKER}: cc000010`);
  });

  it.each([
    ["Own the night the Add-entry test asserts (#5156)", "5156"],
    ["Let the intraday chart pick its geometry from its own container", null],
  ])("reads the merge PR out of %j", (subject, pr) => {
    expect(mergePr(subject)).toBe(pr);
  });
});

// ONE CLASSIFIER, TWO READERS (#5160). The history tool and the merge gate ask
// the identical question of a head; these pin that they still answer it from
// the same place, so a second verdict parser cannot quietly appear.
describe("the shared detector classifier", () => {
  const shard = (conclusion: string | null, status = "completed") => ({
    name: "e2e-main (1)",
    status,
    conclusion,
  });

  it.each([
    [[], "unobserved", "no verdict"],
    [[shard("cancelled")], "cancelled", "every shard run was cancelled"],
    [[shard("failure")], "red", "is RED"],
    [[shard(null, "in_progress")], "pending", "still running"],
    [[shard("skipped")], "nothing-ran", "ran NOTHING"],
    [[shard("success")], "green", "is green"],
  ])("classifies %#: %s", (runs, kind, notice) => {
    expect(detectorStanding(runs).kind).toBe(kind);
    expect(baseDetectorNotice(runs, "main")).toContain(notice);
  });
});
