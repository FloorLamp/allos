import {h} from '../../../vendor/preact.mjs';
import {useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Section} from './section.js';
import {RowList} from '../rows.js';
import {age} from '../../format.js';
const html = htm.bind(h);

/** bridge's recent asks (`/api/asks`: newest first, a question asked again listed again) as one entry per question, its latest time. */
export const recentQuestions = (asks = []) => {
  const seen = new Set();
  return asks.filter(a => a?.question && !seen.has(a.question) && seen.add(a.question));
};

/** Asked lately (Find's landing): one-line rows (the ask glyph, the question cut with an ellipsis, its whole text the row's title and
 *  name, when it was asked); a click or Enter asks it again (`onAsk(question)`). `limit` rows, then the section's `All n ›` shows the rest. */
export function Asks({asks = [], onAsk, fold, limit = 5, now = Date.now()}) {
  const [all, setAll] = useState(false);
  const list = recentQuestions(asks);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, limit);
  return html`<${Section} id="asks" label="Asked lately" class="dk-landing-section dk-rows-section dk-asks" count=${list.length} fold=${fold}
    headerActions=${shown.length < list.length ? html`<button type="button" class="dp-labelbtn" onClick=${() => setAll(true)}>All ${list.length} ›</button>` : null}>
    <${RowList} items=${shown.map((a, i) => ({id: `ask:${i}`, glyph: 'ask', title: a.question, tip: a.question, age: a.at ? age(a.at, now) : null, oneLine: true, question: a.question}))}
      onOpen=${it => onAsk?.(it.question)} />
  </${Section}>`;
}
