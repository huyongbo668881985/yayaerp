'use strict';

(function () {
  const configEl = document.getElementById('aiAssistantConfig');
  const config = configEl ? JSON.parse(configEl.textContent || '{}') : {};

  const storePickerEl = document.getElementById('aiStorePicker');
  const customerSearchInput = document.getElementById('aiCustomerSearchInput');
  const customerResetGlobalBtn = document.getElementById('aiCustomerResetGlobalBtn');
  const customerDropdown = document.getElementById('aiCustomerDropdown');
  const customerSelect = document.getElementById('aiCustomerSelect');
  const daysSelect = document.getElementById('aiDaysSelect');
  const newChatBtn = document.getElementById('aiNewChatBtn');
  const historyToggleBtn = document.getElementById('aiHistoryToggleBtn');
  const historyCountEl = document.getElementById('aiHistoryCount');
  const historyPanel = document.getElementById('aiHistoryPanel');
  const historyListEl = document.getElementById('aiHistoryList');
  const clearAllHistoryBtn = document.getElementById('aiClearAllHistoryBtn');
  const historyCloseBtn = document.getElementById('aiHistoryCloseBtn');

  const chipsLabel = document.getElementById('aiChipsLabel');
  const chipsContainer = document.getElementById('aiChipsContainer');
  const messagesEl = document.getElementById('aiMessages');
  const emptyStateEl = document.getElementById('aiEmptyState');
  const chatForm = document.getElementById('aiChatForm');
  const inputEl = document.getElementById('aiInput');
  const sendBtn = document.getElementById('aiSendBtn');
  const lightbox = document.getElementById('aiLightbox');
  const lightboxImg = document.getElementById('aiLightboxImg');

  let chatHistory = [];
  let currentSessionId = null;
  let sessionsList = Array.isArray(config.sessions) ? config.sessions : [];
  let isBusy = false;

  // 提取所有门店选项供前端实时搜索过滤
  const allStoreOptions = Array.from(customerSelect.options)
    .filter(opt => opt.value !== '')
    .map(opt => ({
      id: String(opt.value),
      name: opt.getAttribute('data-name') || opt.textContent.trim(),
      operator: opt.getAttribute('data-operator') || '',
      label: opt.textContent.trim(),
      searchKey: `${opt.getAttribute('data-name') || ''} ${opt.getAttribute('data-operator') || ''} ${opt.textContent || ''}`.toLowerCase()
    }));

  let activeDropdownIdx = -1;
  let currentMatchedStores = [];

  const GLOBAL_PROMPTS = config.shelfguardEnabled
    ? [
        '📉 近期销量下滑最严重的门店是哪些？结合巡检拜访和陈列分析可能原因',
        '⚠️ 哪些门店当前应收欠款较高，但近期巡检拜访次数不足？',
        '🏆 对比一下各业务员的净销售额、应收回款与门店拜访陈列质量',
        '📊 汇总公司近期的整体销售额、毛利表现与终端巡检覆盖率'
      ]
    : [
        '📉 近期销量下滑最严重的门店是哪些？分析可能原因',
        '⚠️ 当前应收欠款最高的门店有哪些？回款风险如何？',
        '🏆 对比一下各业务员近期的净销售额与名下未结清欠款',
        '📊 汇总公司近期的整体净销售额、毛利与退货情况'
      ];

  function getStorePrompts(storeName) {
    const label = storeName ? `「${storeName}」` : '这家店';
    if (config.shelfguardEnabled) {
      return [
        `🔍 综合诊断${label}最近的销售表现、毛利、停拿品种与终端陈列情况`,
        `📦 ${label}最近有哪些常拿的商品停止拿货或货架排面缺失？`,
        `💰 分析${label}的拿货频次、退货情况与当前应收欠款风险`,
        `📸 查看${label}最近的巡检陈列评分与存在的主要陈列问题`
      ];
    }
    return [
      `🔍 综合诊断${label}最近的销售额环比、毛利与拿货结构`,
      `📦 ${label}最近有哪些以前常拿的商品停止拿货了？`,
      `💰 分析${label}的拿货频次、退货情况与当前应收欠款风险`
    ];
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getCsrfToken() {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    return csrfMeta ? csrfMeta.content : '';
  }

  function formatDateTimeShort(raw) {
    if (!raw) return '';
    const iso = String(raw).includes('T') ? String(raw) : String(raw).replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function renderMarkdown(mdText) {
    const lines = String(mdText || '').split(/\r?\n/);
    const html = [];
    let inUl = false;
    let inOl = false;

    function closeLists() {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (inOl) { html.push('</ol>'); inOl = false; }
    }

    function inlineFormat(text) {
      let safe = escapeHtml(text);
      safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
      return safe;
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeLists();
        continue;
      }
      if (line.startsWith('### ')) {
        closeLists();
        html.push(`<h3>${inlineFormat(line.slice(4))}</h3>`);
      } else if (line.startsWith('#### ')) {
        closeLists();
        html.push(`<h4>${inlineFormat(line.slice(5))}</h4>`);
      } else if (line.startsWith('## ')) {
        closeLists();
        html.push(`<h3>${inlineFormat(line.slice(3))}</h3>`);
      } else if (line.startsWith('> ')) {
        closeLists();
        html.push(`<blockquote>${inlineFormat(line.slice(2))}</blockquote>`);
      } else if (/^[-*]\s+/.test(line)) {
        if (inOl) { html.push('</ol>'); inOl = false; }
        if (!inUl) { html.push('<ul>'); inUl = true; }
        html.push(`<li>${inlineFormat(line.replace(/^[-*]\s+/, ''))}</li>`);
      } else if (/^\d+\.\s+/.test(line)) {
        if (inUl) { html.push('</ul>'); inUl = false; }
        if (!inOl) { html.push('<ol>'); inOl = true; }
        html.push(`<li>${inlineFormat(line.replace(/^\d+\.\s+/, ''))}</li>`);
      } else {
        closeLists();
        html.push(`<p>${inlineFormat(line)}</p>`);
      }
    }
    closeLists();
    return html.join('');
  }

  function renderEvidenceCards(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    return `<div class="ai-evidence-grid">${cards.map(card => {
      const linksHtml = Array.isArray(card.links) && card.links.length > 0
        ? `<div class="ai-evidence-links">${card.links.map(l => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)} →</a>`).join('')}</div>`
        : '';
      const metricsHtml = Array.isArray(card.metrics) && card.metrics.length > 0
        ? `<div class="ai-metrics-row">${card.metrics.map(m => `
            <div class="ai-metric-box">
              <div class="ai-metric-label">${escapeHtml(m.label)}</div>
              <div class="ai-metric-value">${escapeHtml(m.value)}</div>
              <div class="ai-metric-sub">${escapeHtml(m.sub || '')}</div>
            </div>
          `).join('')}</div>`
        : '';
      const stoppedHtml = Array.isArray(card.stoppedProducts) && card.stoppedProducts.length > 0
        ? `<div class="ai-stopped-alert">⚠️ 本期停拿品种（上期曾拿货，本期为 0）：<strong>${escapeHtml(card.stoppedProducts.join('、'))}</strong></div>`
        : '';
      const photosHtml = Array.isArray(card.photos) && card.photos.length > 0
        ? `<div class="ai-photo-strip">${card.photos.map(p => `
            <div class="ai-photo-item">
              <img src="${escapeHtml(p.url)}" alt="巡检照片" width="120" height="90" loading="lazy" data-full-src="${escapeHtml(p.url)}">
              <div class="ai-photo-caption" title="${escapeHtml(p.summary || '')}">${escapeHtml(p.date)} ${p.score != null ? p.score + '分' : ''}</div>
            </div>
          `).join('')}</div>`
        : '';

      return `
        <div class="ai-evidence-card">
          <div class="ai-evidence-header">
            <span>${escapeHtml(card.title || '数据摘要')}</span>
            ${linksHtml}
          </div>
          ${metricsHtml}
          ${stoppedHtml}
          ${photosHtml}
        </div>
      `;
    }).join('')}</div>`;
  }

  // ===== 可搜索门店选择器逻辑 =====
  function getSelectedStoreName() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    return opt && opt.value ? (opt.getAttribute('data-name') || opt.textContent.trim()) : '';
  }

  function getSelectedStoreDisplayLabel() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    if (!opt || !opt.value) return '';
    return `🏪 ${opt.textContent.trim()}`;
  }

  function syncStoreInputDisplay() {
    if (customerSelect.value) {
      customerSearchInput.value = getSelectedStoreDisplayLabel();
      customerResetGlobalBtn.hidden = false;
    } else {
      customerSearchInput.value = '';
      customerResetGlobalBtn.hidden = true;
    }
  }

  function closeStoreDropdown() {
    customerDropdown.hidden = true;
    customerSearchInput.setAttribute('aria-expanded', 'false');
    activeDropdownIdx = -1;
  }

  function selectStoreValue(val) {
    customerSelect.value = val ? String(val) : '';
    syncStoreInputDisplay();
    closeStoreDropdown();
    renderChips();
  }

  function renderStoreDropdown(filterQuery) {
    const q = String(filterQuery || '').trim().toLowerCase();
    // 如果当前输入框显示的就是已选门店完整标签，则展开时展示全部以便切换
    const effectiveQuery = (customerSelect.value && customerSearchInput.value === getSelectedStoreDisplayLabel())
      ? ''
      : q;

    const matched = effectiveQuery
      ? allStoreOptions.filter(s => s.searchKey.includes(effectiveQuery)).slice(0, 60)
      : allStoreOptions.slice(0, 80);

    currentMatchedStores = [{ id: '', name: '全局视角（全部门店排行与对比）', operator: '' }, ...matched];
    activeDropdownIdx = -1;

    customerDropdown.innerHTML = '';
    currentMatchedStores.forEach((item, idx) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = String(customerSelect.value || '') === String(item.id);
      btn.className = 'ai-store-option' + (isSelected ? ' selected' : '');
      btn.dataset.index = String(idx);
      if (item.id === '') {
        btn.innerHTML = `<span>🏢 全局视角（全部门店排行与对比）</span><span class="ai-store-option-op">全公司汇总</span>`;
      } else {
        btn.innerHTML = `<span>🏪 ${escapeHtml(item.name)}</span><span class="ai-store-option-op">${escapeHtml(item.operator ? '业务员：' + item.operator : '')}</span>`;
      }
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        selectStoreValue(item.id);
      });
      li.appendChild(btn);
      customerDropdown.appendChild(li);
    });

    if (effectiveQuery && matched.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'ai-store-empty';
      emptyLi.textContent = `未找到匹配「${filterQuery}」的门店，可尝试输入部分关键字或业务员姓名`;
      customerDropdown.appendChild(emptyLi);
    }

    customerDropdown.hidden = false;
    customerSearchInput.setAttribute('aria-expanded', 'true');
  }

  function highlightDropdownOption(newIdx) {
    const buttons = Array.from(customerDropdown.querySelectorAll('.ai-store-option'));
    if (!buttons.length) return;
    if (newIdx < 0) newIdx = buttons.length - 1;
    if (newIdx >= buttons.length) newIdx = 0;
    activeDropdownIdx = newIdx;
    buttons.forEach((b, i) => {
      b.classList.toggle('active', i === activeDropdownIdx);
    });
    buttons[activeDropdownIdx].scrollIntoView({ block: 'nearest' });
  }

  customerSearchInput.addEventListener('focus', () => {
    if (customerSelect.value && customerSearchInput.value === getSelectedStoreDisplayLabel()) {
      customerSearchInput.select();
    }
    renderStoreDropdown(customerSearchInput.value);
  });

  customerSearchInput.addEventListener('input', () => {
    renderStoreDropdown(customerSearchInput.value);
  });

  customerSearchInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (customerDropdown.hidden) renderStoreDropdown(customerSearchInput.value);
      highlightDropdownOption(activeDropdownIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (customerDropdown.hidden) renderStoreDropdown(customerSearchInput.value);
      highlightDropdownOption(activeDropdownIdx - 1);
    } else if (e.key === 'Enter') {
      if (!customerDropdown.hidden && activeDropdownIdx >= 0 && currentMatchedStores[activeDropdownIdx]) {
        e.preventDefault();
        selectStoreValue(currentMatchedStores[activeDropdownIdx].id);
      } else if (!customerDropdown.hidden && currentMatchedStores.length === 2 && customerSearchInput.value.trim()) {
        // 唯一匹配门店时按回车直接选中
        e.preventDefault();
        selectStoreValue(currentMatchedStores[1].id);
      }
    } else if (e.key === 'Escape') {
      syncStoreInputDisplay();
      closeStoreDropdown();
    }
  });

  customerSearchInput.addEventListener('blur', () => {
    setTimeout(() => {
      syncStoreInputDisplay();
      closeStoreDropdown();
    }, 150);
  });

  customerResetGlobalBtn.addEventListener('click', () => {
    selectStoreValue('');
  });

  document.addEventListener('click', e => {
    if (storePickerEl && !storePickerEl.contains(e.target)) {
      closeStoreDropdown();
    }
  });

  // ===== 快捷提问 Chips =====
  function renderChips() {
    const storeName = getSelectedStoreName();
    chipsLabel.textContent = storeName
      ? `💡 已选门店「${storeName}」，点击下方快捷问题立即诊断：`
      : '💡 全局视角，点击下方快捷问题立即诊断：';

    const prompts = storeName ? getStorePrompts(storeName) : GLOBAL_PROMPTS;
    chipsContainer.innerHTML = '';
    prompts.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-chip-btn';
      btn.disabled = isBusy;
      btn.textContent = p;
      btn.addEventListener('click', () => {
        if (!isBusy) sendMessage(p);
      });
      chipsContainer.appendChild(btn);
    });
  }

  function setBusyState(busy) {
    isBusy = busy;
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? '诊断中…' : '发送诊断';
    Array.from(chipsContainer.querySelectorAll('button')).forEach(b => {
      b.disabled = busy;
    });
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function bindBubbleInteractions(bubbleEl, rawAnswerText) {
    const copyBtn = bubbleEl.querySelector('.ai-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(rawAnswerText);
          copyBtn.textContent = '✓ 已复制';
          setTimeout(() => { copyBtn.textContent = '📋 复制诊断结果'; }, 1800);
        } catch (_) {
          copyBtn.textContent = '复制失败';
        }
      });
    }
    Array.from(bubbleEl.querySelectorAll('img[data-full-src]')).forEach(img => {
      img.addEventListener('click', () => {
        lightboxImg.src = img.getAttribute('data-full-src');
        lightbox.classList.add('open');
      });
    });
  }

  function appendUserBubble(text) {
    const userMsgEl = document.createElement('div');
    userMsgEl.className = 'ai-msg ai-msg-user';
    userMsgEl.innerHTML = `<div class="ai-bubble-user">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(userMsgEl);
  }

  function appendAssistantBubble(answer, cards) {
    const assistantMsgEl = document.createElement('div');
    assistantMsgEl.className = 'ai-msg ai-msg-assistant';
    const cardsHtml = renderEvidenceCards(cards);
    const mdHtml = renderMarkdown(answer);
    assistantMsgEl.innerHTML = `
      <div class="ai-bubble-assistant">
        ${cardsHtml}
        <div class="ai-markdown-body">${mdHtml}</div>
        <div class="ai-msg-actions">
          <button type="button" class="btn btn-secondary btn-sm ai-copy-btn">📋 复制诊断结果</button>
        </div>
      </div>
    `;
    messagesEl.appendChild(assistantMsgEl);
    bindBubbleInteractions(assistantMsgEl.querySelector('.ai-bubble-assistant'), answer);
  }

  // ===== 历史对话列表与会话切换 =====
  function renderHistoryList() {
    if (historyCountEl) {
      historyCountEl.textContent = String(sessionsList.length);
    }
    if (!historyListEl) return;
    historyListEl.innerHTML = '';

    if (sessionsList.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'ai-history-empty';
      emptyLi.textContent = '暂无历史对话记录，发起提问后会自动保存在这里。';
      historyListEl.appendChild(emptyLi);
      return;
    }

    sessionsList.forEach(s => {
      const li = document.createElement('li');
      li.className = 'ai-history-item' + (Number(currentSessionId) === Number(s.id) ? ' active' : '');

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'ai-history-select-btn';
      const scopeTag = s.customerName ? `🏪 ${s.customerName}` : '🏢 全局视角';
      const rounds = Math.max(1, Math.ceil((s.messageCount || 2) / 2));
      selectBtn.innerHTML = `
        <div class="ai-history-item-title">${escapeHtml(s.title || '经营诊断对话')}</div>
        <div class="ai-history-item-meta">
          <span>${escapeHtml(scopeTag)}</span>
          <span>近 ${escapeHtml(s.days || 90)} 天</span>
          <span>${rounds} 轮问答</span>
          <span>${escapeHtml(formatDateTimeShort(s.updatedAt))}</span>
        </div>
      `;
      selectBtn.addEventListener('click', () => {
        loadSessionById(s.id);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-secondary btn-sm';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        deleteSessionById(s.id);
      });

      li.appendChild(selectBtn);
      li.appendChild(delBtn);
      historyListEl.appendChild(li);
    });
  }

  function applyLoadedSession(session) {
    if (!session) return;
    currentSessionId = session.id;
    chatHistory = [];
    Array.from(messagesEl.querySelectorAll('.ai-msg')).forEach(el => el.remove());

    if (session.customerId && Array.from(customerSelect.options).some(o => Number(o.value) === Number(session.customerId))) {
      customerSelect.value = String(session.customerId);
    } else {
      customerSelect.value = '';
    }
    syncStoreInputDisplay();

    if (session.days && Array.from(daysSelect.options).some(o => Number(o.value) === Number(session.days))) {
      daysSelect.value = String(session.days);
    }
    renderChips();

    const msgs = Array.isArray(session.messages) ? session.messages : [];
    if (msgs.length === 0) {
      if (emptyStateEl) emptyStateEl.style.display = '';
    } else {
      if (emptyStateEl) emptyStateEl.style.display = 'none';
      msgs.forEach(m => {
        if (m.role === 'user') {
          appendUserBubble(m.content);
        } else if (m.role === 'assistant') {
          appendAssistantBubble(m.content, m.cards || []);
        }
        chatHistory.push({ role: m.role, content: m.content });
      });
      scrollToBottom();
    }

    renderHistoryList();
  }

  function startNewChat() {
    if (isBusy) return;
    currentSessionId = null;
    chatHistory = [];
    Array.from(messagesEl.querySelectorAll('.ai-msg')).forEach(el => el.remove());
    if (emptyStateEl) emptyStateEl.style.display = '';
    renderHistoryList();
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '/ai-assistant');
    }
  }

  async function loadSessionById(sessionId) {
    if (isBusy || !sessionId) return;
    try {
      const res = await fetch(`/ai-assistant/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Accept: 'application/json' }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.session) return;
      applyLoadedSession(data.session);
      if (historyPanel && !historyPanel.hidden) {
        historyPanel.hidden = true;
        historyToggleBtn.setAttribute('aria-expanded', 'false');
      }
    } catch (_) {}
  }

  async function deleteSessionById(sessionId) {
    if (!sessionId) return;
    try {
      const res = await fetch(`/ai-assistant/sessions/${encodeURIComponent(sessionId)}/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        sessionsList = Array.isArray(data.sessions) ? data.sessions : [];
        if (Number(currentSessionId) === Number(sessionId)) {
          startNewChat();
        } else {
          renderHistoryList();
        }
      }
    } catch (_) {}
  }

  async function clearAllSessions() {
    if (sessionsList.length === 0) return;
    if (!window.confirm('确定要清空您名下的全部历史诊断对话吗？')) return;
    try {
      const res = await fetch('/ai-assistant/sessions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        sessionsList = [];
        startNewChat();
      }
    } catch (_) {}
  }

  // ===== 发送提问与流式渲染 =====
  async function sendMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text || isBusy) return;

    if (emptyStateEl) emptyStateEl.style.display = 'none';
    inputEl.value = '';
    setBusyState(true);

    appendUserBubble(text);

    const assistantMsgEl = document.createElement('div');
    assistantMsgEl.className = 'ai-msg ai-msg-assistant';
    assistantMsgEl.innerHTML = `
      <div class="ai-bubble-assistant">
        <div class="ai-status-step">⏳ 正在连接数据工具准备诊断…</div>
      </div>
    `;
    messagesEl.appendChild(assistantMsgEl);
    scrollToBottom();

    const bubbleEl = assistantMsgEl.querySelector('.ai-bubble-assistant');
    const customerId = customerSelect.value ? Number(customerSelect.value) : null;
    const days = daysSelect.value ? Number(daysSelect.value) : 90;

    function renderFinalReply(payload) {
      const answer = payload.answer || '';
      const cards = payload.cards || [];
      if (payload.sessionId) {
        currentSessionId = payload.sessionId;
      }
      if (Array.isArray(payload.sessions)) {
        sessionsList = payload.sessions;
      }
      renderHistoryList();

      const cardsHtml = renderEvidenceCards(cards);
      const mdHtml = renderMarkdown(answer);
      bubbleEl.innerHTML = `
        ${cardsHtml}
        <div class="ai-markdown-body">${mdHtml}</div>
        <div class="ai-msg-actions">
          <button type="button" class="btn btn-secondary btn-sm ai-copy-btn">📋 复制诊断结果</button>
        </div>
      `;
      bindBubbleInteractions(bubbleEl, answer);

      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: answer });
      scrollToBottom();
    }

    try {
      const res = await fetch('/ai-assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          'X-CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({
          message: text,
          sessionId: currentSessionId,
          customerId,
          days,
          history: chatHistory.slice(-6),
          stream: true
        })
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        const errData = contentType.includes('application/json') ? await res.json().catch(() => ({})) : {};
        throw new Error(errData.error || errData.message || `请求失败 (HTTP ${res.status})`);
      }

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finished = false;

        while (!finished) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';

          for (const block of blocks) {
            const lines = block.split('\n');
            let eventType = 'message';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let payload = {};
            try { payload = JSON.parse(dataStr); } catch (_) {}

            if (eventType === 'status' && payload.text) {
              bubbleEl.innerHTML = `<div class="ai-status-step">⏳ ${escapeHtml(payload.text)}</div>`;
              scrollToBottom();
            } else if (eventType === 'result') {
              renderFinalReply(payload);
              finished = true;
            } else if (eventType === 'error') {
              throw new Error(payload.error || '诊断遇到异常');
            }
          }
        }
      } else {
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '诊断失败');
        renderFinalReply(data);
      }
    } catch (err) {
      bubbleEl.innerHTML = `<div class="error" style="margin:0">⚠️ ${escapeHtml(err.message)}</div>`;
    } finally {
      setBusyState(false);
    }
  }

  // ===== 事件绑定 =====
  newChatBtn.addEventListener('click', () => {
    startNewChat();
  });

  historyToggleBtn.addEventListener('click', () => {
    const nextHidden = !historyPanel.hidden;
    historyPanel.hidden = nextHidden;
    historyToggleBtn.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
    if (!nextHidden) {
      renderHistoryList();
    }
  });

  historyCloseBtn.addEventListener('click', () => {
    historyPanel.hidden = true;
    historyToggleBtn.setAttribute('aria-expanded', 'false');
  });

  clearAllHistoryBtn.addEventListener('click', () => {
    clearAllSessions();
  });

  chatForm.addEventListener('submit', e => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  lightbox.addEventListener('click', () => {
    lightbox.classList.remove('open');
    lightboxImg.src = '';
  });

  // ===== 初始化渲染 =====
  syncStoreInputDisplay();
  renderChips();
  renderHistoryList();

  if (config.initialCustomerId) {
    // 从客户列表或对账单点击「✨ 诊断」进入：针对该门店自动发起新对话
    const storeName = getSelectedStoreName();
    if (storeName) {
      const firstPrompt = getStorePrompts(storeName)[0];
      sendMessage(firstPrompt);
    }
  } else if (config.initialSession) {
    // 平时从导航栏进入或从销售单/对账单返回：自动恢复最近一次对话
    applyLoadedSession(config.initialSession);
  }
})();
