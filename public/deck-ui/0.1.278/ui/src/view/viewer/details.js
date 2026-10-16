import {StatusLink} from '../failure.js';
import {describeFailure} from '../../failure.js';
// The document pane (palette SPEC.md, *Details*; details.js its state): what bridge read from the document (the head: title, type,
// date, summary; the facts by subject with their quotes; the fields; the text read) and, with the `corrections` cap, the owner's
// corrections: Edit and Revert the head, a fact's Edit value, Wrong and Revert, Same as… a subject (its matches as you type), Unfold,
// Not a document or Restore, Re-read with its preview (Save, Discard), and Undo on the status line for a few seconds after a write.
// Keys stay here (Esc closes what is open; Mod+Z undoes); the viewer's own keys never act on a key typed in it.
import {h} from '../../../vendor/preact.mjs';
import {useLayoutEffect, useReducer, useRef, useEffect} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {dateLabel} from '../../../../palette/model.mjs';
import {HEAD, keyLabel, typeLabel} from '../../details.js';
import {keyName} from '../keys.js';
import {Glyph} from '../../glyphs.js';

const html = htm.bind(h);
const NAMES = {title: 'Title', type: 'Type', date: 'Date', summary: 'Summary'};
const shown = (k, v) => k === 'type' ? typeLabel(v) : k === 'date' ? dateLabel(v) : v;

/** d: the pane's state (details.js createDetails); mod: the platform's Mod. */
export function Details({d, mod = 'Control'}) {
  const [, redraw] = useReducer(n => n + 1, 0);
  useLayoutEffect(() => d.subscribe(redraw), [d]);
  const onKey = ev => {
    if (ev.isComposing) return;
    const k = keyName(ev, mod), field = ev.target.closest?.('input, textarea, select');
    if (k === 'Esc' && (d.editing || d.preview)) { ev.preventDefault(); d.editing ? d.cancelEdit() : d.discard(); return; }
    if (k === 'Mod+Z' && !field && d.note?.undo) { ev.preventDefault(); d.undo(); }
  };
  if (d.status === 'loading') return html`<div class="dd" aria-busy="true"><div class="dk-label">Details</div>
    ${[70, 45, 60, 35].map((w, i) => html`<div key=${i} class="dk-ph dd-ph" style=${`width:${w}%`}></div>`)}</div>`;
  if (d.status === 'failed') return html`<div class="dd"><div class="dk-label">Details</div><p class="dd-quiet">${describeFailure('bridge', d.error).message}<${StatusLink} />
    <button class="dk-btn text" onClick=${() => d.retry()}>Retry</button></p></div>`;
  const doc = d.doc, groups = d.groups(), wrong = doc.wrong ?? [], ignored = doc.status === 'ignored';
  return html`<div class="dd" onKeyDown=${onKey} aria-busy=${!!d.busy}>
    ${d.editing === 'head' ? html`<${HeadForm} d=${d} />` : html`<${Head} d=${d} />`}
    ${groups.length ? html`<section class="dd-sec" aria-label="Facts"><div class="dk-label">Facts</div>
      ${groups.map(g => html`<${Group} key=${g.subject} d=${d} g=${g} />`)}</section>` : null}
    ${wrong.length ? html`<details class="dd-sec dd-wrong"><summary>${wrong.length} hidden as wrong</summary><ul class="dd-facts">
      ${wrong.map(w => html`<li key=${w.id} class="dd-fact"><span class="k">${w.subject} · ${keyLabel(w.key)}</span><span class="v"><s>${w.value}</s></span>
        ${d.can ? html`<span class="dd-acts"><button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.unwrong(w)}>Put back</button></span>` : null}</li>`)}</ul></details>` : null}
    ${doc.fields?.length ? html`<section class="dd-sec" aria-label="Fields"><div class="dk-label">Fields</div><dl class="dd-list">
      ${doc.fields.map((f, i) => html`<div key=${i}><dt>${f.name}</dt><dd>${f.value}</dd></div>`)}</dl></section>` : null}
    ${doc.text ? html`<details class="dd-sec dd-text"><summary>${doc.text.length.toLocaleString('en-US')} characters read</summary><pre>${doc.text}</pre></details>` : null}
    ${d.can ? html`<${Actions} d=${d} ignored=${ignored} />` : null}
    ${d.preview ? html`<${Preview} d=${d} p=${d.preview} />` : null}
    <div class=${`dd-note${d.note?.bad ? ' bad' : ''}`} role="status" aria-live="polite">${d.note ? html`<span>${d.note.text}${d.note.bad ? html`<${StatusLink} />` : null}</span>
      ${d.note.undo ? html`<button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.undo()}>Undo</button>` : null}` : null}</div>
  </div>`;
}

