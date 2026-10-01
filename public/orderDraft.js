(() => {
  const fields = ['customer_id','customer_search','supplier_id','warehouse_id','from_warehouse_id','to_warehouse_id','order_date','paid_amount','refunded_amount','remarks','note','related_sales_order_id','draft_revision','_request_key','exception_reason'];
  const expiry = 7 * 86400000;
  const prefix = 'jxc-order-draft:v1:';
  function entries(scope) {
    const found = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key.startsWith(prefix + scope + ':')) continue;
      try {
        const draft = JSON.parse(localStorage.getItem(key));
        if (!draft || draft.version !== 1 || Date.now() - draft.savedAt > expiry || !Array.isArray(draft.rows)) localStorage.removeItem(key);
        else found.push({ key, ...draft });
      } catch (_) { localStorage.removeItem(key); }
    }
    return found.sort((a,b) => b.savedAt-a.savedAt);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const meta = document.querySelector('meta[name="order-draft-context"]'); if (!meta) return;
    let context; try { context = JSON.parse(meta.content); } catch (_) { return; }
    if (!context.scope) return;
    let storageOK = true;
    try {
      for (const entry of entries(context.scope)) if ((context.completed || []).includes(entry.values?._request_key)) localStorage.removeItem(entry.key);
    } catch (_) { storageOK = false; }
    const form = document.querySelector('form[data-order-draft]'); if (!form) return;
    const path = new URL(form.action).pathname;
    const products = Array.from(form.querySelector('[name="product_id"]')?.options || []);
    const initialRevision = form.elements.namedItem('draft_revision')?.value;
    const panel = document.createElement('section'); panel.className = 'draft-panel'; panel.setAttribute('aria-label','本机暂存');
    const status = document.createElement('p'); status.setAttribute('role','status'); status.textContent = storageOK ? '填写内容自动暂存在本机，保留 7 天；共用设备请及时清除。' : '本机存储不可用，请使用“存草稿”保存到服务器。';
    const list = document.createElement('div'); list.className = 'draft-recovery-list';
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn btn-secondary btn-sm'; clear.textContent = '清除当前本机暂存'; clear.hidden = true;
    panel.append(status,list,clear); form.before(panel);
    let dirty = false, saved = false, submitting = false, restoring = false, timer;
    let storageKey = prefix + context.scope + ':' + form.elements.namedItem('_request_key').value;
    let candidates = [];
    function capture() {
      const values = {};
      for (const name of fields) { const input = form.elements.namedItem(name); if (input && 'value' in input) values[name] = input.value; }
      const labels = {};
      for (const name of ['customer_id','supplier_id','warehouse_id','from_warehouse_id','to_warehouse_id']) {
        const input = form.elements.namedItem(name);
        if (input?.selectedOptions?.[0]) labels[name] = input.selectedOptions[0].textContent;
      }
      const rows = Array.from(form.querySelectorAll('#items .item-row')).map(row => ({
        id: row.querySelector('[name="product_id"]').value,
        original_sales_item_id: row.querySelector('[name="original_sales_item_id"]')?.value || null,
        quantity: row.querySelector('[name="quantity"]').value,
        unit_choice: row.querySelector('[name="unit_choice"]').value,
        unit_label: row.querySelector('[name="unit_choice"]').selectedOptions[0]?.textContent || '',
        unit_size: row.querySelector('[name="unit_choice"]').value === 'pack' ? Number(row.querySelector('[name="product_id"]').selectedOptions[0]?.dataset.packSize || 1) : 1,
        price: row.querySelector('[name="unit_price"]')?.value ?? '',
        is_gift: !!row.querySelector('.gift-checkbox')?.checked,
        search: row.querySelector('.product-search')?.value || ''
      }));
      return { version: 1, route: path, savedAt: Date.now(), values, labels, rows };
    }
    function save() {
      if (!dirty || restoring) return;
      try {
        storageKey = prefix + context.scope + ':' + form.elements.namedItem('_request_key').value;
        localStorage.setItem(storageKey, JSON.stringify(capture()));
        saved = true; clear.hidden = false;
        status.textContent = '已暂存本机 · ' + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) + '（尚未保存到服务器）';
      } catch (_) { saved = false; status.textContent = '本机暂存失败，请尽快联网并保存草稿，离开前不要关闭页面。'; }
    }
    function changed() { if (restoring) return; dirty = true; saved = false; clearTimeout(timer); timer = setTimeout(save, 200); }
    function preview(entry, container) {
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '查看暂存内容'; details.appendChild(summary);
      for (const [name, label] of Object.entries(entry.labels || {})) {
        const line = document.createElement('p'); line.textContent = ({customer_id:'客户',supplier_id:'供应商',warehouse_id:'仓库',from_warehouse_id:'调出仓库',to_warehouse_id:'调入仓库'})[name] + '：' + label; details.appendChild(line);
      }
      for (const name of ['customer_search','order_date','paid_amount','refunded_amount','remarks','note']) {
        if (!entry.values[name]) continue;
        const line = document.createElement('p'); line.textContent = ({customer_search:'客户',order_date:'日期',paid_amount:'收款',refunded_amount:'退款',remarks:'备注',note:entry.route.startsWith('/purchases/') ? '备注' : '内部备注'})[name] + '：' + entry.values[name]; details.appendChild(line);
      }
      entry.rows.forEach(row => { const line = document.createElement('p'); line.textContent = `${row.search || '商品 #'+row.id} · 数量 ${row.quantity || '未填'} ${row.unit_label || (row.unit_choice === 'pack' ? '整包单位' : '基本单位')}${row.unit_size > 1 ? '（每份 '+row.unit_size+' 个基本单位）' : ''}${entry.route.startsWith('/transfers/') ? '' : ' · 单价 '+(row.price || '未填')}${row.is_gift ? ' · 赠品' : ''}`; details.appendChild(line); });
      container.appendChild(details);
    }
    function restore(entry) {
      if (initialRevision != null && entry.values.draft_revision !== initialRevision) {
        status.textContent = '服务器草稿已更新，这份旧暂存仅供核对。请查看暂存内容，再在当前草稿中重新填写需要保留的部分。'; return;
      }
      if (entry.rows.some(item => item.id && !products.some(option => option.value === item.id))) {
        status.textContent = '暂存中的商品已不可选，请查看暂存内容，重新选择当前可用商品。'; return;
      }
      if (entry.rows.some(item => item.id && !item.original_sales_item_id && item.unit_size != null && item.unit_size !== (item.unit_choice === 'pack' ? Number(products.find(option => option.value === item.id)?.dataset.packSize || 1) : 1))) {
        status.textContent = '商品箱规已变化，这份暂存仅供核对。请查看暂存内容，按当前箱规重新填写。'; return;
      }
      if (window.returnSourceSaleId && Number(entry.values.related_sales_order_id) !== window.returnSourceSaleId) {
        status.textContent = '这份退货暂存属于另一张原销售单，请从对应原单打开退货页面后恢复。'; return;
      }
      restoring = true;
      for (const name of fields) {
        if (entry.values[name] == null) continue;
        const input = form.elements.namedItem(name); if (input && 'value' in input) input.value = entry.values[name];
      }
      form.querySelector('#items').replaceChildren();
      for (const item of entry.rows) {
        window.addRow({ ...item });
        const row = form.querySelector('#items').lastElementChild, select = row.querySelector('[name="product_id"]');
        select.value = item.id; select.dispatchEvent(new Event('change',{bubbles:true}));
        row.querySelector('[name="unit_choice"]').value = item.unit_choice;
        row.querySelector('[name="quantity"]').value = item.quantity;
        const price = row.querySelector('[name="unit_price"]'); if (price) price.value = item.is_gift ? '0' : item.price;
        if (typeof window.restoreReturnRow === 'function') window.restoreReturnRow(row, item);
        const search = row.querySelector('.product-search'); if (search) { search.value = item.search; search.setCustomValidity(select.value ? '' : '请从搜索结果中选择商品'); }
      }
      if (!entry.rows.length) window.addRow();
      form.dispatchEvent(new Event('draft-restored'));
      if (typeof window.recalcTotal === 'function') window.recalcTotal();
      storageKey = entry.key; observer.takeRecords(); restoring = false; dirty = true; save();
      status.textContent = '已恢复本机暂存，请核对客户、仓库、商品和金额后再保存。';
      list.replaceChildren();
    }
    async function checkCompleted(entry) {
      const response = await fetch('/drafts/result?' + new URLSearchParams({key:entry.values._request_key,route:entry.route}), {cache:'no-store'});
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('无法确认保存结果');
      return response.json();
    }
    async function showCandidates() {
      try { candidates = entries(context.scope).filter(entry => entry.route === path); }
      catch (_) { return; }
      // 服务端报错页面已保留本次填写，不再用较旧内容覆盖。
      const own = candidates.find(entry => entry.values._request_key === form.elements.namedItem('_request_key').value);
      if (own) { dirty = true; saved = true; clear.hidden = false; status.textContent = '提交未成功，填写内容仍保留在当前页面和本机。请修正后重试。'; }
      for (const entry of candidates.filter(item => item !== own)) {
        const card = document.createElement('div'); card.className = 'draft-recovery';
        const label = document.createElement('p'); label.textContent = '发现未完成内容 · ' + new Date(entry.savedAt).toLocaleString('zh-CN') + (entry.values.customer_search ? ' · '+entry.values.customer_search : '');
        const recover = document.createElement('button'); recover.type = 'button'; recover.className = 'btn btn-sm'; recover.textContent = '恢复填写';
        const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn btn-secondary btn-sm'; discard.textContent = '丢弃这份暂存';
        card.append(label,recover,discard); preview(entry,card); list.appendChild(card);
        discard.addEventListener('click', () => { try { localStorage.removeItem(entry.key); card.remove(); } catch (_) { status.textContent='无法清除本机暂存'; } });
        recover.addEventListener('click', async () => {
          recover.disabled = true;
          try {
            const result = await checkCompleted(entry);
            if (result.completed) {
              localStorage.removeItem(entry.key); card.replaceChildren();
              const message = document.createElement('p'); message.textContent = '这份内容已经保存成功，无需再次提交。';
              const link = document.createElement('a'); link.textContent = '查看已保存单据'; link.href = result.redirect; card.append(message,link);
            } else restore(entry);
          } catch (_) { status.textContent = '暂时无法确认是否已保存，请联网后再恢复。暂存内容仍保留，可展开查看。'; }
          finally { recover.disabled = false; }
        });
        try {
          const result = await checkCompleted(entry);
          if (result.completed) { localStorage.removeItem(entry.key); card.remove(); }
        } catch (_) { /* 断网时保留可查看的内容，联网后恢复会再次检查。 */ }
      }
    }
    clear.addEventListener('click', () => { try { localStorage.removeItem(storageKey); clearTimeout(timer); dirty = false; saved = false; clear.hidden = true; status.textContent='已清除当前本机暂存，表单内容仍保留。'; } catch (_) { status.textContent='无法清除本机暂存'; } });
    form.addEventListener('input', changed); form.addEventListener('change', changed); form.addEventListener('order-form-change', changed);
    const observer = new MutationObserver(changed);
    observer.observe(form.querySelector('#items'), { childList:true });
    form.addEventListener('submit', event => {
      if (event.defaultPrevented) return;
      dirty = true; clearTimeout(timer); save();
      if (navigator.onLine === false) { event.preventDefault(); status.textContent = '网络已断开，内容已暂存本机；联网后再保存。'; return; }
      submitting = true;
    });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
    window.addEventListener('beforeunload', event => { save(); if (dirty && !saved && !submitting) { event.preventDefault(); event.returnValue=''; } });
    window.addEventListener('pageshow', () => { submitting = false; });
    showCandidates();
  });
})();
