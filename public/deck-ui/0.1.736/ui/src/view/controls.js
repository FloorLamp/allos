import {h} from '../../vendor/preact.mjs';
import {useId} from '../../vendor/hooks.mjs';

export function Button({variant = 'secondary', children, buttonRef, ...props}) {
  return h('button', {...props, ref: buttonRef, 'data-variant': variant}, children);
}

/** Label and descriptions stay connected when several forms share a page. */
export function Field({as = 'input', label, hint, error, id, children, ...props}) {
  const generated = useId(), controlId = id ?? generated;
  const descriptions = [props['aria-describedby'], hint && `${controlId}-hint`, error && `${controlId}-error`].filter(Boolean).join(' ');
  return h('div', {class: 'dk-form-field'},
    h('label', {for: controlId}, label),
    h(as, {...props, id: controlId, 'aria-invalid': error ? 'true' : props['aria-invalid'], 'aria-describedby': descriptions || undefined}, children),
    hint && h('small', {id: `${controlId}-hint`, class: 'dk-field-hint'}, hint),
    error && h('small', {id: `${controlId}-error`, class: 'dk-field-error'}, error));
}