function Head({d}) {
  const doc = d.doc;
  return html`<section class="dd-sec" aria-label="Document">
    <div class="dd-top"><span class="dk-label">Document</span>
      ${d.can ? html`<button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.startEdit('head')}>Edit</button>` : null}</div>
    <dl class="dd-list">${HEAD.map(k => (doc[k] || d.edited(k)) ? html`<div key=${k} class=${k === 'summary' ? 'wide' : ''}><dt>${NAMES[k]}</dt>
      <dd>${shown(k, doc[k]) || html`<span class="dd-quiet">none</span>`}${d.edited(k) ? html` <${Edited} d=${d} read=${doc.edited[k] == null ? null : shown(k, doc.edited[k]) || 'none'}
        onRevert=${() => d.revert(k)} />` : null}</dd></div>` : null)}</dl>
  </section>`;
}

/** The "edited" mark: the reading's value in its tooltip, Revert beside it (the cap). */
function Edited({d, read, onRevert}) {
  return html`<span class="dd-edited" title=${read == null ? 'Set by you' : `Set by you; read as: ${read}`}>edited</span>${d.can
    ? html`<button class="dk-btn text dd-revert" disabled=${!!d.busy} title=${read == null ? 'Back to what was read' : `Back to: ${read}`} onClick=${onRevert}>Revert</button>` : null}`;
}

function HeadForm({d}) {
  const doc = d.doc, form = useRef(null);
  useEffect(() => { form.current?.querySelector('input')?.focus(); }, []);
  const types = [...new Set([...(doc.types ?? []), doc.type].filter(Boolean))];
  const submit = ev => {
    ev.preventDefault();
    const f = new FormData(form.current);
    d.saveHead(Object.fromEntries(HEAD.map(k => [k, f.get(k) ?? ''])));
  };
  const enter = ev => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && !ev.isComposing) submit(ev); };
  return html`<form class="dd-sec dd-form" ref=${form} onSubmit=${submit} onKeyDown=${enter} aria-label="Edit the document">
    <div class="dd-top"><span class="dk-label">Document</span></div>
    <label>Title<input class="dk-field" name="title" required maxlength="300" value=${doc.title ?? ''} /></label>
    <label>Type<select class="dk-field" name="type">${types.map(t => html`<option key=${t} value=${t} selected=${t === doc.type}>${typeLabel(t)}</option>`)}</select></label>
    <label>Date<input class="dk-field" name="date" placeholder="YYYY-MM-DD" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" maxlength="10" value=${doc.date ?? ''} /></label>
    <label>Summary<textarea class="dk-field" name="summary" rows="3" maxlength="4000" value=${doc.summary ?? ''}></textarea></label>
    <div class="dd-acts"><button class="dk-btn main" type="submit" disabled=${!!d.busy}>Save</button><button class="dk-btn" type="button" onClick=${() => d.cancelEdit()}>Cancel</button></div>
  </form>`;
}

