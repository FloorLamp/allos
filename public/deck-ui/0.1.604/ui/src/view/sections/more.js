import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
const html = htm.bind(h);
export const More = ({n, url, onOpen, what}) => (n ? html`<button type="button" class="dg-more" data-nav onClick=${() => onOpen(url)}>+${n} more ${what}</button>` : null);

