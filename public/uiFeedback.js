document.addEventListener('DOMContentLoaded', () => {
  const error = document.querySelector('.error');
  if (error) {
    error.setAttribute('role', 'alert'); error.tabIndex = -1; error.focus();
    const field = document.querySelector('form input:invalid, form select:invalid, form textarea:invalid');
    if (field) { field.setAttribute('aria-invalid', 'true'); error.id ||= 'formError'; field.setAttribute('aria-describedby', error.id); }
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.getElementById('mainNav')?.classList.remove('open'); document.getElementById('navToggle')?.setAttribute('aria-expanded', 'false');
  });
});