function Group({d, g}) {
  const same = d.editing?.same === g.subject;
  return html`<div class="dd-group">
    <div class="dd-top"><b class="dd-subject">${g.subject}</b>
      ${d.can && !same ? html`<button class="dk-btn text" disabled=${!!d.busy} title="This is the same thing as another name: fold it into that one"
        onClick=${() => { d.startEdit({same: g.subject}); d.findMatches(g.subject); }}>Same as…</button>` : null}</div>
    ${g.fold ? html`<div class="dd-fold">Folded in: ${g.fold.from}${d.can ? html` <button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.unfold(g.fold)}>Unfold</button>` : null}</div>` : null}
    ${same ? html`<${SameAs} d=${d} subject=${g.subject} />` : null}
    <ul class="dd-facts">${g.facts.map(f => html`<${Fact} key=${f.id ?? `${f.key}:${f.value}`} d=${d} f=${f} />`)}</ul>
  </div>`;
}

function Fact({d, f}) {
  const editing = d.editing?.fact != null && d.editing.fact === f.id, owner = f.by === 'owner';
  const input = useRef(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  if (editing) {
    const save = ev => { ev.preventDefault(); d.saveValue(f, input.current?.value); };
    return html`<li class="dd-fact editing"><form onSubmit=${save} aria-label=${`Edit ${keyLabel(f.key)}`}><span class="k">${keyLabel(f.key)}</span>
      <input class="dk-field" ref=${input} value=${f.value} maxlength="2000" aria-label=${keyLabel(f.key)}
        onKeyDown=${ev => { if (ev.key === 'Enter' && !ev.isComposing) save(ev); }} />
      <span class="dd-acts"><button class="dk-btn main" type="submit" disabled=${!!d.busy}>Save</button><button class="dk-btn" type="button" onClick=${() => d.cancelEdit()}>Cancel</button></span></form></li>`;
  }
  const link = /^https?:\/\//i.test(f.value);
  let label = f.value;
  if (link) { try { const u = new URL(f.value); label = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : decodeURI(u.pathname)); } catch { /* as given */ } }
  return html`<li class="dd-fact"><span class="k">${keyLabel(f.key)}</span>
    <span class="v" title=${f.quote ? `“${f.quote}”` : ''}>${link ? html`<a href=${f.value} target="_blank" rel="noopener" onClick=${ev => { ev.preventDefault(); d.open(f.value); }}>${label}</a>` : f.value}${f.asOf
      ? html`<span class="dd-quiet"> · as of ${dateLabel(f.asOf)}</span>` : null}${owner ? html` <${Edited} d=${d} read=${null} onRevert=${() => d.unvalue(f)} />` : null}</span>
    ${d.host.caps.clipboard || d.can ? html`<span class="dd-acts">
      ${d.host.caps.clipboard ? html`<button class="dk-btn icon dd-copy" title="Copy" aria-label=${`Copy ${keyLabel(f.key)}`} onClick=${() => d.copy(f.value)}><${Glyph} name="copy" size=${14} /></button>` : null}
      ${d.can && f.id != null ? html`
      <button class="dk-btn text" disabled=${!!d.busy} aria-label=${`Edit ${keyLabel(f.key)}`} onClick=${() => d.startEdit({fact: f.id})}>Edit</button>
      ${owner ? null : html`<button class="dk-btn text dd-bad" disabled=${!!d.busy} aria-label=${`${keyLabel(f.key)} is wrong`} title="Wrong: hide it, and keep it out of later readings"
        onClick=${() => d.wrong(f)}>Wrong</button>`}` : null}</span>` : null}</li>`;
}

