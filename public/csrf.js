document.addEventListener('DOMContentLoaded', () => {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta) return;
  const token = meta.content;
  for (const form of document.querySelectorAll('form')) {
    if ((form.method || 'get').toLowerCase() !== 'post') continue;
    if (form.querySelector('input[name="_csrf"]')) continue;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = token;
    form.prepend(input);
    form.addEventListener('submit', event => {
      if (event.defaultPrevented) return;
      if (form.dataset.submitting === 'true') { event.preventDefault(); return; }
      form.dataset.submitting = 'true';
      // 保留提交按钮的 name/value（例如 save_draft），仅锁定后续点击。
      for (const button of Array.from(form.elements).filter(input => input.tagName === 'BUTTON' && input.type === 'submit')) {
        button.dataset.originalText = button.textContent;
        button.setAttribute('aria-disabled', 'true');
        button.textContent = '正在提交…';
      }
    });
  }
});

window.addEventListener('pageshow', () => {
  for (const form of document.querySelectorAll('form[data-submitting]')) {
    delete form.dataset.submitting;
    for (const button of Array.from(form.elements).filter(input => input.dataset.originalText != null)) {
      button.textContent = button.dataset.originalText;
      button.removeAttribute('aria-disabled');
      delete button.dataset.originalText;
    }
  }
});
