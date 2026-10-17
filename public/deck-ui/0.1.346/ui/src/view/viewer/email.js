import {dateTimeText} from '../../quantity.js';
// An email thread (palette SPEC.md, *Kinds*: `email`; bridge CONTRACT.md, *Pages*): each message a card (sender, its address on hover,
// the date at its right, to and cc in one muted line); earlier messages collapsed to sender · date · a snippet, the anchor expanded and
// scrolled to, later ones collapsed; a member outside bridge's grant `Not in bridge`. The body is bridge's sanitised html in a frame
// that runs nothing (DESIGN.md §2, *Security*): sandboxed without scripts, its own CSP allowing only data: images and inline styles,
// every image handed in as a data URL (inline ones at once, remote ones after Load images, both fetched through the host's resources),
// quoted history folded behind `···`, links handed to the host's url.open. allow-same-origin (never with allow-scripts) lets this
// side size the frame to its body and take its links; where the engine runs no listener in a script-less frame (WebKit), a link opens
// a new window (allow-popups), which the host sends to the browser as any. The one file that hands markup to the browser
// (test/lint.test.mjs).
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Card} from './common.js';

const html = htm.bind(h);
/** The frame's own policy: nothing loads but data: images; styles inline only. */
export const MAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
/** The frame's sandbox: popups only (a link the host could not take still opens outside); no scripts, forms or navigation. */
export const SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
// light mail colours on every theme (tokens' light: text, muted, accent, line): a mail is written for white
const LOOK = 'html,body{margin:0;padding:0;overflow:hidden;background:#fff;color:#0b1220;font:14px/1.5 "SF Pro Text","Segoe UI Variable Text","Segoe UI",Roboto,system-ui,sans-serif;overflow-wrap:anywhere}'
  + 'body{padding:12px 16px 14px}a{color:#2563eb}img{max-width:100%;height:auto}img:not([src]){display:none}table{max-width:100%}pre{white-space:pre-wrap}'
  + 'p:first-child{margin-top:0}p:last-child{margin-bottom:0}'
  + 'blockquote{margin:0 0 0 4px;padding-left:10px;border-left:2px solid #d3dae4;color:#566173}';
const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unescapeAttr = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The frame's document for one message: bridge's html with each image's data URL set (`image(path)` → URL or null; remote ones only
 *  when `remote`), quoted history hidden unless `quoted`. */
