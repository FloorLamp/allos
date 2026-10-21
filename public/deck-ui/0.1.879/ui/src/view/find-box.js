// A page's own find (and ask) in the palette's box: the find glyph, the input, Ask once there is text, the busy bar under it.
// Enter finds, Shift+Enter or Ask asks (palette SPEC.md, *Keys*). The page owns what a find or an ask does.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
const html = htm.bind(h);

export function FindBox({label, placeholder = label, value = '', onInput, onFind, onAsk, askLabel = 'Ask', busy = false, disabled = false}) {
  const text = value.trim();
  return html`<form class="dk-find" role="search" aria-label=${label} onSubmit=${ev => { ev.preventDefault(); if (text && !disabled) onFind?.(value); }}>
    <div class="dp-box"><${Glyph} name="find" size=${18} class="dp-boxglyph" />
      <input class="dp-input" type="search" aria-label=${label} placeholder=${placeholder} enterkeyhint="search" value=${value} disabled=${disabled}
        onInput=${ev => onInput?.(ev.currentTarget.value)}
        onKeyDown=${ev => { if (ev.key === 'Enter' && ev.shiftKey && onAsk) { ev.preventDefault(); if (text && !disabled) onAsk(value); } }} />
      ${onAsk && text ? html`<button type="button" class="dk-btn text" aria-label=${askLabel} title="Ask (Shift+Enter)" disabled=${disabled}
        onClick=${() => onAsk(value)}>Ask</button>` : null}</div>
    <div class=${`dp-bar${busy ? ' on' : ''}`} aria-hidden="true"></div>
  </form>`;
}
