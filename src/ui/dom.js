export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(c => c != null)); return node;
}
export const button = (label, action, cls = '') => el('button', { type: 'button', className: cls, onclick: action }, label);
export const option = (value, label) => el('option', { value }, label);
export function field(label, input) { return el('label', { className: 'field' }, el('span', {}, label), input); }
export function dialog(title, build) {
  return new Promise(resolve => {
    const node = el('dialog', { className: 'sheet' });
    const form = el('form', { method: 'dialog' });
    form.append(el('h2', {}, title));
    const finish = value => { node.close(); node.remove(); resolve(value); };
    const body = build(finish); form.append(body);
    node.append(form); document.body.append(node);
    node.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    node.addEventListener('click', event => { if (event.target === node) { const r = node.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) finish(null); } });
    node.showModal();
  });
}
export async function nameDialog(title, initial = '') {
  return dialog(title, finish => {
    const input = el('input', { value: initial, maxlength: 100, required: true, autofocus: true });
    const save = button('保存', () => { if (input.reportValidity() && input.value.trim()) finish(input.value.trim()); }, 'primary');
    const content = el('div', {}, field('名前', input), el('div', { className: 'actions' }, button('キャンセル', () => finish(null)), save));
    content.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } }); return content;
  });
}
