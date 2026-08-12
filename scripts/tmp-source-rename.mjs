#!/usr/bin/env node
// TEMPORARY tooling for #2487 phase 1. Deleted before the PR is opened.
//
// Segments a TS/TSX file into code / comment / string regions and applies the
// integration-source rename ONLY to code and comment regions. String literals are
// left alone by construction, so no SQL text (where the column is still `provider`)
// can be rewritten by accident.
import fs from "node:fs";

const CODE_MAP = [
  ["getLatestSyncEventPerProvider", "getLatestSyncEventPerSource"],
  ["latestEventPerProvider", "latestEventPerSource"],
  ["currentlyFailingProviders", "currentlyFailingSources"],
  ["resolveProviderFacts", "resolveSourceFacts"],
  ["ProviderStandingFacts", "SourceStandingFacts"],
  ["ProviderStreamWithReminder", "SourceStreamWithReminder"],
  ["archiveRefreshProviders", "archiveRefreshSources"],
  ["ArchiveRefreshProvider", "ArchiveRefreshSource"],
  ["providerStanding", "sourceStanding"],
  ["ProviderStanding", "SourceStanding"],
  ["providerHealthy", "sourceHealthy"],
  ["ProviderStream", "SourceStream"],
  ["ProviderFacts", "SourceFacts"],
  ["ProviderBadge", "SourceBadge"],
  ["byProvider", "bySource"],
  ["providerIds", "sourceIds"],
  ["providerId", "sourceId"],
  ["providers", "sourceIds"],
  ["provider", "sourceId"],
];

const PROSE_MAP = [
  ["getLatestSyncEventPerProvider", "getLatestSyncEventPerSource"],
  ["currentlyFailingProviders", "currentlyFailingSources"],
  ["resolveProviderFacts", "resolveSourceFacts"],
  ["ProviderStandingFacts", "SourceStandingFacts"],
  ["archiveRefreshProviders", "archiveRefreshSources"],
  ["providerStanding", "sourceStanding"],
  ["ProviderStanding", "SourceStanding"],
  ["providerHealthy", "sourceHealthy"],
  ["ProviderStream", "SourceStream"],
  ["ProviderFacts", "SourceFacts"],
  ["providers", "sources"],
  ["Providers", "Sources"],
  ["provider", "source"],
  ["Provider", "Source"],
  ["PROVIDER", "SOURCE"],
];

// Comment lines that talk about the persisted column / index must keep the old word.
const SQL_HINT =
  /\bSELECT\b|\bWHERE\b|\bFROM\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bGROUP BY\b|\bDISTINCT\b|\bON CONFLICT\b|idx_|provider_id|provider_name|\(profile_id, provider\)/;

function apply(text, map) {
  let out = text;
  for (const [from, to] of map) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return out;
}

// Split into segments tagged code | comment | string. Template literals are split
// further so `${…}` interpolations are treated as code.
function segment(src) {
  const segs = [];
  let i = 0;
  let start = 0;
  const push = (kind, end) => {
    if (end > start) segs.push({ kind, text: src.slice(start, end) });
    start = end;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      push("code", i);
      const e = src.indexOf("\n", i);
      i = e === -1 ? src.length : e;
      push("comment", i);
      continue;
    }
    if (c === "/" && n === "*") {
      push("code", i);
      const e = src.indexOf("*/", i + 2);
      i = e === -1 ? src.length : e + 2;
      push("comment", i);
      continue;
    }
    if (c === '"' || c === "'") {
      push("code", i);
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === c) break;
        else j++;
      }
      i = Math.min(j + 1, src.length);
      push("string", i);
      continue;
    }
    if (c === "`") {
      push("code", i);
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          // flush the literal chunk (including the `${`), walk the interpolation as
          // code, then emit the closing `}` as literal again.
          j += 2;
          push("string", j);
          depth = 1;
          while (j < src.length && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") depth--;
            if (depth === 0) break;
            j++;
          }
          push("code", j);
          j++;
          push("string", j);
          continue;
        }
        if (src[j] === "`") break;
        j++;
      }
      i = Math.min(j + 1, src.length);
      push("string", i);
      continue;
    }
    i++;
  }
  push("code", src.length);
  return segs;
}

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8");
  const out = segment(src)
    .map((s) => {
      if (s.kind === "string") return s.text;
      if (s.kind === "code") return apply(s.text, CODE_MAP);
      // comment: keep lines that are explicitly about SQL as-is
      return s.text
        .split("\n")
        .map((line) => (SQL_HINT.test(line) ? line : apply(line, PROSE_MAP)))
        .join("\n");
    })
    .join("");
  if (out !== src) fs.writeFileSync(file, out);
}