export function mailDocument(body, {image = () => null, remote = false, quoted = false} = {}) {
  const set = (all, path, allowed) => { const url = allowed ? image(unescapeAttr(path)) : null; return url && /^data:image\/(jpeg|png|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(url) ? `src="${escapeAttr(url)}" ${all}` : all; };
  const doc = String(body ?? '')
    .replace(/data-inline-src="([^"]*)"/g, (all, p) => set(all, p, true))
    .replace(/data-remote-src="([^"]*)"/g, (all, p) => set(all, p, remote));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank">`
    + `<style>${LOOK}${quoted ? '' : '[data-quote]{display:none}'}</style></head><body>${doc}</body></html>`;
}

/** "Sam Rivera <sam@example.com>" → {name, address}. */
export function person(s) {
  const t = String(s ?? '').trim(), m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(t);
  return m ? {name: m[1].trim() || m[2], address: m[2]} : {name: t, address: ''};
}
const people = s => String(s ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => person(x).name).filter(Boolean).join(', ');
const when = d => { const t = new Date(d); return Number.isNaN(t.getTime()) ? '' : dateTimeText(t, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}); };
const snippet = m => String(m.text ?? '').split('\n').filter(l => l.trim() && !l.startsWith('>')).join(' ').slice(0, 160);

export function Email({v, e, pane}) {
  const a = e.answer, ms = a.messages ?? [];
  const anchor = a.anchor ?? ms.filter(m => !m.hidden).at(-1)?.id;
  const [open, setOpen] = useState(() => new Set(e.view.open ?? [anchor]));
  const [quotes, setQuotes] = useState(() => new Set());
  const scroller = useRef(null);
  useEffect(() => { e.view.open = [...open]; }, [open]);
  useEffect(() => {
    const el = scroller.current;
    if (e.view.scrollTop != null) el.scrollTop = e.view.scrollTop;
    else el.querySelector(`[data-mail="${CSS.escape(String(anchor))}"]`)?.scrollIntoView({block: 'start'});
  }, []);
  pane.kind.current = {
    key(k) {
      const el = scroller.current;
      if (k === 'Down' || k === 'Up') { el.scrollTop += k === 'Down' ? 60 : -60; return true; }
      if (k === 'PageDown' || k === 'PageUp') { el.scrollTop += (k === 'PageDown' ? 1 : -1) * el.clientHeight * 0.9; return true; }
      return false;
    },
  };
  const toggle = (set, setter, id) => setter(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return html`
    <div class="dv-scroll dv-mailscroll" ref=${scroller} onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
      <div class="dv-mail">
        ${a.images === 'blocked' && !e.remote ? html`<div class="dv-imgbar" role="status"><span>Images hidden</span><button class="dk-btn text" onClick=${() => v.loadImages()}>Load images</button></div>` : null}
        ${ms.map(m => m.hidden ? html`<div class="dv-letter hidden" key=${m.id}><span>Not in bridge</span></div>`
          : html`<${Letter} key=${m.id} m=${m} v=${v} e=${e} open=${open.has(m.id)} quoted=${quotes.has(m.id)}
              onToggle=${() => toggle(open, setOpen, m.id)} onQuote=${() => toggle(quotes, setQuotes, m.id)} />`)}
      </div>
    </div>`;
}

function Letter({m, v, e, open, quoted, onToggle, onQuote}) {
  const from = person(m.from);
  return html`<article class=${`dv-letter${open ? ' open' : ''}`} data-mail=${m.id}>
    <button class="dv-lhead" aria-expanded=${open} onClick=${onToggle}>
      <span class="who" title=${from.address}><b>${from.name || 'Unknown sender'}</b>${from.address ? html`<span class="addr">${from.address}</span>` : null}</span>
      <time datetime=${m.date}>${when(m.date)}</time>
      ${open ? null : html`<span class="snip">${snippet(m)}</span>`}
    </button>
    ${open ? html`
      <div class="dv-to">${[m.to ? `to ${people(m.to)}` : '', m.cc ? `cc ${people(m.cc)}` : ''].filter(Boolean).join(' · ')}</div>
      ${m.html != null ? html`<${Body} v=${v} e=${e} m=${m} quoted=${quoted} />` : html`<pre class="dv-plain">${String(m.text ?? '').split('\n').filter(l => quoted || !l.startsWith('>')).join('\n').trim()}</pre>`}
      ${m.quoted ? html`<button class="dk-btn text dv-quote" onClick=${onQuote}>${quoted ? 'Hide quoted text' : '···  Show quoted text'}</button>` : null}
      ${m.attachments?.length ? html`<div class="dv-cards">${m.attachments.map(y => html`<${Card} key=${y.n} a=${y} source=${e.source} onOpen=${y => v.openAttachment(y, m.id)} />`)}</div>` : null}` : null}
  </article>`;
}

/** The sandboxed frame: sized to its body, its links to the host. */
function Body({v, e, m, quoted}) {
  const frame = useRef(null);
  const doc = mailDocument(m.html, {image: p => v.image(p), remote: !!e.remote, quoted});
  useEffect(() => {
    const f = frame.current;
    let ro = null;
    // its whole body, never a scrollbar of its own: the tallest of the document's and the body's measures, again as images load
    const fit = () => {
      try {
        const d = f.contentDocument, el = d?.documentElement;
        if (!el || !d.body) return;
        f.style.height = `${Math.ceil(Math.max(el.scrollHeight, d.body.scrollHeight, el.getBoundingClientRect().height, d.body.getBoundingClientRect().bottom)) + 1}px`;
      } catch { /* not ours yet */ }
    };
    const click = ev => {
      const link = ev.target.closest?.('a[href]');
      if (!link) return;
      ev.preventDefault();
      v.openUrl(link.getAttribute('href'));
    };
    const loaded = () => {
      fit();
      const d = f.contentDocument;
      if (!d) return;
      d.addEventListener('click', click);
      d.addEventListener('load', fit, true);
      ro?.disconnect();
      if (typeof ResizeObserver === 'function' && d.body) { ro = new ResizeObserver(() => requestAnimationFrame(fit)); ro.observe(d.body); }
    };
    f.addEventListener('load', loaded);
    loaded();
    return () => { f.removeEventListener('load', loaded); ro?.disconnect(); };
  }, []);
  return html`<iframe class="dv-frame" ref=${frame} title="Message" sandbox=${SANDBOX} srcdoc=${doc} referrerpolicy="no-referrer" scrolling="no"></iframe>`;
}
