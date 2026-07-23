"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { IconChevronRight, IconCopy, IconCheck } from "@tabler/icons-react";
import {
  sniffRawFormat,
  isLargePayload,
  isJsonBranch,
  jsonKind,
  jsonCollapsedSummary,
  xmlCollapsedSummary,
  defaultBranchOpen,
  type JsonKind,
} from "@/lib/raw-data-tree";

// #1318 — ONE raw-data viewer for every raw payload / raw-extraction surface,
// replacing the bare <pre> dumps. Sniffs JSON vs XML vs plain text once
// (lib/raw-data-tree, pure) and renders JSON and XML through the SAME collapsible
// tree UI — two node adapters over one fold/depth/a11y machinery (#221) — with a
// copy-the-full-text button (clipboard API + textarea fallback), a depth default so
// deep payloads paint instantly, and a size guard that starts a large payload fully
// collapsed. Anything that parses as neither (incl. a DOMParser parsererror) is the
// plain-text last resort. Presentation-only — admin/profile gating stays with the
// callers.

type TreeCtx = {
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string) => void;
  large: boolean;
};
const RawTreeContext = createContext<TreeCtx | null>(null);
function useTree(): TreeCtx {
  const ctx = useContext(RawTreeContext);
  if (!ctx) throw new Error("RawDataViewer node rendered outside its provider");
  return ctx;
}

const KIND_TONE: Record<JsonKind, string> = {
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-sky-700 dark:text-sky-300",
  boolean: "text-violet-700 dark:text-violet-300",
  null: "text-slate-500 dark:text-slate-400",
  object: "",
  array: "",
};

function primitiveText(value: unknown, kind: JsonKind): string {
  if (kind === "null") return "null";
  if (kind === "string") return JSON.stringify(value); // keep the quotes
  return String(value);
}

function Caret({ open }: { open: boolean }) {
  return (
    <IconChevronRight
      className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      stroke={2}
    />
  );
}

