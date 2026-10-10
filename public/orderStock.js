document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('saleForm'); if (!form) return;
  let revision = 0, timer;
  const update = async () => {
    const current = ++revision, warehouse = form.elements.namedItem('warehouse_id').value;
    const rows = Array.from(form.querySelectorAll('.item-row'));
    // 合并同一商品的多行，避免每行都够、合计却超库存的误导。
    const requested = new Map();
    for (const row of rows) {
      const select = row.querySelector('[name="product_id"]'), option = select.selectedOptions[0];
      const pack = row.querySelector('[name="unit_choice"]').value === 'pack';
      const qty = Number(row.querySelector('[name="quantity"]').value) || 0;
      requested.set(select.value, (requested.get(select.value) || 0) + qty * (pack ? Number(option?.dataset.packSize || 1) : 1));
    }
    await Promise.all(rows.map(async row => {
      let hint = row.querySelector('.stock-hint');
      if (!hint) { hint = document.createElement('p'); hint.className = 'stock-hint'; hint.setAttribute('role', 'status'); row.appendChild(hint); }
      const product = row.querySelector('[name="product_id"]').value;
      if (!product || !warehouse) { hint.textContent = ''; return; }
      try {
        const response = await fetch('/order-options/stock?' + new URLSearchParams({ warehouse_id: warehouse, product_id: product }), { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const stock = await response.json(); if (current !== revision || !row.isConnected) return;
        const insufficient = requested.get(product) > stock.quantity;
        hint.classList.toggle('insufficient', insufficient);
        hint.textContent = `当前库存 ${stock.quantity}${stock.unit}` + (stock.pack_unit ? ` · 1${stock.pack_unit}=${stock.pack_size}${stock.unit}` : '') + ` · 本单合计 ${requested.get(product)}${stock.unit}` + (insufficient ? ' · 库存不足，审核时需补足' : ' · 以审核时库存为准');
      } catch (_) { if (current === revision) { hint.classList.remove('insufficient'); hint.textContent = '库存暂不可用，请在审核前核对'; } }
    }));
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 180); };
  form.addEventListener('input', schedule); form.addEventListener('change', schedule); form.addEventListener('draft-restored', schedule);
  new MutationObserver(schedule).observe(document.getElementById('items'), { childList: true }); schedule();
  fetch('/order-options/products?recent=1', { cache: 'no-store' }).then(response => response.ok ? response.json() : {products: []}).then(data => {
    const container = document.getElementById('recentProducts'); if (!data.products.length) return;
    const label = document.createElement('span'); label.className = 'muted'; label.textContent = '最近使用：'; container.appendChild(label);
    for (const product of data.products) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary btn-sm'; button.textContent = product.name;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const available = await window.prepareSaleProducts([product.id]);
          const current = available.find(item => item.id === product.id);
          if (!current) throw new Error();
          const emptyRow = Array.from(form.querySelectorAll('.item-row')).find(row =>
            !row.querySelector('[name="product_id"]').value && !row.querySelector('[name="quantity"]').value && !row.querySelector('[name="unit_price"]').value);
          emptyRow?.remove();
          window.addRow({ id: current.id, quantity: 1, unit_choice: 'base', price: current.sale_price });
          form.dispatchEvent(new Event('order-form-change')); schedule();
        } catch (_) { label.setAttribute('role', 'alert'); label.textContent = '商品暂不可用，请重试：'; }
        finally { button.disabled = false; }
      }); container.appendChild(button);
    }
  }).catch(() => {});
});
