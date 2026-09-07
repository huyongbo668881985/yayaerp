/**
 * 价格/成本换算公共模块（sales.js 与 returns.js 共用，避免同一逻辑分叉成两份实现）
 *
 * 成本快照口径（2026-09-07 定版）：
 *   cost_price_snapshot 永远记"每一基础单位（瓶）"的成本价，
 *   毛利公式 base_quantity × cost_price_snapshot 依赖这个口径（lib/profitCalc.js）。
 *
 * 为什么按箱开单不能直接取 cost_price（瓶成本价）：
 *   箱成本价（cost_price_pack）是商品档案里直接存储的真实值，而瓶成本价往往是
 *   由箱价 ÷ 箱规 反算出来的近似值（如 380/24=15.833... 存成 15.83）。
 *   按箱开单时若快照取 15.83，240 瓶就凭空多算 0.8 元成本，毛利系统性偏低——
 *   与 lib/schema.js 里"箱价直接存储、不再用瓶价×换算比例反算"是同一类问题的成本侧，
 *   当时只修了销售价格链路，没覆盖成本快照。
 *
 * 规则：
 *   - 该行确实按箱录入（unit_choice='pack' 且商品配了大单位 pack_unit），
 *     且 cost_price_pack 有值 → cost_price_pack / pack_size
 *     （除不尽时保留全精度浮点，落库后按 base_quantity 乘回去不丢钱）
 *   - 其余情况（按瓶录入、或没配箱成本价）→ cost_price
 *
 * 快照落库后不可篡改（成本快照不可篡改是核心规则），本函数只影响新单据，
 * 历史单据不做回填。
 */

/**
 * 计算一行明细的成本快照（每基础单位）。
 * @param {object} product  products 表整行（含 cost_price/cost_price_pack/pack_size/pack_unit）
 * @param {string} unitChoice 该行明细的录入单位（'pack'=按箱，其他=按基础单位）
 * @returns {number} 每基础单位成本价
 */
function costSnapshotPerBaseUnit(product, unitChoice) {
  // 与调用方 buildItemsFromRequest 里的 usePack 判定保持一致：
  // unit_choice='pack' 但商品没配 pack_unit 时，该行实际仍按基础单位录入。
  const usePack = unitChoice === 'pack' && product.pack_unit;
  if (usePack && product.cost_price_pack != null && product.pack_size > 0) {
    return product.cost_price_pack / product.pack_size;
  }
  return product.cost_price || 0;
}

module.exports = { costSnapshotPerBaseUnit };
