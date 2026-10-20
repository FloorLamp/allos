import {PeopleDuplicates, DuplicatesToggle} from './people-duplicates.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {docGlyph} from '../../../palette/model.mjs';
import {cardFacts, cardItems, normalizePersonProfile, personProfile} from '../people.js';
import {Glyph} from '../glyphs.js';
import {lines} from './rows.js';
import {dateText, eventTitle, initials, joinText, personLine, sentence} from '../format.js';
import {openable} from '../host/host.js';
import {Drawer, Facts, SectionHead} from './drawer.js';
import {DetailList} from './detail-list.js';
import {Failure, PageState, Skeleton} from './page-state.js';
import {openMap} from './map.js';
const html = htm.bind(h);
export const PersonAvatar = ({name}) => html`<span class="person-avatar" aria-hidden="true">${initials(name)}</span>`;

export function Portrait({host, path, name}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    if (path) Promise.resolve().then(() => host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [host, path]);
  return src ? html`<img class="person-portrait" src=${src} alt=${`Photo of ${name}`} width="80" height="80" decoding="async" onError=${() => setSrc(null)} />` : html`<${PersonAvatar} name=${name} />`;
}

/** Shared content for standalone profile, palette Details and an already-loaded person viewer: the shared detail lists
 *  (DetailList), each paging locally over indexed membership; returning from a document restores the same page and scroll. */
/** `named`: the drawer's header already names the person and their relation; the hero then shows the portrait, contact and actions. */
export function PersonProfileContent({host, profile, onOpen, onCopy, onCluster, onMap, view, named = false}) {
  const [actionError, setActionError] = useState(null), [duplicates, showDuplicates] = useState(false);
  const person = profile.person, name = person.name ?? 'Person';
  const openLink = url => { if (openable(url)) host.call('url.open', {url}).catch(setActionError); };
  const copy = value => Promise.resolve(onCopy ? onCopy(value) : host.call('clipboard.copy', {text: value})).catch(setActionError);
  const communications = profile.communications, communicationIds = new Set(communications.map(c => String(c.document.id)));
  const papers = profile.documents.filter(d => !communicationIds.has(String(d.id)));
  const links = profile.links.filter(link => link.url !== profile.photoLink?.url);
  const lastContact = person.lastContact ?? profile.latestCommunication?.date ?? null;
  const docRows = items => items.map(item => {
    const document = item.document ?? item;
    return {id: String(document.id), title: item.title || document.title || 'Untitled document', date: item.date ?? document.date ?? null, glyph: item.kind === 'email' ? 'mail' : item.kind === 'text' ? 'chat' : 'document', doc: document,
      sub: item.date ?? document.date ? null : 'Date not recorded'};
  });
  const list = (title, items, size, group, empty) => html`<${DetailList} title=${title} items=${docRows(items)} size=${size} view=${view} listKey=${`person:${group}`}
    resetKey=${person.id} onOpen=${r => onOpen?.(r.doc)} empty=${empty} />`;
  return html`<div class="person-profile" onKeyDown=${event => {
    // The viewer's Space shortcut goes Back; a focused profile control keeps its native activation.
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest?.('button, a, .dp-row.link')) event.stopPropagation();
  }}>
    <section class="person-profile-identity" aria-label="Person overview"><${Portrait} host=${host} path=${profile.photo} name=${name} /><div>
      <h2 class=${named ? 'dk-sr' : null}>${name}</h2>
      ${named ? null : html`<p>${joinText([personLine(person, {history: false}), person.line])}</p>`}
      ${named && person.line ? html`<p>${person.line}</p>` : null}
      <p>${lastContact ? `Last contact ${dateText(lastContact)}` : 'Last contact not recorded'}</p>
      <div class="person-actions">
        ${profile.photoLink ? html`<button type="button" class="dk-btn" onClick=${() => openLink(profile.photoLink.url)}>View recorded photos ↗</button>` : null}
        ${onMap ? html`<button type="button" class="dk-btn" onClick=${onMap}>Map</button>` : null}
        ${person.id != null ? html`<${DuplicatesToggle} open=${duplicates} onToggle=${showDuplicates} />` : null}
      </div></div></section>
    ${person.id != null ? html`<${PeopleDuplicates} key=${person.id} host=${host} personId=${person.id} open=${duplicates} />` : null}
    <section class="dk-section" aria-label="Contact details"><${SectionHead} level=${3} title="Contact details" />${profile.contacts.length
      ? html`<${Facts} onCopy=${value => copy(value)} facts=${profile.contacts.map(contact => ({label: contact.label, copy: contact.value,
          value: contact.href && openable(contact.href) ? html`<a class="dk-fact-link" href=${contact.href} onClick=${ev => { ev.preventDefault(); openLink(contact.href); }}>${contact.value}</a>` : contact.value}))} />`
      : html`<p class="dk-note">No phone number or email address is recorded.</p>`}</section>
    ${communications.length ? ['text', 'email'].map(kind => {
      const rows = communications.filter(c => c.kind === kind);
      return rows.length ? html`<div key=${kind}>${list(kind === 'text' ? 'Messages' : 'Email', rows, 6, kind, '')}</div>` : null;
    }) : html`<section class="dk-section" aria-label="Messages"><${SectionHead} level=${3} title="Messages" /><p class="dk-note">No indexed messages or email yet.</p></section>`}
    ${list('Documents', papers, 20, 'documents', 'No other indexed documents.')}
    ${links.length ? html`<section class="dk-section" aria-label="Links"><${SectionHead} level=${3} title="Links" /><div class="person-links">${links.map(link => html`<button key=${link.url} class="dk-btn text" onClick=${() => openLink(link.url)}>${link.title ?? 'Open link'} ↗</button>`)}</div></section>` : null}
    ${profile.clusters.length ? html`<${DetailList} title="Clusters" sorted=${true} view=${view} listKey="person:clusters" resetKey=${person.id}
      items=${profile.clusters.map(c => ({id: String(c.id), title: c.name, glyph: 'cluster', sub: c.from || c.to ? joinText([dateText(c.from), dateText(c.to)], ' – ') : null, cluster: c}))}
      onOpen=${onCluster ? r => onCluster(r.cluster) : undefined} />` : null}
    ${actionError ? html`<${Failure} backend="This device" error=${actionError} host=${host} />` : null}
  </div>`;
}

