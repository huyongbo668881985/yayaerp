// 动态明细行的商品搜索。保留原始 option 节点的数据属性，筛选后仍交给原表单处理单位与价格。
const productOptionCache = new WeakMap();
function filterProductOptions(input) {
  const select = input.nextElementSibling;
  if (!select) return;
  if (!productOptionCache.has(select)) {
    productOptionCache.set(select, Array.from(select.options).map(option => option.cloneNode(true)));
  }
  const original = productOptionCache.get(select);
  const keyword = input.value.trim().toLocaleLowerCase();
  const selected = select.value;
  const visible = original.filter((option, index) => index === 0 || !keyword ||
    (option.dataset.search || option.textContent).toLocaleLowerCase().includes(keyword));
  select.replaceChildren(...visible.map(option => option.cloneNode(true)));
  if (visible.some(option => option.value === selected)) select.value = selected;
  else select.value = '';
  if (select.value !== selected) select.dispatchEvent(new Event('change', { bubbles: true }));
}
