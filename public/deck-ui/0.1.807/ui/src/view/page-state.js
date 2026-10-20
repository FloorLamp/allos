import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {describeFailure, failurePage, webSignIn} from '../failure.js';
import {Glyph} from '../glyphs.js';
const html = htm.bind(h);

// The one set of states every page, section, the palette and the landing use (palette SPEC.md, *States*): loading, empty, starting,
// signed out, unavailable, not found and failed, each as one layout.
const STATUS = 'https://spaceport.wang.team/';
const opener = (host, url) => host ? ev => { ev.preventDefault(); host.call('url.open', {url}); } : undefined;

// The fleet status console is independent of the backend that failed: the quiet link beside a failure's one action.
export function StatusLink({host}) {
  return html`<a class="dk-btn text" href=${STATUS} onClick=${opener(host, STATUS)}>Service status ↗</a>`;
}

/** One state in a list's or a page's place: on a page a glyph, a title, one line, one primary action and the quiet status link;
 *  `inline` in a section's place (start-aligned, no glyph, no reserved height). `live` false where the page has its own live
 *  region saying it (the palette's); `alert` (default `warn`) what blocks the content. `children` (a loading skeleton) sit under the line. */
export function StateBlock({glyph, title, line, action, onAction, href, host, status = false, warn = false, alert = warn, live = true, inline = false, busy = false, label, children}) {
  const act = !action ? null : href ? html`<a class="dk-btn main" href=${href} onClick=${opener(host, href)}>${action}</a>`
    : html`<button type="button" class="dk-btn main" onClick=${onAction}>${action}</button>`;
  return html`<div class=${`dk-state${inline ? ' inline' : ''}${warn ? ' bad' : ''}`} role=${live ? alert ? 'alert' : 'status' : null}
      aria-busy=${busy ? 'true' : null} aria-label=${label}>
    ${glyph && !inline ? html`<div class="dk-tile"><${Glyph} name=${glyph} /></div>` : null}
    ${title ? html`<b>${title}</b>` : null}${line ? html`<p>${line}</p>` : null}${children}
    ${act || status ? html`<div class="acts">${act}${status ? html`<${StatusLink} host=${host} />` : null}</div>` : null}</div>`;
}

/** Loading: skeleton lines where the content will be. */
export const Skeleton = ({inline = false}) => html`<${StateBlock} inline=${inline} busy=${true} label="Loading">
  <div class="dk-skeleton" aria-hidden="true">${[72, 100, 88].map(width => html`<div key=${width} class="dk-ph" aria-hidden="true" style=${{width: `${width}%`}} />`)}</div>
  <span class="dk-sr">Loading…</span><//>`;

/** Errors take precedence over `state` (loading, empty, warming, signed out, unavailable, not found). In the page's own place (not
 *  `inline`) the page's header names it, so a failure says only what happened; in a section's place its line names its service
 *  (`House: …`) unless a `title` or, with `named`, the section's heading already does. An owner-only answer is a permission state, not a
 *  failure: "Only the owner can see Texts", with Sign in as owner on the site. Warming keeps `children` visible: a quiet notice above the
 *  last data, or with `hasData` false (nothing kept yet) a page saying it is starting. `own` false where several failures share one place. */
