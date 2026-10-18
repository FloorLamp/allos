import {PeopleDuplicates} from './people-duplicates.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {personProfile} from '../people.js';
import {dateLabel} from '../../../palette/model.mjs';
import {openable} from '../host/host.js';
import {Drawer} from './drawer.js';
import {Failure} from './failure.js';
import {openMap} from './map.js';
const html = htm.bind(h);
export const relationLabel = value => value ? String(value).replace(/_/g, ' ').replace(/^./u, c => c.toUpperCase()) : null;
export const PersonAvatar = ({name}) => html`<span class="person-avatar" aria-hidden="true">${String(name ?? '').trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase() || '?'}</span>`;

function Portrait({host, path, name}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    if (path) Promise.resolve().then(() => host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [host, path]);
  return src ? html`<img class="person-portrait" src=${src} alt=${`Photo of ${name}`} width="80" height="80" decoding="async" onError=${() => setSrc(null)} />` : html`<${PersonAvatar} name=${name} />`;
}

/** Page locally over indexed membership. Returning from a document restores the same page and scroll. */
function DocumentGroup({label, items, onOpen, size, view, group, renderItem}) {
  const [page, setPage] = useState(() => view?.personPages?.[group] ?? 0);
  const last = Math.max(0, Math.ceil(items.length / size) - 1), current = Math.min(page, last);
  const turn = next => {
    if (view) { view.personPages ??= {}; view.personPages[group] = next; }
    setPage(next);
  };
  return html`<div class="person-communication-group"><h3>${label} <span>(${items.length.toLocaleString()})</span></h3><ul>${items.slice(current * size, (current + 1) * size).map(item => {
    const document = item.document ?? item;
    return html`<li key=${document.id}>${renderItem ? renderItem(item) : html`<button type="button" class="person-document" onClick=${() => onOpen?.(document)}><span>${item.title ?? document.title ?? 'Untitled document'}</span><time datetime=${item.date ?? document.date ?? null}>${item.date ?? document.date ? dateLabel(item.date ?? document.date) : 'Date not recorded'}</time></button>`}</li>`;
  })}</ul>${last > 0 ? html`<nav class="person-document-pages" aria-label=${`${label} pages`}><button class="dk-btn" disabled=${current === 0} onClick=${() => turn(current - 1)}>Previous ${label.toLowerCase()}</button><span>${current + 1} / ${last + 1}</span><button class="dk-btn" disabled=${current === last} onClick=${() => turn(current + 1)}>Next ${label.toLowerCase()}</button></nav>` : null}</div>`;
}

/** Shared content for standalone profile, palette Details and an already-loaded person viewer. */
export function PersonProfileContent({host, profile, onOpen, onCopy, onCluster, onMap, view}) {
  const [actionError, setActionError] = useState(null);
  const person = profile.person, name = person.name ?? 'Person';
  const openLink = url => { if (openable(url)) host.call('url.open', {url}).catch(setActionError); };
  const copy = value => Promise.resolve(onCopy ? onCopy(value) : host.call('clipboard.copy', {text: value})).catch(setActionError);
  const communications = profile.communications, communicationIds = new Set(communications.map(c => String(c.document.id)));
  const papers = profile.documents.filter(d => !communicationIds.has(String(d.id)));
  const links = profile.links.filter(link => link.url !== profile.photoLink?.url);
  return html`<div class="person-profile" onKeyDown=${event => {
    // The viewer's Space shortcut goes Back; a focused profile control keeps its native activation.
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest?.('button, a')) event.stopPropagation();
  }}>
    <section class="person-profile-identity" aria-label="Person overview"><${Portrait} host=${host} path=${profile.photo} name=${name} /><div><h2>${name}</h2>
      <p>${[relationLabel(person.relation), person.organisation ?? person.vendor, person.role, person.line].filter(Boolean).join(' · ')}</p>
      <p>${person.lastContact ? `Last contact ${dateLabel(person.lastContact)}` : 'Last contact not recorded'}</p>
      ${profile.photoLink ? html`<button type="button" class="dk-btn text" onClick=${() => openLink(profile.photoLink.url)}>View recorded photos ↗</button>` : null}</div></section>
    ${person.id != null ? html`<${PeopleDuplicates} key=${person.id} host=${host} personId=${person.id} />` : null}
    ${onMap ? html`<button type="button" class="dk-btn person-map" onClick=${onMap}>Map</button>` : null}
    <section class="person-profile-section" aria-label="Contact details"><h2>Contact details</h2>${profile.contacts.length ? html`<dl class="person-contacts">${profile.contacts.map(contact => html`<div key=${contact.label + contact.value}><dt>${contact.label}</dt><dd>${contact.href && openable(contact.href) ? html`<a href=${contact.href} onClick=${ev => { ev.preventDefault(); openLink(contact.href); }}>${contact.value}</a>` : html`<span>${contact.value}</span>`}<button class="dk-btn text person-copy" title=${`Copy ${contact.value}`} aria-label=${`Copy ${contact.label}`} onClick=${() => copy(contact.value)}>Copy</button></dd></div>`)}</dl>` : html`<p class="person-profile-empty">No phone number or email address is recorded.</p>`}</section>
    <section class="person-profile-section" aria-label="Latest communications"><h2>Latest communications</h2><p class="person-profile-note">Most recent indexed messages and email. Open one to read it.</p>
      ${communications.length ? ['text', 'email'].map(kind => {
        const rows = communications.filter(c => c.kind === kind);
        return rows.length ? html`<${DocumentGroup} key=${kind} label=${kind === 'text' ? 'Messages' : 'Email'} items=${rows} size=${6} onOpen=${onOpen} view=${view} group=${kind} />` : null;
      }) : html`<p class="person-profile-empty">No indexed communications yet.</p>`}
    </section>
    <section class="person-profile-section" aria-label="Documents"><h2>Documents</h2>${papers.length ? html`<${DocumentGroup} label="Documents" items=${papers} size=${20} onOpen=${onOpen} view=${view} group="documents" />` : html`<p class="person-profile-empty">No other indexed documents.</p>`}</section>
    ${links.length ? html`<section class="person-profile-section" aria-label="Links"><h2>Links</h2><div class="person-links">${links.map(link => html`<button key=${link.url} class="dk-btn text" onClick=${() => openLink(link.url)}>${link.title ?? 'Open link'} ↗</button>`)}</div></section>` : null}
    ${profile.clusters.length ? html`<section class="person-profile-section" aria-label="Clusters"><h2>Clusters</h2><${DocumentGroup} label="Clusters" items=${profile.clusters} size=${20} view=${view} group="clusters"
      renderItem=${cluster => onCluster ? html`<button class="dk-btn text" onClick=${() => onCluster(cluster)}>${cluster.name} ›</button>` : html`<span>${cluster.name}</span>`} /></section>` : null}
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
  return html`<${Drawer} open=${!!item} title=${name} sub=${[relationLabel(person.relation), person.organisation ?? person.vendor, person.role].filter(Boolean).join(' · ')} onClose=${onClose} label=${name}>
    ${state.error ? html`<${Failure} backend="bridge" error=${state.error} retry=${() => setRetry(n => n + 1)} host=${host} />` : state.profile ? html`<${PersonProfileContent} key=${person.id} host=${host} profile=${state.profile} onOpen=${onOpen} onMap=${() => openMap(host, {by: 'subject', value: name, label: name})} />` : html`<p role="status">Loading profile…</p>`}
  <//>`;
}