// One JSON node (object/array → foldable branch; primitive → typed leaf).
function JsonNode({
  value,
  label,
  depth,
  path,
}: {
  value: unknown;
  label: string | null;
  depth: number;
  path: string;
}) {
  const tree = useTree();
  const kind = jsonKind(value);

  if (!isJsonBranch(value)) {
    return (
      <div className="flex flex-wrap items-baseline gap-1 py-0.5 pl-4 font-mono text-xs">
        {label != null && (
          <span className="text-slate-500 dark:text-slate-400">{label}:</span>
        )}
        <span className={KIND_TONE[kind]}>{primitiveText(value, kind)}</span>
      </div>
    );
  }

  const open = tree.isOpen(path, depth);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => tree.toggle(path)}
        aria-expanded={open}
        data-testid="raw-node-toggle"
        className="flex w-full items-baseline gap-1 rounded font-mono text-xs text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-200 dark:hover:bg-ink-800"
      >
        <Caret open={open} />
        {label != null && (
          <span className="text-slate-500 dark:text-slate-400">{label}:</span>
        )}
        <span className="text-slate-500 dark:text-slate-400">
          {Array.isArray(value) ? "[ ]" : "{ }"}
        </span>
        {!open && (
          <span className="text-slate-500 dark:text-slate-400">
            {jsonCollapsedSummary(value)}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-2 border-l border-black/10 pl-2 dark:border-white/10">
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              label={k}
              value={v}
              depth={depth + 1}
              path={`${path}.${k}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function xmlChildNodes(el: Element): Node[] {
  return Array.from(el.childNodes).filter(
    (n) =>
      n.nodeType === ELEMENT_NODE ||
      (n.nodeType === TEXT_NODE && (n.textContent ?? "").trim() !== "")
  );
}

function AttrList({ el }: { el: Element }) {
  const attrs = Array.from(el.attributes);
  if (attrs.length === 0) return null;
  return (
    <>
      {attrs.map((a) => (
        <span key={a.name} className="text-amber-700 dark:text-amber-300">
          {" "}
          {a.name}=
          <span className="text-emerald-700 dark:text-emerald-300">
            &quot;{a.value}&quot;
          </span>
        </span>
      ))}
    </>
  );
}

// One XML node. An element with only text (no element children) renders inline as a
// leaf; an element with children folds like a JSON branch. Standalone text nodes are
// typed leaves.
function XmlNode({
  node,
  depth,
  path,
}: {
  node: Node;
  depth: number;
  path: string;
}) {
  const tree = useTree();

  if (node.nodeType === TEXT_NODE) {
    return (
      <div className="py-0.5 pl-4 font-mono text-xs text-emerald-700 dark:text-emerald-300">
        {(node.textContent ?? "").trim()}
      </div>
    );
  }

  const el = node as Element;
  const children = xmlChildNodes(el);
  const hasElementChildren = children.some((c) => c.nodeType === ELEMENT_NODE);

  // Leaf element: no element children (maybe a single text value) → render inline.
  if (!hasElementChildren) {
    const text = (el.textContent ?? "").trim();
    return (
      <div className="flex flex-wrap items-baseline gap-1 py-0.5 pl-4 font-mono text-xs">
        <span className="text-brand-700 dark:text-brand-300">
          &lt;{el.nodeName}
        </span>
        <AttrList el={el} />
        <span className="text-brand-700 dark:text-brand-300">&gt;</span>
        {text && (
          <span className="text-emerald-700 dark:text-emerald-300">{text}</span>
        )}
      </div>
    );
  }

  const open = tree.isOpen(path, depth);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => tree.toggle(path)}
        aria-expanded={open}
        data-testid="raw-node-toggle"
        className="flex w-full items-baseline gap-1 rounded font-mono text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-ink-800"
      >
        <Caret open={open} />
        <span className="text-brand-700 dark:text-brand-300">
          &lt;{el.nodeName}&gt;
        </span>
        <AttrList el={el} />
        {!open && (
          <span className="text-slate-500 dark:text-slate-400">
            {xmlCollapsedSummary({
              attributeCount: el.attributes.length,
              childCount: children.length,
            })}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-2 border-l border-black/10 pl-2 dark:border-white/10">
          {children.map((c, i) => (
            <XmlNode key={i} node={c} depth={depth + 1} path={`${path}.${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlainText({ text }: { text: string }) {
  return (
    <pre
      data-testid="raw-plaintext"
      className="max-h-96 overflow-auto rounded-lg bg-slate-900/95 p-3 font-mono text-xs leading-relaxed text-slate-100 dark:bg-black/60"
    >
      {text}
    </pre>
  );
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to the execCommand fallback
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

export default function RawDataViewer({
  text,
  testId = "raw-data-viewer",
}: {
  text: string;
  testId?: string;
}) {
  const large = isLargePayload(text);
  // baseMode overrides the depth default when the user hits expand/collapse-all;
  // per-node toggles win over both.
  const [baseMode, setBaseMode] = useState<"default" | "open" | "closed">(
    "default"
  );
  const [overrides, setOverrides] = useState<Map<string, boolean>>(
    () => new Map()
  );
  const [copied, setCopied] = useState(false);

  // Parse once; never throw. XML that DOMParser rejects (parsererror) degrades to
  // the plain-text block. We resolve the concrete render mode here.
  const parsed = useMemo((): {
    mode: "json" | "xml" | "text";
    json?: unknown;
    root?: Element;
  } => {
    const format = sniffRawFormat(text);
    if (format === "json") {
      try {
        return { mode: "json", json: JSON.parse(text) };
      } catch {
        return { mode: "text" };
      }
    }
    if (format === "xml") {
      try {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror") || !doc.documentElement) {
          return { mode: "text" };
        }
        return { mode: "xml", root: doc.documentElement };
      } catch {
        return { mode: "text" };
      }
    }
    return { mode: "text" };
  }, [text]);

  const tree = useMemo<TreeCtx>(
    () => ({
      large,
      isOpen: (path, depth) => {
        const o = overrides.get(path);
        if (o !== undefined) return o;
        if (baseMode === "open") return true;
        if (baseMode === "closed") return false;
        return defaultBranchOpen(depth, large);
      },
      toggle: (path) =>
        setOverrides((prev) => {
          const next = new Map(prev);
          const existing = prev.get(path);
          // Flip against the CURRENTLY shown state: an existing override, else the
          // expand/collapse-all base, else the depth default. A node's depth is the
          // number of "." separators after the "$" root.
          const depth = path.split(".").length - 1;
          const cur =
            existing !== undefined
              ? existing
              : baseMode === "open"
                ? true
                : baseMode === "closed"
                  ? false
                  : defaultBranchOpen(depth, large);
          next.set(path, !cur);
          return next;
        }),
    }),
    [overrides, baseMode, large]
  );

  async function onCopy() {
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function expandAll() {
    setOverrides(new Map());
    setBaseMode("open");
  }
  function collapseAll() {
    setOverrides(new Map());
    setBaseMode("closed");
  }

  const isTree = parsed.mode === "json" || parsed.mode === "xml";

  return (
    <div data-testid={testId} className="mt-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {isTree && (
          <>
            <button
              type="button"
              onClick={expandAll}
              data-testid="raw-expand-all"
              className="btn-ghost text-xs"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              data-testid="raw-collapse-all"
              className="btn-ghost text-xs"
            >
              Collapse all
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onCopy}
          data-testid="raw-copy"
          className="btn-ghost inline-flex items-center gap-1 text-xs"
        >
          {copied ? (
            <>
              <IconCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span data-testid="raw-copied">Copied ✓</span>
            </>
          ) : (
            <>
              <IconCopy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>

      {large && isTree && (
        <p
          data-testid="raw-large-note"
          className="text-xs text-amber-700 dark:text-amber-400"
        >
          Large payload — started collapsed. Expand nodes as needed; copy grabs
          the full text.
        </p>
      )}

      {parsed.mode === "text" ? (
        <PlainText text={text} />
      ) : (
        <RawTreeContext.Provider value={tree}>
          <div className="max-h-96 overflow-auto rounded-lg border border-black/10 bg-slate-50 p-2 dark:border-white/10 dark:bg-ink-900">
            {parsed.mode === "json" ? (
              <JsonNode value={parsed.json} label={null} depth={0} path="$" />
            ) : (
              <XmlNode node={parsed.root!} depth={0} path="$" />
            )}
          </div>
        </RawTreeContext.Provider>
      )}
    </div>
  );
}
