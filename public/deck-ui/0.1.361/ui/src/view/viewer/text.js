// Text (palette SPEC.md, *Kinds*: `text`): the text wrapped at the reading width, selectable, the query's words marked (the first
// scrolled to); a mail's leading headers as a small muted block and its hard-wrapped lines joined into paragraphs (a short line keeps
// its break: an address, a signature); then ATTACHMENTS as cards that open in the viewer.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Card, marked, wordsOf} from './common.js';

const html = htm.bind(h);

/** {head: [header lines], paras: [text]}: leading `Name: value` lines apart; a line of 60 or more characters joins the next. */
export function prose(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let i = 0;
  const head = [];
  while (i < lines.length && /^[A-Z][\w-]*: /.test(lines[i])) head.push(lines[i++]);
  while (i < lines.length && !lines[i].trim()) i++;
  const paras = lines.slice(i).join('\n').split(/\n{2,}/)
    .map(p => p.split('\n').reduce((out, l, j, all) => out + l + (j === all.length - 1 ? '' : l.length >= 60 ? ' ' : '\n'), ''))
    .filter(p => p.trim());
  return {head, paras};
}

export function Text({v, e, pane}) {
  const a = e.answer, words = wordsOf(e.query), body = useRef(null);
  const {head, paras} = prose(a.text);
  const depth = e.attachments.length;
  pane.kind.current = {copyText: () => a.text};
  useEffect(() => {
    const el = body.current;
    if (e.view.scrollTop != null) el.scrollTop = e.view.scrollTop;
    else el.querySelector('mark')?.scrollIntoView({block: 'center'});
  }, []);
  return html`
    <div class="dv-scroll dv-textscroll" ref=${body} onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
      <article class="dv-text">
        ${head.length ? html`<div class="dv-mailhead">${head.map((l, i) => html`<div key=${i}>${marked(l, words)}</div>`)}</div>` : null}
        ${paras.map((p, i) => html`<p key=${i}>${marked(p, words)}</p>`)}
      </article>
      ${a.attachments?.length ? html`<section class="dv-atts"><div class="dk-label">Attachments</div>
        <div class="dv-cards">${a.attachments.map(x => html`<${Card} key=${x.n} a=${x} depth=${depth} source=${e.source} onOpen=${x => v.openAttachment(x)} />`)}</div></section>` : null}
    </div>`;
}
