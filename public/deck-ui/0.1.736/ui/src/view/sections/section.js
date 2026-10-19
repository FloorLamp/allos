import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
const html = htm.bind(h);
export const Section = ({id, label, count, fold, children, class: className, headerActions, ...attrs}) => {
  const shut = !!fold?.collapsed.has(id);
  return html`<section ...${attrs} class=${`${className ?? 'dg-section'}${shut ? ' shut' : ''}`} aria-label=${label}>
    <h2 class=${className ? 'dk-label' : 'dg-head'}><button type="button" class=${className ? 'dk-section-fold' : 'dg-fold'} data-nav aria-expanded=${shut ? 'false' : 'true'} aria-controls=${`dg-${id}`} onClick=${() => fold?.toggle(id)}>
      <${Glyph} name="next" size=${12} class="dg-chevron" /><span class=${className ? null : 'dk-label'}>${label}</span>${shut && count ? html`<span class="dg-count">${count}</span>` : null}</button>${headerActions}</h2>
    <div class=${className ? 'dk-section-body' : 'dg-body'} id=${`dg-${id}`} hidden=${shut}>${children}</div>
  </section>`;
};