export function PersonProfile({host, item, onClose, onOpen}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState({});
    if (item) personProfile(host, item, request.signal).then(profile => {
      if (!request.signal.aborted) setState({profile});
    }, error => { if (!request.signal.aborted) setState({error}); });
    return () => request.abort();
  }, [host, item, retry]);
  const person = state.profile?.person ?? item?.person ?? {}, name = person.name ?? item?.title ?? 'Person';
  return html`<${Drawer} open=${!!item} title=${name} sub=${personLine(person, {history: false})} onClose=${onClose} label=${name}>
    ${state.error ? html`<${PageState} backend="bridge" error=${state.error} retry=${() => setRetry(n => n + 1)} host=${host} />` : state.profile ? html`<${PersonProfileContent} key=${person.id} named host=${host} profile=${state.profile} onOpen=${onOpen} onMap=${() => openMap(host, {by: 'subject', value: name, label: name})} />` : html`<${Skeleton} />`}
  <//>`;
}

/** The palette's person card (palette SPEC.md, *Person card*): the person the words name, as the first result and selectable as a row
 *  (`act`: the palette's row actions; Enter, a click or Profile › open the profile): the portrait or initials, the name, relation and
 *  counts, up to three copy chips (`onCopy(value)`), and up to three items (`onView(id)` its document: an event's its view; none repeats as a row below). `focus` (a new number each time):
 *  Tab moved in, so its first chip takes the focus (then `onFocused`); Tab and Shift+Tab step through the chips and items, past either
 *  end or Esc back to the box (`onLeave`). */
