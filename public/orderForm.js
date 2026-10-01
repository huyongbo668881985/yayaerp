(() => {
  let rowNumber = 0;
  function bindRow(row) {
    if (row.dataset.pickerReady) return;
    row.dataset.pickerReady = 'true';
    row.classList.add('sale-item-row');
    row.style.removeProperty('grid-template-columns');
    const select = row.querySelector('[name="product_id"]'), search = row.querySelector('.product-search');
    if (!select || !search) return;
    select.required = false;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    search.required = true;
    search.placeholder = '输入商品名称或 SKU，点击结果选中';
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-autocomplete', 'list');
    let label = search.closest('label');
    if (!label) { label = document.createElement('label'); label.textContent = '商品'; search.before(label); label.appendChild(search); }
    label.className = 'sale-product-label';
    let results = row.querySelector('.sale-product-results');
    if (!results) { results = document.createElement('div'); results.className = 'sale-product-results'; label.after(results); }
    results.id = 'orderProducts' + (++rowNumber);
    results.setAttribute('role', 'listbox');
    results.hidden = true;
    search.setAttribute('aria-controls', results.id);
    let active = -1, matches = [];
    const close = () => { results.hidden = true; search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant'); active = -1; };
    const selectedText = () => select.value ? select.options[select.selectedIndex].textContent : '';
    function syncSelection() {
      search.value = selectedText();
      search.setCustomValidity(select.value ? '' : '请从搜索结果中选择商品');
      close();
    }
    function choose(option) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const quantity = row.querySelector('[name="quantity"]');
      if (!quantity.value) quantity.value = '1';
      row.dispatchEvent(new Event('input', { bubbles: true }));
      quantity.focus(); quantity.select();
    }
    function show() {
      const query = search.value.trim().toLocaleLowerCase();
      const keyword = select.value && search.value === selectedText() ? '' : query;
      const all = Array.from(select.options).filter(option => option.value && (option.dataset.search || option.textContent).toLocaleLowerCase().includes(keyword));
      matches = all.slice(0, 20); active = -1;
      search.removeAttribute('aria-activedescendant');
      results.replaceChildren();
      matches.forEach((option, index) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'sale-product-option';
        button.id = results.id + '-' + index; button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.textContent = option.textContent + (option.dataset.sku ? ' · ' + option.dataset.sku : '');
        button.addEventListener('click', () => choose(option));
        results.appendChild(button);
      });
      if (!matches.length || all.length > 20) {
        const message = document.createElement('p');
        message.textContent = matches.length ? '显示前 20 项，请继续输入缩小范围' : '没有匹配的商品';
        results.appendChild(message);
      }
      results.hidden = false; search.setAttribute('aria-expanded', 'true');
    }
    search.addEventListener('focus', () => { if (select.value) search.select(); show(); });
    search.addEventListener('input', () => { select.value = ''; search.setCustomValidity('请从搜索结果中选择商品'); show(); });
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab') close();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (results.hidden) show();
        if (!matches.length) return;
        active = event.key === 'ArrowDown' ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
        Array.from(results.querySelectorAll('button')).forEach((button, index) => button.setAttribute('aria-selected', String(active === index)));
        const button = results.querySelectorAll('button')[active];
        search.setAttribute('aria-activedescendant', button.id); button.scrollIntoView({ block: 'nearest' });
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (results.hidden) show();
        const query = search.value.trim().toLocaleLowerCase();
        const exact = matches.filter(option => [option.dataset.name, option.dataset.sku, option.textContent].some(value => value && value.toLocaleLowerCase() === query));
        const option = active >= 0 ? matches[active] : exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
        if (option) choose(option);
      }
    });
    select.addEventListener('change', syncSelection);
    if (select.value) syncSelection();
    const labels = { quantity: ['数量', 'sale-qty-field'], unit_choice: ['单位', 'sale-unit-field'], unit_price: [select.closest('form').id === 'purchaseForm' ? '采购单价' : '单价', 'sale-price-field'] };
    for (const [name, [text, className]] of Object.entries(labels)) {
      const input = row.querySelector(`[name="${name}"]`); if (!input) continue;
      let wrapper = input.closest('label');
      if (!wrapper) { wrapper = document.createElement('label'); wrapper.textContent = text; input.before(wrapper); wrapper.appendChild(input); }
      wrapper.classList.add(className);
      if (input.type === 'number') { input.inputMode = name === 'quantity' ? 'numeric' : 'decimal'; input.step = name === 'quantity' ? '1' : '0.01'; input.min = name === 'quantity' ? '1' : '0'; }
      if (name === 'quantity') {
        const stepper = document.createElement('span'); stepper.className = 'quantity-stepper'; input.before(stepper); stepper.appendChild(input);
        for (const [change, text, accessible] of [[-1, '−', '减少数量'], [1, '+', '增加数量']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', accessible);
          button.addEventListener('click', () => { input.value = String(Math.max(1, (Number(input.value) || 0) + change)); input.dispatchEvent(new Event('input', { bubbles: true })); });
          if (change < 0) stepper.prepend(button); else stepper.appendChild(button);
        }
      }
    }
    row.querySelector('button.btn-danger')?.classList.add('sale-item-delete');
  }
  document.addEventListener('DOMContentLoaded', () => {
    const items = document.getElementById('items'); if (!items || !items.closest('form[data-order-draft]')) return;
    items.closest('form').querySelectorAll('input[type="number"]').forEach(input => { input.inputMode = input.step === '0.01' ? 'decimal' : 'numeric'; });
    const bind = () => items.querySelectorAll('.item-row').forEach(bindRow);
    bind(); new MutationObserver(bind).observe(items, { childList: true });
    const updateTotals = () => {
      const rows = Array.from(items.querySelectorAll('.item-row'));
      const total = rows.reduce((sum,row) => sum + (row.querySelector('.gift-checkbox')?.checked ? 0 : (Number(row.querySelector('[name="quantity"]').value)||0)*(Number(row.querySelector('[name="unit_price"]')?.value)||0)), 0);
      for (const id of ['itemsTotal','stickyItemsTotal']) {
        const element = document.getElementById(id);
        if (element) element.textContent = items.closest('form').id === 'transferForm' ? String(rows.filter(row => row.querySelector('[name="product_id"]').value).length) : Number.isFinite(total) ? total.toFixed(2) : '—';
      }
    };
    updateTotals(); new MutationObserver(updateTotals).observe(items, { childList: true });
    items.addEventListener('input', updateTotals); items.addEventListener('change', updateTotals);
    document.addEventListener('click', event => items.querySelectorAll('.sale-product-results').forEach(results => {
      if (!results.closest('.item-row').contains(event.target)) { results.hidden = true; results.closest('.item-row').querySelector('.product-search').setAttribute('aria-expanded', 'false'); }
    }));
    items.closest('form').addEventListener('submit', event => {
      if (event.defaultPrevented || items.querySelector('.item-row')) return;
      event.preventDefault(); window.addRow();
      items.querySelector('.product-search').focus(); items.querySelector('.product-search').reportValidity();
    });
  });
})();
