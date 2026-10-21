import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {collectionTarget, recordHref} from '../../collection-target.js';
import {Failure} from '../page-state.js';
import {later} from '../deferred.js';
import {EntryPhotos} from './common.js';
const html = htm.bind(h);

/** A viewer frame is shared by every page; collection code loads only when a recorded entity opens. */
export function CollectionEntityContent(props) {
  const target = collectionTarget(props.target) ?? collectionTarget(props.payload);
  const [loaded, setLoaded] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0);
  const needed = !!target;
  useEffect(() => {
    if (!needed || loaded) return;
    let active = true;
    setError(null);
    later().then(module => {
      if (active) setLoaded(() => module.CollectionContent);
    }, failure => { if (active) setError(failure); });
    return () => { active = false; };
  }, [needed, loaded, retry]);
  if (!target) return null;
  if (error) return html`<${Failure} backend="bridge" error=${error} host=${props.host} retry=${() => setRetry(n => n + 1)} />`;
  return loaded ? h(loaded, props) : html`<p role="status">Loading details…</p>`;
}

/** A record another names (a person's cluster, a cluster's thing): the site its own page (`/clusters?record=<id>#<id>`), a desktop's or
 *  the phone's viewer in place (Back returns). */
export const openRecord = (v, target) => v.host.kind === 'web' ? globalThis.location.assign(recordHref(target)) : v.openRelated({collection: target});

/** Viewer framing only; all collection content is the standalone page's canonical component. */
export function Collection({v, e, pane}) {
  const body = useRef(null), restored = useRef(false), scrollTop = useRef(e.view.scrollTop ?? 0);
  pane.kind.current = {};
  const ready = () => {
    if (!restored.current && body.current) { body.current.scrollTop = scrollTop.current; restored.current = true; }
  };
  return html`<div class="dv-scroll dv-textscroll" ref=${body} onScroll=${event => { if (restored.current) e.view.scrollTop = event.currentTarget.scrollTop; }}>
    <${CollectionEntityContent} host=${v.host} target=${e.collection} payload=${e.answer} view=${e.view} onReady=${ready} photos=${e.photos ? html`<${EntryPhotos} v=${v} e=${e} />` : null}
      onOpen=${document => v.openRelated({document})} onRecord=${target => openRecord(v, target)} onClose=${() => v.back()} onMap=${() => v.openMap()} />
  </div>`;
}
