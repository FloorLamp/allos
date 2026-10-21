import {DuplicatesEntry, PeopleDuplicates, useDuplicates} from './people-duplicates.js';
import {PersonMerges} from './person-merges.js';
import {FacePicker, PersonFace, usePersonFace} from './person-face.js';
import {canLinkFaces} from '../people-faces.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {docGlyph} from '../../../palette/model.mjs';
import {avatarOf, cardFacts, cardItems, normalizePersonProfile, personProfile} from '../people.js';
import {lines} from './rows.js';
import {dateText, eventTitle, joinText, personLine, sentence} from '../format.js';
import {Avatar} from './avatar.js';
import {HostError, openable} from '../host/host.js';
import {collectionAnswer} from '../collection-reader.js';
import {Facts, SectionHead} from './drawer.js';
import {RecordCard, useCardStops} from './record-card.js';
import {DetailList} from './detail-list.js';
import {useEntityOpen} from './entity-link.js';
import {Failure, PageState} from './page-state.js';
import {openMap} from './map.js';
const html = htm.bind(h);
/** Shared content for standalone profile, palette Details and an already-loaded person viewer: the shared detail lists
 *  (DetailList), each paging locally over indexed membership; returning from a document restores the same page and scroll. */
/** `named`: the drawer's header already names the person and their relation; the hero then shows the portrait, contact and actions.
 *  `photos`: the photos Find found of them (the viewer's, viewer/common.js EntryPhotos), under the hero. */
export function PersonProfileContent({host, profile, onOpen, onCopy, onCluster, onMap, view, named = false, photos = null}) {
  const [actionError, setActionError] = useState(null), [duplicates, showDuplicates] = useState(false), openEntity = useEntityOpen();
  const person = profile.person, name = person.name ?? 'Person', review = useDuplicates(host, person.id, {enabled: person.id != null});
  // a cluster opens its own record: the desktop's pane, the site's Clusters page
  const openCluster = onCluster ?? (cluster => openEntity({kind: 'cluster', id: cluster.id}));
  const openLink = url => { if (openable(url)) host.call('url.open', {url}).catch(setActionError); };
  const copy = value => Promise.resolve(onCopy ? onCopy(value) : host.call('clipboard.copy', {text: value})).catch(setActionError);
  const communications = profile.communications, communicationIds = new Set(communications.map(c => String(c.document.id)));
  const papers = profile.documents.filter(d => !communicationIds.has(String(d.id)));
  const links = profile.links.filter(link => link.url !== profile.photoLink?.url);
  const lastContact = person.lastContact ?? profile.latestCommunication?.date ?? null, portrait = usePersonFace(person).photo;
  const picture = profile.org ? {path: profile.logo, org: true, alt: `Logo of ${name}`} : {path: portrait, alt: `Photo of ${name}`};
  const docRows = items => items.map(item => {
    const document = item.document ?? item;
    return {id: String(document.id), title: item.title || document.title || 'Untitled document', date: item.date ?? document.date ?? null, glyph: item.kind === 'email' ? 'mail' : item.kind === 'text' ? 'chat' : 'document', doc: document,
      sub: item.date ?? document.date ? null : 'Date not recorded'};
  });
  const list = (title, items, size, group) => html`<${DetailList} title=${title} items=${docRows(items)} size=${size} view=${view} listKey=${`person:${group}`}
    resetKey=${person.id} onOpen=${r => onOpen?.(r.doc)} />`;
  return html`<div class="person-profile" onKeyDown=${event => {
    // The viewer's Space shortcut goes Back; a focused profile control keeps its native activation.
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest?.('button, a, .dp-row.link')) event.stopPropagation();
  }}>
    <section class="person-profile-identity" aria-label=${profile.org ? 'Organization overview' : 'Person overview'}><${Avatar} host=${host} ...${picture} name=${name} class="person-portrait" /><div>
      <h2 class=${named ? 'dk-sr' : null}>${name}</h2>
      ${named ? null : html`<p>${joinText([personLine(person, {history: false}), person.line])}</p>`}
      ${named && person.line ? html`<p>${person.line}</p>` : null}
      ${lastContact ? html`<p>Last contact ${dateText(lastContact)}</p>` : null}
      <div class="person-actions">
        ${profile.photoLink ? html`<button type="button" class="dk-btn" onClick=${() => openLink(profile.photoLink.url)}>View recorded photos ↗</button>` : null}
        ${onMap ? html`<button type="button" class="dk-btn" onClick=${onMap}>Map</button>` : null}
        ${person.id != null ? html`<${DuplicatesEntry} review=${review} open=${duplicates} onToggle=${showDuplicates} />` : null}
      </div></div></section>
    ${person.id != null ? html`<${PeopleDuplicates} key=${person.id} host=${host} review=${review} open=${duplicates} onClose=${() => showDuplicates(false)} />` : null}
    ${photos}
    ${profile.org ? null : html`<${PersonFace} host=${host} person=${person} />`}
    <${PersonMerges} host=${host} merges=${profile.merges} />
    ${profile.contacts.length ? html`<section class="dk-section" aria-label="Contact details"><${SectionHead} level=${3} title="Contact details" />
      <${Facts} onCopy=${value => copy(value)} facts=${profile.contacts.map(contact => ({label: contact.label, copy: contact.value,
          value: contact.href && openable(contact.href) ? html`<a class="dk-fact-link" href=${contact.href} onClick=${ev => { ev.preventDefault(); openLink(contact.href); }}>${contact.value}</a>` : contact.value}))} /></section>` : null}
    ${communications.length ? ['text', 'email'].map(kind => {
      const rows = communications.filter(c => c.kind === kind);
      return rows.length ? html`<div key=${kind}>${list(kind === 'text' ? 'Messages' : 'Email', rows, 6, kind)}</div>` : null;
    }) : null}
    ${list('Documents', papers, 20, 'documents')}
    ${links.length ? html`<section class="dk-section" aria-label="Links"><${SectionHead} level=${3} title="Links" /><div class="person-links">${links.map(link => html`<button key=${link.url} class="dk-btn text" onClick=${() => openLink(link.url)}>${link.title ?? 'Open link'} ↗</button>`)}</div></section>` : null}
    ${profile.clusters.length ? html`<${DetailList} title="Clusters" sorted=${true} view=${view} listKey="person:clusters" resetKey=${person.id}
      items=${profile.clusters.map(c => ({id: String(c.id), title: c.name, glyph: 'cluster', sub: c.from || c.to ? joinText([dateText(c.from), dateText(c.to)], ' – ') : null, cluster: c}))}
      onOpen=${r => openCluster(r.cluster)} />` : null}
    ${actionError ? html`<${Failure} backend="This device" error=${actionError} host=${host} />` : null}
  </div>`;
}

