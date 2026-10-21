// A product's picture in a row's tile (a cluster's things): its glyph at once, the photo over it once the host has it (bridge's
// /v1/thing-image/<sha256>, through the host's resource op); no photo, a refused path or a failed image leave the glyph.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {resourcePath} from '../host/host.js';
const html = htm.bind(h);

/** `image` {url} (bridge's thing image) or null; `glyph` the tile's own; `size` the glyph's; `class` where it sits. */
export function ProductTile({host, image, glyph = 'thing', size = 18, class: cls = null}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    const path = resourcePath(image?.url);
    if (path && host?.resource) Promise.resolve().then(() => host.resource(path)).then(url => { if (active && url) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [host, image?.url]);
  return html`<span class=${`dp-tile${src ? ' thumb' : ''}${cls ? ` ${cls}` : ''}`} aria-hidden="true">${src
    ? html`<img src=${src} alt="" decoding="async" draggable="false" onError=${() => setSrc(null)} />` : null}<${Glyph} name=${glyph} size=${size} /></span>`;
}
