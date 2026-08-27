import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", path.join("lib", "notifications")];
const SCAN_FILES = ["lib/disclaimers.ts"];
const EXCLUDE_SUBPATH = ["app/api/"];

const CROSS_PROFILE_PREFIXES = [
  "app/(app)/household/",
  "app/(app)/settings/family/",
  "components/household/",
];
const CROSS_PROFILE_FILES = new Set([
  "components/dashboard/HouseholdHistoryPromoLink.tsx",
  "components/HouseholdCard.tsx",
  "components/ProfileSwitcherChip.tsx",
  "components/SubjectChip.tsx",
]);
const CROSS_PROFILE_MARKERS = [
  /\bProfileScope\b/,
  /\bSubjectInfo\b/,
  /\bviewIds\b/,
];

const BANNED: { re: RegExp; label: string }[] = [
  {
    re: /\bcould not\b/i,
    label: '"could not" (use the contraction "Couldn\'t")',
  },
  {
    re: /\bfailed to\b/i,
    label: '"failed to" (use "Couldn\'t <verb> <object>.")',
  },
  {
    re: /\bunable to\b/i,
    label: '"unable to" (use "Couldn\'t <verb> <object>.")',
  },
  {
    re: /\bplease\b/i,
    label: '"please" (the house voice drops it)',
  },
];
const COULDNT_LITERAL = /(["'])(Couldn['’]t [^"']*?)\1/g;
const TERMINAL = /[.?!]$/;

const ALLOW: { file: string; substring: string }[] = [
  {
    file: "app/(app)/onboarding/actions.ts",
    substring: "The adopted routine could not be activated.",
  },
];

const FAMILY_LOGIN_COPY =
  "Family settings administers the signed-in login's roster and grants.";
const VIEW_CONTROL_COPY =
  "The profile-view controls belong to the signed-in login.";
const ACTING_IMMUNIZATION_COPY =
  "The schedule assessment is deliberately acting-profile-only.";
const ACTING_SUBSTANCE_USE_COPY =
  "Substance use is deliberately acting-profile-only (#2557).";
const CROSS_PROFILE_VOICE_ALLOW: {
  file: string;
  substring: string;
  why: string;
}[] = [
  {
    file: "app/(app)/records/ImmunizationsSection.tsx",
    substring: "You're up to date on the tracked schedule.",
    why: ACTING_IMMUNIZATION_COPY,
  },
  {
    file: "app/(app)/records/specialty/substance-use/page.tsx",
    substring: "reduction targets you set",
    why: ACTING_SUBSTANCE_USE_COPY,
  },
  {
    file: "app/(app)/records/ImmunizationsSection.tsx",
    substring:
      "Add your date of birth in Settings to see age-based recommendations.",
    why: ACTING_IMMUNIZATION_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "You already have a profile named",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "The people you track. Adding a family member",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "unless you want to give",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "only the profiles you grant them below.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "you can grant access later under Access.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "If this is your own",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "login, you’ll be signed out.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/upcoming/page.tsx",
    substring: "You can view several profiles at once",
    why: VIEW_CONTROL_COPY,
  },
  {
    file: "components/ProfileSwitcherPanel.tsx",
    substring: "Toggle the eye to show a profile in your",
    why: VIEW_CONTROL_COPY,
  },
  {
    file: "components/ProfileSwitcherPanel.tsx",
    substring: "is always in your view",
    why: VIEW_CONTROL_COPY,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next") {
        out.push(...walk(full));
      }
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of walk(path.join(REPO, dir))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      if (EXCLUDE_SUBPATH.some((prefix) => rel.startsWith(prefix))) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  for (const rel of SCAN_FILES) {
    files.push({ rel, text: fs.readFileSync(path.join(REPO, rel), "utf8") });
  }
  return files;
}

function crossProfileSourceFiles(): { rel: string; text: string }[] {
  return sourceFiles().filter(
    ({ rel, text }) =>
      rel.endsWith(".tsx") &&
      (CROSS_PROFILE_FILES.has(rel) ||
        CROSS_PROFILE_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
        CROSS_PROFILE_MARKERS.some((marker) => marker.test(text)))
  );
}

function isInternalLine(line: string): boolean {
  return (
    /\bconsole\.\w+\s*\(/.test(line) ||
    /\blog\.(error|warn|info|debug|trace)\s*\(/.test(line) ||
    /\bthrow new \w*Error\s*\(/.test(line) ||
    /^\s*import\s/.test(line) ||
    /^\s*export\s.*\bfrom\s/.test(line)
  );
}

function crossProfileVoiceViolations(rel: string, text: string): string[] {
  const violations: string[] = [];
  stripComments(text)
    .split("\n")
    .forEach((line, index) => {
      if (isInternalLine(line)) return;
      if (
        /\b(?:you|your)\b/i.test(line) &&
        !CROSS_PROFILE_VOICE_ALLOW.some(
          (entry) => entry.file === rel && line.includes(entry.substring)
        )
      ) {
        violations.push(
          `${rel}:${index + 1} — second-person copy in: ${line.trim()}`
        );
      }
    });
  return violations;
}

describe("copy-lint: user-facing tone standard (issue #945)", () => {
  it("has no banned error phrasing or 'please' in user-facing copy", () => {
    const violations: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      stripComments(text)
        .split("\n")
        .forEach((line, index) => {
          if (isInternalLine(line)) return;
          for (const { re, label } of BANNED) {
            const allowed = ALLOW.some(
              (entry) => entry.file === rel && line.includes(entry.substring)
            );
            if (re.test(line) && !allowed) {
              violations.push(
                `${rel}:${index + 1} — ${label} in: ${line.trim()}`
              );
            }
          }
        });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it('ends every "Couldn\'t …" error string with punctuation', () => {
    const violations: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      stripComments(text)
        .split("\n")
        .forEach((line, index) => {
          if (/\b(aria-label|title)\s*=/.test(line)) return;
          COULDNT_LITERAL.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = COULDNT_LITERAL.exec(line)) !== null) {
            if (!TERMINAL.test(match[2].trim())) {
              violations.push(`${rel}:${index + 1} — "${match[2]}"`);
            }
          }
        });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it('avoids "you" and "your" health-data copy on cross-profile surfaces', () => {
    const violations = crossProfileSourceFiles().flatMap(({ rel, text }) =>
      crossProfileVoiceViolations(rel, text)
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("detects cross-profile copy and ignores internal text", () => {
    const sample = [
      "// your comment",
      'console.warn("your diagnostic")',
      'const title = "Your medications";',
      "<p>When you log a dose, it appears here.</p>",
    ].join("\n");
    expect(crossProfileVoiceViolations("synthetic.tsx", sample)).toEqual([
      'synthetic.tsx:3 — second-person copy in: const title = "Your medications";',
      "synthetic.tsx:4 — second-person copy in: <p>When you log a dose, it appears here.</p>",
    ]);
  });

  it("keeps inventories honest", () => {
    const files = sourceFiles();
    const knownFiles = new Set(files.map((file) => file.rel));
    expect(
      [...CROSS_PROFILE_FILES].filter((file) => !knownFiles.has(file))
    ).toEqual([]);
    expect(
      ALLOW.filter(
        (entry) =>
          !files.some(
            (file) =>
              file.rel === entry.file && file.text.includes(entry.substring)
          )
      )
    ).toEqual([]);

    const crossProfileFiles = crossProfileSourceFiles();
    expect(
      CROSS_PROFILE_VOICE_ALLOW.filter(
        (entry) =>
          !entry.why ||
          !/\b(?:you|your)\b/i.test(entry.substring) ||
          !crossProfileFiles.some(
            (file) =>
              file.rel === entry.file && file.text.includes(entry.substring)
          )
      )
    ).toEqual([]);
  });
});