/** A person's record card parts (the shared record card) from their profile: up to three copy chips (phone, email), their newest
 *  messages and other documents (their row's line already says the relation and last contact); `onOpen(document)`; `onLinkFace`:
 *  Link a face, while they have none. */
export function personCard(profile, {onOpen, openLink, onLinkFace} = {}) {
  const person = profile.person, kind = c => c.href?.startsWith('tel:') ? 'phone' : c.href?.startsWith('mailto:') ? 'email' : 'other';
  const chips = [...profile.contacts.filter(c => kind(c) === 'phone'), ...profile.contacts.filter(c => kind(c) === 'email')].slice(0, 3)
    .map(c => ({label: c.label, value: c.value, glyph: kind(c) === 'email' ? 'mail' : 'chat'}));
  const talk = new Set(profile.communications.map(c => String(c.document.id)));
  const item = (d, glyph) => ({id: String(d.id), title: d.title || 'Untitled document', date: d.date ?? null, when: dateText(d.date), glyph, link: {kind: 'document', id: d.id}, onOpen: () => onOpen?.(d)});
  return {label: person.name ?? 'Person', chips,
    groups: [{key: 'messages', title: 'Messages', items: profile.communications.map(c => item(c.document, c.kind === 'email' ? 'mail' : 'chat'))},
      {key: 'documents', title: 'Documents', items: profile.documents.filter(d => !talk.has(String(d.id))).map(d => item(d, 'document'))}],
    actions: [onLinkFace && !profile.org && !profile.photo && !profile.face ? {label: 'Link a face', onClick: onLinkFace} : null,
      profile.photoLink && openLink ? {label: 'Recorded photos ↗', onClick: () => openLink(profile.photoLink.url)} : null].filter(Boolean)};
}

/** A person's record card (People's row opened in place, Find's selected person): `personCard`'s parts and the caller's `actions`;
 *  while they have no face and this page may link one, Link a face (the face picker unfolds in the card, under its actions). */
export function PersonCardOf({host, profile, onOpen, onFull, actions = []}) {
  const [picking, setPicking] = useState(false), live = usePersonFace(profile.person);
  const openLink = url => { if (openable(url)) host.call('url.open', {url}).catch(() => {}); };
  const current = {...profile, photo: live.photo, face: live.face};
  const faces = canLinkFaces(host) && !profile.org; // an org has a logo, never a face
  const card = personCard(current, {onOpen, openLink, onLinkFace: faces ? () => setPicking(!picking) : null});
  const link = card.actions.find(a => a.label === 'Link a face');
  if (link) link.expanded = picking;
  return html`<${RecordCard} ...${card} actions=${[...card.actions, ...actions]} onCopy=${value => host.call('clipboard.copy', {text: value})} onOpen=${onFull}
    after=${faces ? html`<${FacePicker} host=${host} person=${profile.person} open=${picking && !!link} onClose=${() => setPicking(false)} />` : null} />`;
}