export function PageState({state, error, backend = 'bridge', title, hint, glyph, retry, host, children, inline = false, hasData = true, named = false,
  action, href, own = !inline}) {
  const device = host?.kind === 'shell';
  const failure = describeFailure(backend, error ?? {status: state === 'signed out' ? 401 : undefined}, {device});
  const current = error ? failure.state : state;
  // a backend this device or site is not connected to, or one it cannot read here: one unavailable state, no Retry (it cannot help)
  if (error && (failure.reason === 'not set up' || failure.reason === 'not supported here')) {
    const label = failurePage(backend), where = host?.kind === 'shell' ? 'device' : 'site', unset = failure.reason === 'not set up';
    const heading = unset ? `${label} isn’t connected yet` : `${label} isn’t available here yet`;
    const line = unset ? `${label} shows here once this ${where} is connected to it.` : `This ${where} can’t show ${label} yet.`;
    return inline ? html`<${StateBlock} inline=${true} line=${named ? (unset ? 'Not connected yet.' : 'Not available here yet.') : `${heading}.`} />`
      : html`<${StateBlock} glyph=${glyph ?? 'details'} title=${title ?? heading} line=${hint ?? line} />`;
  }
  if (current === 'loading') return html`<${Skeleton} inline=${inline} />`;
  // in a section's place an empty state is one quiet line, whichever of title and hint says it
  if (current === 'empty') return inline ? html`<${StateBlock} inline=${true} line=${hint ?? title} />`
    : html`<${StateBlock} glyph=${glyph} title=${title ?? 'Nothing here yet'} line=${hint} />`;
  if (current === 'unavailable') return html`<${StateBlock} glyph=${glyph ?? 'details'} title=${title ?? 'Page unavailable'}
    line=${hint ?? 'This page isn’t available here yet.'} action="Open Find" href="/" />`;
  // an address that is no page: its one action (default Find) leads somewhere that is
  if (current === 'not found') return html`<${StateBlock} glyph=${glyph ?? 'find'} title=${title ?? 'Page not found'}
    line=${hint ?? 'Nothing is at this address.'} action=${action ?? 'Open Find'} href=${href ?? '/'} />`;
  if (current === 'warming' && !inline) return html`<div class="dk-page-state">${hasData
    ? html`<${StateBlock} inline=${true} line="Starting, showing your last data" />`
    : html`<${StateBlock} title="Starting up" line="This shows here as soon as it’s ready." />`}${children}</div>`;
  // a page's owner-only answer (describeFailure: a known page, no recovery action); another 403 stays "You don’t have permission"
  if (error && failure.status === 403 && failure.action === null && !device) {
    const line = `Only the owner can see ${failurePage(backend)}.`;
    return html`<${StateBlock} inline=${inline} alert=${true} glyph=${glyph ?? 'lock'} host=${host} title=${inline ? null : title ?? 'Owner only'}
      line=${line} action=${host?.kind === 'web' ? 'Sign in as owner' : null} href=${host?.kind === 'web' ? webSignIn() : undefined} />`;
  }
  if (current === 'signed out' || current === 'error' || inline && current === 'warming') {
    const signIn = current === 'signed out', denied = !signIn && !device && failure.action === null;
    const action = signIn ? failure.action : retry && !denied ? 'Retry' : !denied && failure.url ? failure.action : null;
    return html`<${StateBlock} inline=${inline} warn=${!signIn} alert=${true} glyph=${glyph ?? (signIn ? 'lock' : 'warn')} host=${host}
      title=${inline ? (named && current === 'error' ? 'Couldn’t load' : null) : title ?? (signIn ? 'Signed out' : null)} line=${named || own || !inline && title ? failure.detail : failure.message}
      action=${action} onAction=${action === 'Retry' ? retry : undefined} href=${action && action !== 'Retry' ? failure.url : undefined}
      status=${!denied} />`;
  }
  return children ?? null;
}

/** A failure in a section's place, sharing PageState's copy and recovery. */
export function Failure(props) {
  return html`<${PageState} ...${props} state="error" inline=${props.inline ?? true} />`;
}

/** Browser sessions cover all backends: one sign-in names every affected page, one line every backend not connected yet, one
 *  notice every backend starting up; other failures each keep their own recovery.
 *  `inline` beside the page's other content; else in the page's place (nothing else shows). */
export function Failures({failures, host, inline = true}) {
  const signedOut = host?.kind !== 'shell' ? failures.filter(f => f.error?.status === 401) : [];
  // Backends this device was never connected to: one line for all of them; Retry cannot help.
  const unset = failures.filter(f => !signedOut.includes(f) && f.error?.code === 'not-set-up');
  // Backends starting up: one notice for all of them (they are asked again until they answer), never a failure each.
  const warming = failures.filter(f => !signedOut.includes(f) && !unset.includes(f) && (f.error?.state ?? describeFailure(f.backend, f.error).state) === 'warming');
  const pages = [...new Set(signedOut.map(f => failurePage(f.backend)))], missing = [...new Set(unset.map(f => failurePage(f.backend)))];
  const and = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return html`<div class="dk-failures">${pages.length ? html`<${Failure} inline=${inline} backend=${pages.join(', ')} error=${{status: 401}} host=${host} />` : null}
    ${missing.length ? html`<${StateBlock} inline=${inline} glyph="warn" title=${inline ? null : 'Not connected'}
      line=${`${and(missing)} ${missing.length > 1 ? 'aren’t' : 'isn’t'} connected on this ${host?.kind === 'shell' ? 'device' : 'site'} yet.`} />` : null}
    ${warming.length ? html`<${PageState} state="warming" hasData=${inline} host=${host} />` : null}
    ${failures.filter(f => !signedOut.includes(f) && !unset.includes(f) && !warming.includes(f)).map(f => html`<${Failure} inline=${inline} own=${false} hasData=${inline} ...${f} host=${host} />`)}</div>`;
}
