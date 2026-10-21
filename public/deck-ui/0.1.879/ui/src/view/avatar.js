// A person's picture wherever they appear (bridge's /v1/people/<id>/photo: their latest face; contract/resources.md): their initials at
// once, the portrait over them once it comes near the view, asked at the size it is drawn times the screen's density (`?w=`), through
// the host's resource op (the site's /api, a desktop's relay). Loading, a 404 or a failed image leave the initials; the box never moves.
// Never on a shared screen (`SharedScreen`: the House tablet and the camera wall). A face linked or unlinked on this page redraws every
// Avatar of that person at once: its portrait version (people-faces.js) asked as `&v=`, past the browser's cached image. An org (`org`)
// is a rounded square, its logo (bridge's /v1/people/<id>/logo, asked the same way) whole on a white plate, its initials till then.
import {createContext, h} from '../../vendor/preact.mjs';
import {useContext, useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {initials} from '../format.js';
import {portraitVersion, subscribeFaces} from '../people-faces.js';
const html = htm.bind(h);
const PORTRAIT = /^\/v1\/people\/([^/?]+)\/photo$/;

/** True under a screen others look at: avatars there are initials only, no portrait is asked for. */
export const SharedScreen = createContext(false);

/** The portrait's resource path at `px` drawn pixels (bridge snaps it, 48 to 512), `v` its version on this page (0: none asked). */
export const portraitPath = (path, px, v = 0) => `${path}?w=${Math.min(512, Math.max(48, Math.ceil(px)))}${v ? `&v=${v}` : ''}`;

/** The portrait version of the person `path` is the portrait of, kept current: a link or unlink of theirs redraws. */
function useVersion(path) {
  const id = PORTRAIT.exec(path ?? '')?.[1], person = id == null ? null : decodeURIComponent(id);
  const [version, setVersion] = useState(() => person == null ? 0 : portraitVersion(person));
  useEffect(() => {
    if (person == null) return undefined;
    setVersion(portraitVersion(person));
    return subscribeFaces(change => { if (change.id === person) setVersion(portraitVersion(person)); });
  }, [person]);
  return version;
}

/** `path`: the person's `photo` (people.js `personPhoto`) or an org's logo (`avatarOf`), null for none; `org`: an organisation's (a
 *  rounded square); `alt`: the picture's own name when it is the subject (the profile), else it is decoration beside the name;
 *  `class`: where it sits (its size). `sized: false`: an image asked as it is (an Immich face's thumbnail), not at the drawn size. */
export function Avatar({host, path, name, alt = '', class: cls = null, sized = true, org = false}) {
  const shared = useContext(SharedScreen);
  const ref = useRef(null), [src, setSrc] = useState(null), [shown, setShown] = useState(false), version = useVersion(sized ? path : null);
  useEffect(() => {
    setSrc(null); setShown(false);
    const el = ref.current;
    if (!path || shared || !host?.resource || !el) return undefined;
    let active = true, seen = null;
    const load = () => {
      const px = el.getBoundingClientRect().width * (globalThis.devicePixelRatio || 1);
      Promise.resolve().then(() => host.resource(sized ? portraitPath(path, px, version) : path)).then(url => { if (active && url) setSrc(url); }, () => {});
    };
    if (typeof IntersectionObserver !== 'function') load();
    else {
      seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { seen.disconnect(); load(); } }, {rootMargin: '200px'});
      seen.observe(el);
    }
    return () => { active = false; seen?.disconnect(); };
  }, [host, path, shared, sized, version]);
  return html`<span ref=${ref} class=${`dk-avatar${org ? ' org' : ''}${shown ? ' shown' : ''}${cls ? ` ${cls}` : ''}`} aria-hidden=${alt ? null : 'true'}>
    <span class="dk-avatar-initials">${initials(name)}</span>
    ${src ? html`<img src=${src} alt=${alt} decoding="async" draggable="false" onLoad=${() => setShown(true)} onError=${() => { setSrc(null); setShown(false); }} />` : null}
  </span>`;
}
