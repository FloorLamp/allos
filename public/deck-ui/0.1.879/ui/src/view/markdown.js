// Markdown is lexed by Marked, then rendered as explicit Preact nodes. Source HTML and images never become active markup.
import {h} from '../../vendor/preact.mjs';
import {useMemo} from '../../vendor/hooks.mjs';
import {Lexer} from '../../vendor/marked.mjs';
import {decodeHTMLStrict} from '../../vendor/entities-decode.mjs';
import {openable} from '../host/host.js';
import {EntityLink} from './entity-link.js';

const ITEM = /^FP-([1-9]\d*)$/i;
/** An `FP-<n>` in text as a link to the item (entity-link.js; any page that shows text naming items): `onItem(n)` opens it in the
 *  page's own drawer (Flightplan, Todo), `itemHref(n)` its address there; without them the item's page (`/todo/FP-<n>`). Anything
 *  else is the text. */
export function itemRef(reference, {onItem, itemHref} = {}) {
  const m = ITEM.exec(reference), n = m ? Number(m[1]) : null;
  if (!Number.isSafeInteger(n)) return null;
  if (onItem) return h('a', {href: itemHref?.(n) ?? `/flightplan/FP-${n}`, class: 'dk-entity', onClick: ev => { ev.preventDefault(); onItem(n); }}, reference);
  return h(EntityLink, {kind: 'item', id: n, label: reference});
}
/** Plain text with each `FP-<n>` in it a link (itemRef): a title, a history line. */
export function itemRefs(text, opts) {
  const parts = String(text ?? '').split(/((?<![\w/#-])FP-\d+\b)/gi);
  return parts.length === 1 ? parts[0] : parts.map(part => itemRef(part, opts) ?? part);
}

/** Text and fixed elements only; the lexer supplies content, never element names or attributes. `onItem`/`itemHref`: itemRef's. */
export function markdownNodes(text, {host, repo, onItem, itemHref} = {}) {
  const link = (href, children, title) => {
    const url = openable(decodeHTMLStrict(href));
    if (!url) return children;
    const activate = ev => { ev.preventDefault(); host.call('url.open', {url}).catch(() => {}); };
    return h('a', {href: url, title, onClick: activate, onAuxClick: ev => { if (ev.button === 1) activate(ev); }}, children);
  };
  const plain = (text, files) => {
    const decoded = decodeHTMLStrict(text);
    if (!files) return decoded;
    const items = part => {
      return part.split(/((?<![\w/#-])(?:FP-\d+|(?:[\w.-]+\/)?[\w.-]+#\d+)\b)/gi).map(reference => {
        const item = itemRef(reference, {onItem, itemHref});
        if (item) return item;
        const gh = /^((?:[\w.-]+\/)?[\w.-]+)#([1-9]\d*)$/.exec(reference);
        if (!gh) return reference;
        const target = gh[1].includes('/') ? gh[1] : repo ? `${repo.split('/')[0]}/${gh[1]}` : null;
        return target ? link(`https://github.com/${target}/issues/${gh[2]}`, reference) : reference;
      });
    };
    if (!repo) return items(decoded);
    return decoded.split(/((?:[\w.-]+\/)*[\w.-]+\.[\w]+:\d+)/g).map(part => {
      const match = /^((?:[\w.-]+\/)*[\w.-]+\.[\w]+):(\d+)$/.exec(part);
      return match ? link(`https://github.com/${repo}/blob/main/${match[1]}#L${match[2]}`, part) : items(part);
    });
  };
  const render = (tokens, files = true) => tokens.map(token => {
    const children = () => render(token.tokens ?? [], files);
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'heading': return h(`h${Math.min(6, token.depth + 2)}`, null, children());
      case 'paragraph': return h('p', null, children());
      case 'text': return token.tokens ? children() : plain(token.text, files);
      case 'escape': return decodeHTMLStrict(token.text);
      case 'html': return h(token.block ? 'p' : 'span', {class: 'dk-md-raw'}, token.text);
      case 'strong': return h('strong', null, children());
      case 'em': return h('em', null, children());
      case 'del': return h('del', null, children());
      case 'codespan': return h('code', null, token.text);
      case 'code': return h('pre', {tabIndex: 0, 'aria-label': 'Code block'}, h('code', null, token.text));
      case 'br': return h('br');
      case 'hr': return h('hr');
      case 'blockquote': return h('blockquote', null, children());
      case 'link': return link(token.href, render(token.tokens, false), token.title ? decodeHTMLStrict(token.title) : null);
      case 'image': return files ? link(token.href, decodeHTMLStrict(token.text) || 'Image') : decodeHTMLStrict(token.text);
      case 'list': return h(token.ordered ? 'ol' : 'ul', {start: token.ordered ? token.start : undefined}, render(token.items, files));
      case 'list_item': return h('li', {class: token.task ? 'dk-md-task' : null}, children());
      case 'checkbox': return h('input', {type: 'checkbox', checked: token.checked, disabled: true, 'aria-label': token.checked ? 'Completed' : 'Not completed'});
      case 'table': {
        const cell = (c, header) => h(header ? 'th' : 'td', {scope: header ? 'col' : null, style: c.align ? {textAlign: c.align} : null}, render(c.tokens, files));
        return h('div', {class: 'dk-md-table', role: 'region', 'aria-label': 'Notes table', tabIndex: 0}, h('table', null,
          h('thead', null, h('tr', null, token.header.map(c => cell(c, true)))),
          h('tbody', null, token.rows.map(row => h('tr', null, row.map(c => cell(c, false)))))));
      }
      default: return token.raw ?? '';
    }
  });
  return render(Lexer.lex(text, {gfm: true, breaks: true}));
}

export function Markdown({text, host, repo, onItem, itemHref}) {
  return useMemo(() => markdownNodes(text, {host, repo, onItem, itemHref}), [text, host, repo, onItem, itemHref]);
}
