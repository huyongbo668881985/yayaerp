'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  runDiagnosticChat,
  listUserChatSessions,
  getUserChatSessionWithMessages,
  saveDiagnosticTurn,
  deleteUserChatSession,
  clearUserChatSessions,
  CHAT_RETENTION_DAYS,
  shelfguardConfig,
  llmConfig
} = require('../lib/aiAssistant');

const router = express.Router();
const jsonParser = express.json({ limit: '64kb' });

// 按租户+管理员维度的简单对话频率限制（每分钟最多 12 次提问，防止误触刷爆大模型配额）
const chatBuckets = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_MIN = 12;

function checkChatRateLimit(req, res, next) {
  const key = `${req.tenant ? req.tenant.tenant_code : 'anon'}:${req.session.user ? req.session.user.id : '0'}`;
  const now = Date.now();
  let rec = chatBuckets.get(key);
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + WINDOW_MS };
    chatBuckets.set(key, rec);
  }
  rec.count += 1;
  if (rec.count > MAX_PER_MIN) {
    return res.status(429).json({
      ok: false,
      error: '提问过于频繁，请稍候半分钟再试'
    });
  }
  return next();
}

function requireAiEnabled(req, res, next) {
  if (!req.tenant || !req.tenant.ai_enabled) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(403).json({
        ok: false,
        error: '当前租户尚未开通 AI 经营诊断功能，请联系平台管理员在租户后台开启'
      });
    }
    return res.status(403).render('error', {
      message: '当前租户尚未开通 AI 经营诊断功能，请联系平台管理员在租户管理后台开启。',
      currentUser: res.locals.currentUser
    });
  }
  return next();
}

router.get('/ai-assistant', requireAdmin, requireAiEnabled, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = req.tenantDb;
  const userId = req.session.user.id;
  const customers = db.prepare(`
    SELECT c.id, c.name, u.name AS operator_name
    FROM customers c
    LEFT JOIN users u ON u.id = c.operator_id
    ORDER BY c.name ASC
  `).all();

  const initialCustomerId = req.query.customer_id && /^[1-9]\d*$/.test(String(req.query.customer_id))
    ? Number(req.query.customer_id)
    : null;
  const requestedSessionId = req.query.session_id && /^[1-9]\d*$/.test(String(req.query.session_id))
    ? Number(req.query.session_id)
    : null;
  const forceNew = req.query.new === '1';

  const sessions = listUserChatSessions(db, userId);
  let initialSession = null;
  if (requestedSessionId) {
    initialSession = getUserChatSessionWithMessages(db, userId, requestedSessionId);
  } else if (!initialCustomerId && !forceNew && sessions.length > 0) {
    initialSession = getUserChatSessionWithMessages(db, userId, sessions[0].id);
  }

  const llm = llmConfig();
  const sg = shelfguardConfig();

  res.render('ai_assistant', {
    customers,
    initialCustomerId,
    sessions,
    initialSession,
    retentionDays: CHAT_RETENTION_DAYS,
    aiStatus: {
      llmConfigured: llm.configured,
      llmModel: llm.model,
      shelfguardEnabled: Boolean(req.tenant.ai_shelfguard_enabled),
      shelfguardConfigured: sg.configured
    }
  });
});

router.get('/ai-assistant/sessions', requireAdmin, requireAiEnabled, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sessions = listUserChatSessions(req.tenantDb, req.session.user.id);
  return res.json({ ok: true, sessions });
});

router.get('/ai-assistant/sessions/:id', requireAdmin, requireAiEnabled, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sid = /^[1-9]\d*$/.test(String(req.params.id)) ? Number(req.params.id) : null;
  if (!sid) return res.status(400).json({ ok: false, error: '无效的会话 ID' });
  const session = getUserChatSessionWithMessages(req.tenantDb, req.session.user.id, sid);
  if (!session) {
    return res.status(404).json({ ok: false, error: '未找到该对话记录或已过期自动删除' });
  }
  return res.json({ ok: true, session });
});

