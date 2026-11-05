'use strict';

(function () {
  const configEl = document.getElementById('aiAssistantConfig');
  const config = configEl ? JSON.parse(configEl.textContent || '{}') : {};

  const customerSelect = document.getElementById('aiCustomerSelect');
  const daysSelect = document.getElementById('aiDaysSelect');
  const clearBtn = document.getElementById('aiClearBtn');
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
  let isBusy = false;

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
              <img src="${escapeHtml(p.url)}" alt="巡检照片" data-full-src="${escapeHtml(p.url)}">
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

  function getSelectedStoreName() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    return opt && opt.value ? (opt.getAttribute('data-name') || opt.textContent.trim()) : '';
  }

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

  async function sendMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text || isBusy) return;

    if (emptyStateEl) emptyStateEl.style.display = 'none';
    inputEl.value = '';
    setBusyState(true);

    const userMsgEl = document.createElement('div');
    userMsgEl.className = 'ai-msg ai-msg-user';
    userMsgEl.innerHTML = `<div class="ai-bubble-user">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(userMsgEl);

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
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const csrfToken = csrfMeta ? csrfMeta.content : '';
    const customerId = customerSelect.value ? Number(customerSelect.value) : null;
    const days = daysSelect.value ? Number(daysSelect.value) : 90;

    function renderFinalReply(answer, cards) {
      const cardsHtml = renderEvidenceCards(cards);
      const mdHtml = renderMarkdown(answer);
      bubbleEl.innerHTML = `
        ${cardsHtml}
        <div class="ai-markdown-body">${mdHtml}</div>
        <div class="ai-msg-actions">
          <button type="button" class="btn btn-secondary btn-sm ai-copy-btn">📋 复制诊断结果</button>
        </div>
      `;
      const copyBtn = bubbleEl.querySelector('.ai-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(answer);
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
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
          message: text,
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
              renderFinalReply(payload.answer || '', payload.cards || []);
              finished = true;
            } else if (eventType === 'error') {
              throw new Error(payload.error || '诊断遇到异常');
            }
          }
        }
      } else {
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '诊断失败');
        renderFinalReply(data.answer || '', data.cards || []);
      }
    } catch (err) {
      bubbleEl.innerHTML = `<div class="error" style="margin:0">⚠️ ${escapeHtml(err.message)}</div>`;
    } finally {
      setBusyState(false);
    }
  }

  customerSelect.addEventListener('change', () => {
    renderChips();
  });

  clearBtn.addEventListener('click', () => {
    chatHistory = [];
    Array.from(messagesEl.querySelectorAll('.ai-msg')).forEach(el => el.remove());
    if (emptyStateEl) emptyStateEl.style.display = '';
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

  renderChips();

  // 如果是从客户列表/对账页带着 ?customer_id= 进来的，自动发起该店综合诊断
  if (config.initialCustomerId) {
    const storeName = getSelectedStoreName();
    if (storeName) {
      const firstPrompt = getStorePrompts(storeName)[0];
      sendMessage(firstPrompt);
    }
  }
})();