/** Same as…: a box for a name (matches as you type, a pause between), the known names most like it, each a click to fold into. */
function SameAs({d, subject}) {
  const input = useRef(null), timer = useRef(null);
  useEffect(() => { input.current?.focus(); return () => clearTimeout(timer.current); }, []);
  const m = d.matches?.subject === subject ? d.matches : null;
  const typed = ev => { const q = ev.target.value; clearTimeout(timer.current); timer.current = setTimeout(() => d.findMatches(subject, q), 200); };
  return html`<div class="dd-same">
    <input class="dk-field" ref=${input} type="search" placeholder="Same as… (a name)" aria-label=${`${subject} is the same as`} onInput=${typed} />
    <ul class="dd-matches" aria-busy=${!!m?.busy}>${(m?.items ?? []).map(x => html`<li key=${x.name}><button class="dd-match" disabled=${!!d.busy}
      onClick=${() => d.fold(subject, x.name)}><b>${x.name}</b><span>${[x.kind, x.documents ? `${x.documents.toLocaleString('en-US')} doc${x.documents === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span></button></li>`)}</ul>
    ${m && !m.busy && !m.items.length ? html`<p class="dd-quiet">${m.error ? m.error.message : 'No known name like it'}${m.error ? html`<${StatusLink} /><button class="dk-btn" onClick=${() => d.findMatches(subject, m.q)}>Retry</button>` : null}</p>` : null}
    <div class="dd-acts"><button class="dk-btn" type="button" onClick=${() => d.cancelEdit()}>Cancel</button></div>
  </div>`;
}

function Actions({d, ignored}) {
  const byHand = ignored && d.doc.error === 'by hand';
  return html`<section class="dd-sec dd-bar" aria-label="Corrections">
    <button class="dk-btn" disabled=${!!d.busy || byHand} title="Read it again now (asks the model), and see what would change before saving" onClick=${() => d.reread()}>
      ${d.busy === 'reread' ? 'Reading it again…' : 'Re-read'}</button>
    ${byHand ? html`<button class="dk-btn" disabled=${!!d.busy} onClick=${() => d.restore()}>Restore</button>`
      : ignored ? null : html`<button class="dk-btn dd-bad" disabled=${!!d.busy} title="Not a document: out of search and answers (Attention, Ignored brings it back)"
        onClick=${() => d.ignore()}>Not a document</button>`}
    ${d.busy === 'reread' ? html`<div class="dk-ph dd-reading"></div>` : null}
  </section>`;
}

/** A re-read's preview: what saving would change (bridge's diff under the edit lock), then Save or Discard. */
function Preview({d, p}) {
  const q = s => `“${s || 'none'}”`;
  return html`<section class="dd-sec dd-preview" aria-label="Re-read">
    <div class="dk-label">Read again</div>
    ${p.changed ? html`<ul class="dd-diff">
      ${p.head.map(x => html`<li key=${x.field}>${NAMES[x.field]}: ${x.kept ? html`${q(shown(x.field, x.now))} stays (you set it); it reads ${q(shown(x.field, x.read))}`
        : html`${q(shown(x.field, x.now))} → ${q(shown(x.field, x.read))}`}</li>`)}
      ${p.status ? html`<li class="gone">${p.status.read === 'ignored' ? `Not a document${p.status.why ? ` (${p.status.why})` : ''}` : `Status: ${p.status.read}`}</li>` : null}
      ${p.facts.new.map((f, i) => html`<li key=${`n${i}`} class="add">+ ${f.subject} · ${keyLabel(f.key)}: ${f.value}</li>`)}
      ${p.facts.gone.map((f, i) => html`<li key=${`g${i}`} class="gone">− ${f.subject} · ${keyLabel(f.key)}: ${f.value}</li>`)}
      ${p.facts.same ? html`<li class="dd-quiet">${p.facts.same} fact${p.facts.same === 1 ? '' : 's'} as before</li>` : null}
      ${p.fields.new.length || p.fields.gone.length ? html`<li class="dd-quiet">Fields: ${p.fields.new.length} new, ${p.fields.gone.length} gone</li>` : null}
      ${p.text ? html`<li class="dd-quiet">The text read changes</li>` : null}
    </ul>` : html`<p class="dd-quiet">Reading it again changes nothing.</p>`}
    <div class="dd-acts">${p.changed ? html`<button class="dk-btn main" disabled=${!!d.busy} onClick=${() => d.save()}>Save</button>` : null}
      <button class="dk-btn" onClick=${() => d.discard()}>${p.changed ? 'Discard' : 'Close'}</button></div>
  </section>`;
}