router.post('/ai-assistant/sessions/clear', requireAdmin, requireAiEnabled, jsonParser, (req, res) => {
  clearUserChatSessions(req.tenantDb, req.session.user.id);
  return res.json({ ok: true, sessions: [] });
});

router.post('/ai-assistant/sessions/:id/delete', requireAdmin, requireAiEnabled, jsonParser, (req, res) => {
  const sid = /^[1-9]\d*$/.test(String(req.params.id)) ? Number(req.params.id) : null;
  if (!sid) return res.status(400).json({ ok: false, error: '无效的会话 ID' });
  deleteUserChatSession(req.tenantDb, req.session.user.id, sid);
  const sessions = listUserChatSessions(req.tenantDb, req.session.user.id);
  return res.json({ ok: true, sessions });
});

router.post('/ai-assistant/chat', requireAdmin, requireAiEnabled, checkChatRateLimit, jsonParser, async (req, res) => {
  const body = req.body || {};
  const userId = req.session.user.id;
  const message = String(body.message || '').trim().slice(0, 1000);
  if (!message) {
    return res.status(400).json({ ok: false, error: '请输入要诊断的问题' });
  }

  const selectedCustomerId = body.customerId && Number.isInteger(Number(body.customerId)) && Number(body.customerId) > 0
    ? Number(body.customerId)
    : null;
  const sessionId = body.sessionId && Number.isInteger(Number(body.sessionId)) && Number(body.sessionId) > 0
    ? Number(body.sessionId)
    : null;
  const days = body.days ? Number(body.days) : 90;

  let history = Array.isArray(body.history) ? body.history : [];
  if (history.length === 0 && sessionId) {
    const existingSession = getUserChatSessionWithMessages(req.tenantDb, userId, sessionId);
    if (existingSession && Array.isArray(existingSession.messages)) {
      history = existingSession.messages.slice(-6).map(m => ({ role: m.role, content: m.content }));
    }
  }
  const wantStream = Boolean(body.stream);

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event, payload) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await runDiagnosticChat({
        db: req.tenantDb,
        tenant: req.tenant,
        userMessage: message,
        history,
        selectedCustomerId,
        days,
        onStatus: statusText => sendEvent('status', { text: statusText })
      });
      const saved = saveDiagnosticTurn(req.tenantDb, {
        userId,
        sessionId,
        customerId: selectedCustomerId,
        days,
        userMessage: message,
        assistantAnswer: result.answer,
        cards: result.cards
      });
      const sessions = listUserChatSessions(req.tenantDb, userId);
      sendEvent('result', {
        ok: true,
        answer: result.answer,
        cards: result.cards,
        sessionId: saved.sessionId,
        session: saved.session,
        sessions
      });
    } catch (err) {
      console.error('[ai-assistant] 诊断对话异常:', err);
      sendEvent('error', {
        ok: false,
        error: '生成诊断报告时遇到异常，请稍后重试'
      });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  try {
    const result = await runDiagnosticChat({
      db: req.tenantDb,
      tenant: req.tenant,
      userMessage: message,
      history,
      selectedCustomerId,
      days
    });
    const saved = saveDiagnosticTurn(req.tenantDb, {
      userId,
      sessionId,
      customerId: selectedCustomerId,
      days,
      userMessage: message,
      assistantAnswer: result.answer,
      cards: result.cards
    });
    const sessions = listUserChatSessions(req.tenantDb, userId);
    return res.json({
      ok: true,
      answer: result.answer,
      cards: result.cards,
      sessionId: saved.sessionId,
      session: saved.session,
      sessions
    });
  } catch (err) {
    console.error('[ai-assistant] 诊断对话异常:', err);
    return res.status(500).json({
      ok: false,
      error: '生成诊断报告时遇到异常，请稍后重试'
    });
  }
});

module.exports = router;