export function PersonCard({row, rows = [], selected = false, rowId, host, act, onCopy, onView, focus = false, onFocused, onLeave, now}) {
  const ref = useRef(null), [copied, setCopied] = useState(null);
  const person = row.person ?? {}, name = person.name ?? row.result?.title ?? 'Person', l = lines(row);
  const photo = normalizePersonProfile(person, row.result ?? {}).photo;
  const facts = cardFacts(person), items = cardItems(row, rows, now);
  useLayoutEffect(() => {
    if (!focus) return;
    ref.current?.querySelector('[data-stop]')?.focus({preventScroll: true});
    onFocused?.();
  }, [focus]);
  useEffect(() => { if (copied == null) return undefined; const t = setTimeout(() => setCopied(null), 1200); return () => clearTimeout(t); }, [copied]);
  const key = ev => {
    const stops = [...(ref.current?.querySelectorAll('[data-stop]') ?? [])], at = stops.indexOf(ev.target);
    if (at < 0) return;
    if (ev.key === 'Tab') {
      ev.preventDefault(); ev.stopPropagation();
      const next = stops[at + (ev.shiftKey ? -1 : 1)];
      if (next) next.focus({preventScroll: true}); else onLeave?.();
    } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onLeave?.(); }
  };
  const stop = ev => ev.stopPropagation();
  return html`<div ref=${ref} class=${`dp-row dp-card${selected ? ' sel' : ''}`} role="option" id=${rowId} data-id=${row.id} data-kind="person" data-card="true"
    aria-selected=${selected ? 'true' : 'false'} aria-label=${[name, l.sub].filter(Boolean).join(', ')} title=${l.tip || null} onKeyDown=${key}
    onClick=${ev => { if (!ev.target.closest('button')) act.select(row.id); }} onDblClick=${ev => { if (!ev.target.closest('button')) act.open(row.id); }}>
    <span class="dp-cardphoto"><${Portrait} host=${host} path=${photo} name=${name} /></span>
    <span class="dp-lines">
      <span class="dp-title">${name}</span>
      ${l.sub ? html`<span class="dp-sub">${sentence(l.sub)}</span>` : null}
    </span>
    <span class="dp-end"><button type="button" tabindex="-1" class="dp-pill" title="Profile (Enter)" onClick=${ev => { stop(ev); act.open(row.id); }}>Profile ›</button></span>
    <span class="dp-cardmore">
      ${facts.length ? html`<span class="dp-cardfacts" role="group" aria-label="Copy contact details">${facts.map((f, i) => html`<button key=${f.label} type="button" tabindex="-1" data-stop
        class=${`dp-chip dp-cardfact${copied === i ? ' copied' : ''}`} title=${`Copy ${f.label.toLowerCase()}: ${f.value}`} aria-label=${`Copy ${f.label.toLowerCase()} ${f.value}`}
        onClick=${ev => { stop(ev); Promise.resolve(onCopy?.(f.value)).then(() => setCopied(i), () => {}); }}>
        <${Glyph} name=${copied === i ? 'check' : f.glyph} size=${12} /><span>${copied === i ? 'Copied' : f.value}</span></button>`)}</span>` : null}
      ${items.length ? html`<span class="dp-carditems" role="group" aria-label=${`About ${name}`}>${items.map(it => html`<button key=${it.kind} type="button" tabindex="-1" data-stop class="dp-carditem"
        title=${it.title} onClick=${ev => { stop(ev); if (it.document?.id != null) onView?.(it.document.id); }}>
        <${Glyph} name=${it.kind === 'event' ? 'day' : it.kind === 'conversation' ? 'chat' : docGlyph(it.document)} size=${14} />
        <span class="dp-itemtitle">${it.kind === 'event' ? eventTitle(it.title) : it.title}</span>${it.when ? html`<span class="dp-itemwhen">${it.when}</span>` : null}</button>`)}</span>` : null}
    </span>
  </div>`;
}
