document.addEventListener('DOMContentLoaded',()=>{
  const layout=document.getElementById('printLayout');
  layout.addEventListener('change',()=>{
    document.documentElement.classList.toggle('receipt',layout.value==='receipt');
    document.getElementById('paperSize').textContent=layout.value==='receipt'?'@page { size: 80mm 200mm; margin: 4mm; }':'@page { size: A4; margin: 12mm; }';
    document.getElementById('printHint').textContent=layout.value==='receipt'?'80mm 票据使用 80 × 200mm 纸张；请在打印窗口匹配纸张，并关闭页眉页脚。':'建议关闭打印页眉页脚；核对后打印或保存为 PDF。';
  });
  document.getElementById('printButton').addEventListener('click',()=>window.print());
});
