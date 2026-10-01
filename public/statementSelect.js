document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-statement-selector]').forEach(form=>form.addEventListener('submit',()=>{form.action='/reconciliation/'+form.dataset.statementSelector+'/'+form.querySelector('[data-partner-id]').value;}));
});
