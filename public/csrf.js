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
  }
});
