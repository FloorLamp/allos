import {Failure, StatusLink} from '../page-state.js';
// The document pane (palette SPEC.md, *Details*; details.js its state): what bridge read from the document (the head: title, type,
// date, summary; the facts by subject with their quotes; the fields; the text read) and, with the `corrections` cap, the owner's
// corrections: Edit and Revert the head, a fact's Edit value, Wrong and Revert, Same as… a subject (its matches as you type), Unfold,
// Not a document or Restore, Re-read with its preview (Save, Discard), and Undo on the status line for a few seconds after a write.
// Keys stay here (Esc closes what is open; Mod+Z undoes); the viewer's own keys never act on a key typed in it.
import {h} from '../../../vendor/preact.mjs';
import {useLayoutEffect, useReducer, useRef, useEffect} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {HEAD} from '../../details.js';
import {dateText, fieldLabel, isoDay, plural} from '../../format.js';
import {factValue} from '../../readable-facts.js';
import {keyName} from '../keys.js';
import {Glyph} from '../../glyphs.js';
import {shortName, shows} from '../../record.js';

const html = htm.bind(h);
const NAMES = {title: 'Title', type: 'Type', date: 'Date', summary: 'Summary'};
const shown = (k, v) => k === 'type' ? fieldLabel(v) : k === 'date' ? dateText(v) : v;

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
  if (d.status === 'failed') return html`<div class="dd"><div class="dk-label">Details</div><${Failure} error=${d.error} retry=${() => d.retry()} /></div>`;
  const doc = d.doc, wrong = doc.wrong ?? [], ignored = doc.status === 'ignored', rec = d.record;
  // beside a record (record.js) only what it does not show; what it shows stays correctable behind a fold
  const all = d.groups(), keep = g => ({...g, facts: g.facts.filter(f => !shows(rec, f))}), groups = all.map(keep).filter(g => g.facts.length);
  const shown = rec ? all.map(g => ({...g, facts: g.facts.filter(f => shows(rec, f))})).filter(g => g.facts.length) : [];
  // a field a fact already says (`Invoice 1042` beside the fact `Invoice number 1042`) shows once, as the correctable fact
  const said = new Set(all.flatMap(g => g.facts.map(f => String(f.value).trim())));
  const fields = (doc.fields ?? []).filter(f => !rec?.usedFields.has(f.name) && !said.has(String(f.value).trim()));
  return html`<div class="dd" onKeyDown=${onKey} aria-busy=${!!d.busy}>
    ${d.editing === 'head' ? html`<${HeadForm} d=${d} />` : html`<${Head} d=${d} keys=${rec ? ['title', 'summary'] : HEAD} title=${rec?.title} />`}
    ${groups.length ? html`<section class="dd-sec" aria-label="Facts"><div class="dk-label">${rec ? 'Other facts' : 'Facts'}</div>
      ${groups.map(g => html`<${Group} key=${g.subject} d=${d} g=${g} />`)}</section>` : null}
    ${shown.length ? html`<details class="dd-sec dd-inrecord" open=${!!d.editing?.fact && shown.some(g => g.facts.some(f => f.id === d.editing.fact))}><${Summary}>${plural(shown.reduce((n, g) => n + g.facts.length, 0), 'fact')} shown in the record<//>
      ${shown.map(g => html`<${Group} key=${g.subject} d=${d} g=${g} />`)}</details>` : null}
    ${wrong.length ? html`<details class="dd-sec dd-wrong"><${Summary}>${wrong.length} hidden as wrong<//><ul class="dd-facts">
      ${wrong.map(w => html`<li key=${w.id} class="dd-fact"><div class="dd-fhead"><span class="k">${w.subject} · ${fieldLabel(w.key)}</span>
        ${d.can ? html`<span class="dd-acts"><button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.unwrong(w)}>Put back</button></span>` : null}</div>
        <span class="v"><s>${factValue(w.value)}</s></span></li>`)}</ul></details>` : null}
    ${fields.length ? html`<section class="dd-sec" aria-label="Fields"><div class="dk-label">Fields</div><dl class="dd-list">
      ${fields.map((f, i) => html`<div key=${i}><dt>${f.name}</dt><dd>${f.value}</dd></div>`)}</dl></section>` : null}
    ${doc.text ? html`<details class="dd-sec dd-text"><${Summary}>${plural(doc.text.length, 'character')} read<//><pre>${doc.text}</pre></details>` : null}
    ${d.can ? html`<${Actions} d=${d} ignored=${ignored} />` : null}
    ${d.preview ? html`<${Preview} d=${d} p=${d.preview} />` : null}
    <div class=${`dd-note${d.note?.bad ? ' bad' : ''}`} role="status" aria-live="polite">${d.note ? html`<span>${d.note.text}${d.note.bad ? html`<${StatusLink} />` : null}</span>
      ${d.note.undo ? html`<button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.undo()}>Undo</button>` : null}` : null}</div>
  </div>`;
}

/** A disclosure's summary: a chevron that turns as it opens, not the browser's triangle. */
const Summary = ({children}) => html`<summary class="dd-summary"><${Glyph} name="next" size=${14} />${children}</summary>`;


/** `title`: the title shown for it (a record's short one), the stored one on hover. */
function Head({d, keys = HEAD, title = null}) {
  const doc = d.doc;
  return html`<section class="dd-sec" aria-label="Document">
    <div class="dd-top"><span class="dk-label">Document</span>
      ${d.can ? html`<button class="dk-btn text" disabled=${!!d.busy} onClick=${() => d.startEdit('head')}>Edit</button>` : null}</div>
    <dl class="dd-list">${keys.map(k => (doc[k] || d.edited(k)) ? html`<div key=${k} class=${k === 'summary' ? 'wide' : ''}><dt>${NAMES[k]}</dt>
      <dd title=${k === 'title' && title && title !== doc.title ? doc.title : null}>${(k === 'title' && title) || shown(k, doc[k]) || html`<span class="dd-quiet">none</span>`}${d.edited(k) ? html` <${Edited} d=${d} read=${doc.edited[k] == null ? null : shown(k, doc.edited[k]) || 'none'}
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
    <label>Type<select class="dk-field" name="type">${types.map(t => html`<option key=${t} value=${t} selected=${t === doc.type}>${fieldLabel(t)}</option>`)}</select></label>
    ${/^\d{4}(-\d{2})?$/.test(doc.date ?? '')
      // a year or a month stays one (a day picker would make it a day)
      ? html`<label>Date<input class="dk-field" name="date" placeholder="2025 or 2025-06" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" maxlength="10" value=${doc.date} /></label>`
      : html`<label>Date<input class="dk-field" name="date" type="date" value=${isoDay(doc.date)} /></label>`}
    <label>Summary<textarea class="dk-field" name="summary" rows="3" maxlength="4000" value=${doc.summary ?? ''}></textarea></label>
    <div class="dd-acts"><button class="dk-btn main" type="submit" disabled=${!!d.busy}>Save</button><button class="dk-btn" type="button" onClick=${() => d.cancelEdit()}>Cancel</button></div>
  </form>`;
}

function Group({d, g}) {
  const same = d.editing?.same === g.subject;
  return html`<div class="dd-group">
    <div class="dd-top"><b class="dd-subject" title=${g.subject}>${shortName(g.subject)}</b>
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
    return html`<li class="dd-fact editing"><form onSubmit=${save} aria-label=${`Edit ${fieldLabel(f.key)}`}><span class="k">${fieldLabel(f.key)}</span>
      <input class="dk-field" ref=${input} value=${f.value} maxlength="2000" aria-label=${fieldLabel(f.key)}
        onKeyDown=${ev => { if (ev.key === 'Enter' && !ev.isComposing) save(ev); }} />
      <span class="dd-acts"><button class="dk-btn main" type="submit" disabled=${!!d.busy}>Save</button><button class="dk-btn" type="button" onClick=${() => d.cancelEdit()}>Cancel</button></span></form></li>`;
  }
  const link = /^https?:\/\//i.test(f.value);
  let label = f.value;
  if (link) { try { const u = new URL(f.value); label = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : decodeURI(u.pathname)); } catch { /* as given */ } }
  // the key and its controls on one line, the value the pane's whole width under them: a narrow pane never breaks a number
  return html`<li class="dd-fact"><div class="dd-fhead"><span class="k">${fieldLabel(f.key)}</span>
    ${d.host.caps.clipboard || d.can ? html`<span class="dd-acts">
      ${d.host.caps.clipboard ? html`<button class="dk-btn icon text dd-copy" title="Copy" aria-label=${`Copy ${fieldLabel(f.key)}`} onClick=${() => d.copy(f.value)}><${Glyph} name="copy" size=${14} /></button>` : null}
      ${d.can && f.id != null ? html`
      <button class="dk-btn text" disabled=${!!d.busy} aria-label=${`Edit ${fieldLabel(f.key)}`} onClick=${() => d.startEdit({fact: f.id})}>Edit</button>
      ${owner ? null : html`<button class="dk-btn text dd-bad" disabled=${!!d.busy} aria-label=${`${fieldLabel(f.key)} is wrong`} title="Wrong: hide it, and keep it out of later readings"
        onClick=${() => d.wrong(f)}>Wrong</button>`}` : null}</span>` : null}</div>
    <span class="v" title=${f.quote ? `“${f.quote}”` : ''}>${link ? html`<a href=${f.value} target="_blank" rel="noopener" onClick=${ev => { ev.preventDefault(); d.open(f.value); }}>${label}</a>` : factValue(f.value)}${f.asOf && f.asOf !== d.doc?.date
      ? html`<span class="dd-quiet"> · as of ${dateText(f.asOf)}</span>` : null}${owner ? html` <${Edited} d=${d} read=${null} onRevert=${() => d.unvalue(f)} />` : null}</span></li>`;
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
      onClick=${() => d.fold(subject, x.name)}><span class="dd-mname"><b>${x.name}</b><span>${[x.kind, x.documents ? plural(x.documents, 'doc') : null].filter(Boolean).join(' · ')}</span></span>
      <${Glyph} name="next" size=${16} /></button></li>`)}</ul>
    ${m && !m.busy && !m.items.length ? m.error ? html`<${Failure} error=${m.error} retry=${() => d.findMatches(subject, m.q)} />` : html`<p class="dd-quiet">No known name like it</p>` : null}
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
      ${p.facts.new.map((f, i) => html`<li key=${`n${i}`} class="add">+ ${f.subject} · ${fieldLabel(f.key)}: ${factValue(f.value)}</li>`)}
      ${p.facts.gone.map((f, i) => html`<li key=${`g${i}`} class="gone">− ${f.subject} · ${fieldLabel(f.key)}: ${factValue(f.value)}</li>`)}
      ${p.facts.same ? html`<li class="dd-quiet">${plural(p.facts.same, 'fact')} as before</li>` : null}
      ${p.fields.new.length || p.fields.gone.length ? html`<li class="dd-quiet">Fields: ${p.fields.new.length} new, ${p.fields.gone.length} gone</li>` : null}
      ${p.text ? html`<li class="dd-quiet">The text read changes</li>` : null}
    </ul>` : html`<p class="dd-quiet">Reading it again changes nothing.</p>`}
    <div class="dd-acts">${p.changed ? html`<button class="dk-btn main" disabled=${!!d.busy} onClick=${() => d.save()}>Save</button>` : null}
      <button class="dk-btn" onClick=${() => d.discard()}>${p.changed ? 'Discard' : 'Close'}</button></div>
  </section>`;
}
