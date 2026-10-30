const assert = require('assert');
const { returnTotalMatchesItems: match } = require('../lib/validators');

// 退货单 #3 场景：明细合计 145.02，总额按角取整为 145.0
assert.ok(match(145.02, 145));
// 旧单按分保存的总额继续放行
assert.ok(match(145.02, 145.02));
// 单瓶带分位单价
assert.ok(match(29.17, 29.2));
// 被原单可退额上限截断：总额等于 cap 且少不到 0.1
assert.ok(match(145.08, 145, 145));
// 仍然拦截真正不一致
assert.ok(!match(145.02, 144));
assert.ok(!match(58.34, 145));
// 没有 cap 时，不允许差额超出取整范围
assert.ok(!match(145.08, 145));
// 有 cap 但总额不等于 cap，不放行
assert.ok(!match(145.08, 145, 144.9));
// 差额达到 0.1 以上，即使等于 cap 也不放行
assert.ok(!match(145.2, 145, 145));
console.log('return-total-match-test passed');
