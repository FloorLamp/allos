import {dateText, timeText} from '../../quantity.js';
import {Failure} from '../failure.js';
// A conversation (palette SPEC.md, *Kinds*: `conversation`; bridge CONTRACT.md, *Pages*): texts as bubbles at the reading width, mine
// at the right in accent, theirs at the left with the sender's name over the first of a run in a group chat; runs of one sender within
// 5 minutes close up; a day separator where the local day changes; the time on hover; a reply's quote in a thin bar above; reactions
// as a pill on the corner; a one-time code hidden; photos inline (a click opens one in the viewer), other attachments as cards. Opens
// on the anchor, outlined for 2 s; scrolling near either end pages by bridge's cursors, the scroll kept; the header's find (N /
// Shift+N; Enter past the loaded messages asks bridge to anchor on an older hit); Mod+G a date.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Card, marked, wordsOf} from './common.js';
import {basePath, dayOf} from '../../viewer.js';

const html = htm.bind(h);
const RUN_MS = 5 * 60 * 1000, EDGE_PX = 240;
const dayLabel = at => dateText(at, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'});
const timeLabel = at => timeText(at, {hour: 'numeric', minute: '2-digit'});
const photo = x => x.kind === 'pages' && (x.of === 'image' || /^image\//.test(x.type ?? '')) && !x.unavailable;

/** The messages as the view lays them out: day separators where the local day changes, each message's place in its run. */
export function layout(messages, group) {
  const out = [];
  let prev = null;
  for (const m of messages) {
    const day = m.at ? dayOf(m.at) : prev?.day ?? '';
    if (day && day !== prev?.day) out.push({sep: day, at: m.at});
    const t = Date.parse(m.at ?? ''), joined = prev && prev.day === day && prev.from === m.from && prev.me === !!m.me && t - prev.t <= RUN_MS;
    out.push({m, first: !joined, name: group && !m.me && !joined ? m.from : null});
    prev = {day, from: m.from, me: !!m.me, t};
  }
  return out;
}
/** Messages holding every word of a find. */
export const hitsOf = (messages, words) => !words.length ? [] : messages.filter(m => !m.hidden && words.every(w => String(m.text ?? '').toLowerCase().includes(w))).map(m => m.id);

export function Conversation({v, e, pane, find}) {
  const a = e.answer, ms = a.messages ?? [], group = (a.participants?.length ?? 0) > 2;
  const scroller = useRef(null), last = useRef(null);
  const [flash, setFlash] = useState(null);
  const words = wordsOf(find?.q ?? '');
  const hits = hitsOf(ms, words);
  // where the find is among its hits, for the find's text (a new text starts at its first hit at once)
  const [hit, setHit] = useState({q: null, at: -1});
  const hitAt = hit.q === (find?.q ?? '') ? hit.at : hits.length ? 0 : -1;
  const setHitAt = at => setHit({q: find?.q ?? '', at});
  const hitSet = new Set(hits);

  const toMsg = (id, block = 'center') => {
    const el = scroller.current?.querySelector(`[data-m="${CSS.escape(String(id))}"]`);
    if (!el) return;
    el.scrollIntoView({block});
    setFlash(id);
  };
  const step = d => { if (!hits.length) return; const i = Math.max(0, Math.min(hits.length - 1, hitAt + d)); setHitAt(i); toMsg(hits[i]); };
  // the anchor in the middle on open (or where it was, back from history), and again when a find re-anchors it
  useLayoutEffect(() => {
    if (e.view.scrollTop != null && !last.current) scroller.current.scrollTop = e.view.scrollTop;
    else if (a.anchor) toMsg(a.anchor);
  }, [a.anchor]);
  useEffect(() => { if (flash == null) return; const t = setTimeout(() => setFlash(null), 2000); return () => clearTimeout(t); }, [flash]);
  useEffect(() => { if (hits.length) toMsg(hits[0]); }, [find?.q]);
  useEffect(() => { pane.setInfo({matches: hits.length, matchAt: hitAt}); });
  // older messages (or their placeholders) arriving above keep what is in view where it is
  const topKey = `${e.paging.before ? 1 : 0}:${ms[0]?.id}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (last.current && last.current.key !== topKey) el.scrollTop += el.scrollHeight - last.current.height;
    last.current = {key: topKey, height: el.scrollHeight};
  });
  const onScroll = ev => {
    const el = ev.currentTarget;
    e.view.scrollTop = el.scrollTop;
    if (last.current) last.current.height = el.scrollHeight;
    if (el.scrollTop < EDGE_PX && a.before && !e.paging.before) v.moreMessages(true);
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX && a.after && !e.paging.after) v.moreMessages(false);
  };
  pane.kind.current = {
    step,
    async findEnter(d) {
      if (hits.length) return step(d);
      const id = await v.anchorOn(find?.q ?? '');
      if (id) toMsg(id);
    },
    async jump(day) { const id = await v.jumpTo(day); if (id) toMsg(id, 'start'); },
    key(k) {
      const el = scroller.current;
      if (k === 'Down' || k === 'Up') { el.scrollTop += k === 'Down' ? 60 : -60; return true; }
      if (k === 'PageDown' || k === 'PageUp') { el.scrollTop += (k === 'PageDown' ? 1 : -1) * el.clientHeight * 0.9; return true; }
      if (k === 'Home' || k === 'End') { el.scrollTop = k === 'Home' ? 0 : el.scrollHeight; return true; }
      return false;
    },
  };

  const holder = side => html`<div class=${`dv-msg ${side} ph`} aria-hidden="true"><div class="dk-ph dv-bubble" style="width:46%;height:34px"></div></div>`;
  return html`
    <div class="dv-scroll dv-chatscroll" ref=${scroller} onScroll=${onScroll}>
      <div class="dv-chat" role="log" aria-label="Messages">
        ${e.pagingError ? html`<${Failure} backend="bridge" error=${e.pagingError} retry=${() => v.moreMessages(e.pagingError.older)} host=${v.host} />` : null}
        ${e.paging.before ? [holder('theirs'), holder('mine')] : null}
        ${!a.before && ms.length ? html`<div class="dv-day start">Start of the conversation</div>` : null}
        ${layout(ms, group).map(x => x.sep ? html`<div class="dv-day" key=${`d${x.sep}`}>${dayLabel(x.at)}</div>` : html`<${Bubble} key=${x.m.id} x=${x} v=${v} e=${e}
          words=${words} hit=${hitSet.has(x.m.id)} at=${hits[hitAt] === x.m.id} flash=${flash === x.m.id} />`)}
        ${e.paging.after ? [holder('theirs')] : null}
      </div>
    </div>`;
}

function Bubble({x, v, e, words, hit, at, flash}) {
  const {m} = x, side = m.me ? 'mine' : 'theirs';
  const photos = (m.attachments ?? []).filter(photo), others = (m.attachments ?? []).filter(y => !photo(y));
  const r = m.replyTo;
  const quote = r ? `${r.from ? `${r.from}: ` : ''}${r.hidden === 'code' ? 'Verification code hidden' : r.text || r.media || ''}` : null;
  const cls = ['dv-msg', side, x.first ? 'first' : 'joined', hit ? 'hit' : '', at ? 'at' : '', flash ? 'flash' : ''].filter(Boolean).join(' ');
  const src = y => v.host.resource(`${basePath({...e, message: m.id, attachments: [y.n]})}/page/1?w=800`);
  return html`<div class=${cls} data-m=${m.id}>
    ${x.name ? html`<div class="dv-from">${x.name}</div>` : null}
    <div class="dv-line">
      <div class="dv-stack">
        ${quote ? html`<div class="dv-reply" title=${quote}>${quote}</div>` : null}
        ${m.hidden === 'code' ? html`<div class="dv-bubble code">Verification code hidden</div>` : null}
        ${photos.map(y => html`<button class="dv-photo" key=${y.n} title=${`Show ${y.name ?? 'the photo'}`} onClick=${() => v.openAttachment(y, m.id)}>
          <img src=${src(y)} alt=${y.name ?? 'Photo'} loading="lazy" draggable="false" /></button>`)}
        ${m.text ? html`<div class="dv-bubble">${marked(m.text, words)}${m.reactions?.length ? html`<span class="dv-react" title=${m.reactions.map(z => `${z.emoji} ${[].concat(z.from ?? []).join(', ')}`).join(' · ')}>${m.reactions.map(z => z.emoji).join('')}</span>` : null}</div>` : null}
        ${!m.text && m.reactions?.length ? html`<span class="dv-react alone">${m.reactions.map(z => z.emoji).join('')}</span>` : null}
        ${others.map(y => y.unavailable
          ? html`<div class="dv-gone" key=${y.n}>${/^image\//.test(y.type ?? '') || y.of === 'image' ? 'Photo' : y.name ?? 'Attachment'} ${y.unavailable === 'signal' ? 'in Signal' : 'no longer available at Google'}</div>`
          : html`<${Card} key=${y.n} a=${y} source=${e.source} onOpen=${y => v.openAttachment(y, m.id)} />`)}
      </div>
      ${m.at ? html`<time class="dv-time" datetime=${m.at}>${timeLabel(m.at)}</time>` : null}
    </div>
  </div>`;
}
