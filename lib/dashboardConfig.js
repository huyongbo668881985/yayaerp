/**
 * 首页看板卡片配置管理（支持管理员视角 / 操作员视角独立开关、排序与浅色背景定制）
 *
 * 安全红线：
 *   凡标记为 adminOnly: true 的卡片（如毛利、成本相关指标），在任何时候严禁出现在
 *   operator 视角的可选列表或渲染结果中（服务端硬过滤）。
 */

const DASHBOARD_COLORS = [
  { key: 'blue',   label: '浅海蓝', bg: '#eff6ff', border: '#bfdbfe', text: '#1e3a8a', dot: '#3b82f6' },
  { key: 'cyan',   label: '浅青蓝', bg: '#ecfeff', border: '#a5f3fc', text: '#155e75', dot: '#06b6d4' },
  { key: 'orange', label: '浅暖橙', bg: '#fff7ed', border: '#fed7aa', text: '#9a3412', dot: '#f97316' },
  { key: 'red',    label: '浅珊红', bg: '#fef2f2', border: '#fecaca', text: '#991b1b', dot: '#ef4444' },
  { key: 'green',  label: '浅翠绿', bg: '#f0fdf4', border: '#bbf7d0', text: '#166534', dot: '#22c55e' },
  { key: 'amber',  label: '浅琥珀', bg: '#fefce8', border: '#fde047', text: '#854d0e', dot: '#eab308' },
  { key: 'purple', label: '浅罗兰紫', bg: '#faf5ff', border: '#e9d5ff', text: '#6b21a8', dot: '#a855f7' },
  { key: 'pink',   label: '浅樱粉', bg: '#fdf2f8', border: '#fbcfe8', text: '#9d174d', dot: '#ec4899' },
  { key: 'gray',   label: '浅云灰', bg: '#f8fafc', border: '#cbd5e1', text: '#334155', dot: '#94a3b8' }
];

const COLOR_MAP = new Map(DASHBOARD_COLORS.map(c => [c.key, c]));

const DASHBOARD_CARDS = [
  {
    id: 'monthly_sales',
    label: '本月销售额（已审核）',
    desc: '当月 1 日至今已审核销售单金额减去同月已审核退货单金额',
    defaultEnabled: true,
    defaultColor: 'blue',
    adminOnly: false
  },
  {
    id: 'yearly_sales',
    label: '本年度销售额（已审核）',
    desc: '当年 1 月 1 日至今已审核销售单金额减去同年已审核退货单金额',
    defaultEnabled: true,
    defaultColor: 'cyan',
    adminOnly: false
  },
  {
    id: 'monthly_net_debt',
    label: '本月净增欠款',
    desc: '本月新产生的未结清欠款减去本月清收/冲抵的往月旧欠款',
    defaultEnabled: true,
    defaultColor: 'orange',
    adminOnly: false
  },
  {
    id: 'total_debt',
    label: '累计总欠款',
    desc: '当前全部已审核且未结清销售单的有效欠款总额',
    defaultEnabled: true,
    defaultColor: 'red',
    adminOnly: false
  },
  {
    id: 'monthly_profit',
    label: '本月毛利（已结清）',
    desc: '当月已审核且有效欠款已结清订单的销售毛利（仅管理员可见）',
    defaultEnabled: true,
    defaultColor: 'green',
    adminOnly: true
  },
  {
    id: 'pending_orders',
    label: '待审核单据',
    desc: '待审核的销售单、退货单、调拨单数量合计',
    defaultEnabled: true,
    defaultColor: 'amber',
    adminOnly: false
  },
  {
    id: 'today_sales',
    label: '今日销售额（已审核）',
    desc: '今日已审核销售单金额减去今日已审核退货单金额',
    defaultEnabled: false,
    defaultColor: 'purple',
    adminOnly: false
  },
  {
    id: 'today_profit',
    label: '今日毛利（已结清）',
    desc: '今日已审核且已结清订单的销售毛利（仅管理员可见）',
    defaultEnabled: false,
    defaultColor: 'pink',
    adminOnly: true
  }
];

function ensureDashboardSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      role TEXT PRIMARY KEY CHECK(role IN ('admin', 'operator')),
      cards_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * 获取指定角色允许配置的完整卡片定义池（服务端硬拦截：operator 绝不包含 adminOnly 卡片）
 */
function getAllowedCardDefs(role) {
  if (role === 'admin') return DASHBOARD_CARDS;
  return DASHBOARD_CARDS.filter(c => !c.adminOnly);
}

/**
 * 规整并补全某个角色的卡片配置列表：
 *  - 剔除非法或越权（如 operator 下的 adminOnly）卡片 ID
 *  - 保留用户已配置的顺序、开关和合法颜色
 *  - 将新增但尚未出现在存档里的卡片按默认状态追加在末尾
 */
function normalizeRoleConfig(role, rawList) {
  const allowedDefs = getAllowedCardDefs(role);
  const allowedMap = new Map(allowedDefs.map(c => [c.id, c]));
  const seen = new Set();
  const result = [];

  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const def = allowedMap.get(item.id);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      const color = COLOR_MAP.has(item.color) ? item.color : def.defaultColor;
      result.push({
        id: def.id,
        label: def.label,
        desc: def.desc,
        adminOnly: def.adminOnly,
        enabled: Boolean(item.enabled),
        color,
        colorMeta: COLOR_MAP.get(color)
      });
    }
  }

  for (const def of allowedDefs) {
    if (seen.has(def.id)) continue;
    seen.add(def.id);
    result.push({
      id: def.id,
      label: def.label,
      desc: def.desc,
      adminOnly: def.adminOnly,
      enabled: def.defaultEnabled,
      color: def.defaultColor,
      colorMeta: COLOR_MAP.get(def.defaultColor)
    });
  }

  return result;
}

function getRoleDashboardConfig(db, role) {
  const safeRole = role === 'admin' ? 'admin' : 'operator';
  ensureDashboardSettingsTable(db);
  const row = db.prepare('SELECT cards_json FROM dashboard_settings WHERE role = ?').get(safeRole);
  let parsed = null;
  if (row && row.cards_json) {
    try { parsed = JSON.parse(row.cards_json); } catch (_) { parsed = null; }
  }
  return normalizeRoleConfig(safeRole, parsed);
}

function saveRoleDashboardConfig(db, role, items) {
  const safeRole = role === 'admin' ? 'admin' : 'operator';
  ensureDashboardSettingsTable(db);
  const normalized = normalizeRoleConfig(safeRole, items).map(c => ({
    id: c.id,
    enabled: Boolean(c.enabled),
    color: c.color
  }));
  db.prepare(`
    INSERT INTO dashboard_settings (role, cards_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET
      cards_json = excluded.cards_json,
      updated_at = datetime('now')
  `).run(safeRole, JSON.stringify(normalized));
  return getRoleDashboardConfig(db, safeRole);
}

function resetDashboardConfig(db) {
  ensureDashboardSettingsTable(db);
  db.prepare('DELETE FROM dashboard_settings').run();
}

module.exports = {
  DASHBOARD_COLORS,
  COLOR_MAP,
  DASHBOARD_CARDS,
  getAllowedCardDefs,
  normalizeRoleConfig,
  getRoleDashboardConfig,
  saveRoleDashboardConfig,
  resetDashboardConfig
};