/** A person opened in place on People (the shared record card): their profile read, then its card; Open their whole profile. */
export function PersonRecordCard({host, item, onOpen, onFull}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState({});
    // its read kept for its full view (Open), the one profile read
    const document = item.document ?? item.result?.document;
    (document?.id == null ? personProfile(host, item, request.signal)
      : collectionAnswer(host, {collection: 'people', id: String(item.person.id), document}, {signal: request.signal, keep: true}).then(answer => {
        if (!answer?.person) throw new HostError('http', 'Person details unavailable', 404);
        return normalizePersonProfile(answer.person, item);
      })).then(profile => {
      if (!request.signal.aborted) setState({profile});
    }, error => { if (!request.signal.aborted) setState({error}); });
    return () => request.abort();
  }, [host, item?.person?.id, retry]);
  if (state.error) return html`<${PageState} backend="bridge" error=${state.error} retry=${() => setRetry(n => n + 1)} host=${host} inline=${true} />`;
  if (!state.profile) return html`<p class="dk-note" role="status">Loading ${item?.person?.name ?? 'person'}…</p>`;
  const name = state.profile.person.name ?? 'Person';
  return html`<${PersonCardOf} host=${host} profile=${state.profile} onOpen=${onOpen} onFull=${onFull}
    actions=${[{label: 'Map', onClick: () => openMap(host, {by: 'subject', value: name, label: name})}]} />`;
}

/** The palette's person card (palette SPEC.md, *Person card*): the person the words name, as the first result and selectable as a row
 *  (`act`: the palette's row actions; Enter, a click or Profile › open the profile): the portrait or initials, the name, relation and
 *  counts, up to three copy chips (`onCopy(value)`), and up to three items (`onView(id)` its document: an event's its view; none repeats as a row below). `focus` (a new number each time):
 *  Tab moved in, so its first chip takes the focus (then `onFocused`); Tab and Shift+Tab step through the chips and items, past either
 *  end or Esc back to the box (`onLeave`). */
export function PersonCard({row, rows = [], selected = false, rowId, host, act, onCopy, onView, focus = false, onFocused, onLeave, onArrow, now}) {
  const ref = useRef(null);
  const person = row.person ?? {}, name = person.name ?? row.result?.title ?? 'Person', l = lines(row);
  const photo = usePersonFace(normalizePersonProfile(person, row.result ?? {}).person).photo, org = avatarOf(person, name);
  const key = useCardStops(ref, {focus, onFocused, onLeave, onArrow});
  const items = cardItems(row, rows, now).map(it => ({id: it.kind, title: it.kind === 'event' ? eventTitle(it.title) : it.title, when: it.when,
    glyph: it.kind === 'event' ? 'day' : it.kind === 'conversation' ? 'chat' : docGlyph(it.document), onOpen: () => { if (it.document?.id != null) onView?.(it.document.id); }}));
  const stop = ev => ev.stopPropagation();
  return html`<div ref=${ref} class=${`dp-row dp-card${selected ? ' sel' : ''}`} role="option" id=${rowId} data-id=${row.id} data-kind="person" data-card="true"
    aria-selected=${selected ? 'true' : 'false'} aria-label=${[name, l.sub].filter(Boolean).join(', ')} title=${l.tip || null} onKeyDown=${key}
    onClick=${ev => { if (!ev.target.closest('button')) act.select(row.id); }} onDblClick=${ev => { if (!ev.target.closest('button')) act.open(row.id); }}>
    <span class="dp-cardphoto"><${Avatar} host=${host} path=${org.org ? org.path : photo} org=${org.org} name=${name} /></span>
    <span class="dp-lines">
      <span class="dp-title">${name}</span>
      ${l.sub ? html`<span class="dp-sub">${sentence(l.sub)}</span>` : null}
    </span>
    <span class="dp-end"><button type="button" tabindex="-1" class="dp-pill" title="Profile (Enter)" onClick=${ev => { stop(ev); act.open(row.id); }}>Profile ›</button></span>
    <span class="dp-cardmore"><${RecordCard} stops=${true} label=${`About ${name}`} chips=${cardFacts(person)} onCopy=${onCopy}
      groups=${[{key: 'about', label: `About ${name}`, items}]} /></span>
  </div>`;
}
