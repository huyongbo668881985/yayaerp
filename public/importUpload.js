document.addEventListener('DOMContentLoaded',()=>{
  const form=document.getElementById('importUpload');if(!form)return;
  let working=false;
  // 捕获阶段阻止普通提交；csrf.js 的重复提交锁会看到 defaultPrevented。
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(working)return;
    const status=document.getElementById('importStatus'),file=document.getElementById('importFile').files[0];
    if(!file || file.size>1024*1024){status.textContent='请选择不超过 1 MB 的 .xlsx 或 .csv 文件。';return;}
    working=true;const button=form.querySelector('button[type="submit"]');button.disabled=true;status.textContent='正在上传并校验，请稍候…';
    try {
      const response=await fetch('/imports/'+document.getElementById('importKind').value+'/preview',{method:'POST',headers:{'X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content},body:new FormData(form)});
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('登录状态已变化或上传未完成，请重新登录后重试。');
      const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');
      window.location.assign(result.redirect);
    }catch(error){status.textContent=error.message||'网络连接失败，请重试。';working=false;button.disabled=false;}
  },true);
});
