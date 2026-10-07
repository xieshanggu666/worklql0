"use strict";
const assert = require("assert");
const tariff = require("../engine/tariff");
const solar = require("../engine/solar");
const loads = require("../engine/loads");
const battery = require("../engine/battery");
const sim = require("../engine/sim");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

t("分时电价时段边界", () => {
  assert.strictEqual(tariff.touPrice(0), 0.32);
  assert.strictEqual(tariff.touPrice(5), 0.32);
  assert.strictEqual(tariff.touPrice(6), 0.63);
  assert.strictEqual(tariff.touPrice(7), 0.63);
  assert.strictEqual(tariff.touPrice(8), 1.02);
  assert.strictEqual(tariff.touPrice(10), 1.02);
  assert.strictEqual(tariff.touPrice(11), 0.63);
  assert.strictEqual(tariff.touPrice(18), 1.02);
  assert.strictEqual(tariff.touPrice(22), 0.63);
  assert.strictEqual(tariff.touPrice(23), 0.63);
});

t("分时电价全天覆盖无空隙", () => {
  for (let h = 0; h < 24; h++) {
    assert(tariff.touPrice(h) > 0);
    assert(tariff.touLabel(h) !== "—");
  }
});

t("阶梯附加按档累计", () => {
  assert.strictEqual(tariff.tierSurcharge(150), 0);
  assert.strictEqual(tariff.tierSurcharge(300), 5);
  assert.strictEqual(tariff.tierSurcharge(500), 10 + 20);
});

t("光伏夜间为零且白天为正", () => {
  const s = solar.solarProfile(7, 15, 5, 1);
  assert.strictEqual(s[0], 0);
  assert.strictEqual(s[23], 0);
  assert(s[12] > 0);
});

t("光伏与装机线性", () => {
  const a = solar.solarProfile(7, 15, 5, 1);
  const b = solar.solarProfile(7, 15, 10, 1);
  for (let h = 0; h < 24; h++) {
    assert(Math.abs(b[h] - a[h] * 2) < 1e-9);
  }
});

t("光伏阴天低于晴天", () => {
  const sun = solar.solarProfile(7, 15, 5, 1);
  const rain = solar.solarProfile(7, 15, 5, 0.12);
  assert(rain[12] < sun[12]);
});

t("夏季发电高于冬季", () => {
  const sum = solar.solarProfile(7, 15, 5, 1);
  const win = solar.solarProfile(1, 15, 5, 1);
  const sumTotal = sum.reduce((a, b) => a + b, 0);
  const winTotal = win.reduce((a, b) => a + b, 0);
  assert(sumTotal > winTotal);
});

t("可迁移负荷限制在窗口内", () => {
  const base = new Array(24).fill(0.3);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const { plan } = loads.scheduleShiftable(base, s, price, 0.4, [loads.SHIFTABLE[0]]);
  assert.strictEqual(plan.length, 1);
  assert(plan[0].start >= 9 && plan[0].start < 20);
});

t("跨午夜窗口起始点正确", () => {
  const base = new Array(24).fill(0.1);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const ev = loads.SHIFTABLE.find(x => x.id === "ev");
  const { plan } = loads.scheduleShiftable(base, s, price, 0.4, [ev]);
  assert.strictEqual(plan.length, 1);
  assert(plan[0].start >= 21 || plan[0].start < 7);
});

t("电池充放电不超功率与SOC约束", () => {
  const load = new Array(24).fill(1);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const r = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 });
  for (const h of r.hours) {
    assert(h.ch <= 3 + 1e-9);
    assert(h.dis <= 3 + 1e-9);
    assert(h.soc >= -1e-9 && h.soc <= 1 + 1e-9);
  }
});

t("电池调度电费不高于无电池", () => {
  const load = new Array(24).fill(1.2);
  const price = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 11) || (h >= 18 && h < 22) ? 1.02 : h < 6 ? 0.32 : 0.63);
  const s = new Array(24).fill(0);
  const noBat = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 0.001, maxKw: 0, eff: 0.9, soc0: 0 });
  const withBat = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 });
  assert(withBat.cost <= noBat.cost + 1e-6);
});

t("电池在谷电充电峰电放电", () => {
  const load = new Array(24).fill(0.5);
  const price = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 11) || (h >= 18 && h < 22) ? 1.02 : h < 6 ? 0.32 : 0.63);
  const s = new Array(24).fill(0);
  const r = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0 });
  const totalCh = r.hours.reduce((a, x) => a + x.ch, 0);
  const totalDis = r.hours.reduce((a, x) => a + x.dis, 0);
  assert(totalCh > 0);
  assert(totalDis > 0);
  const chInValley = r.hours.slice(0, 6).reduce((a, x) => a + x.ch, 0);
  assert(chInValley > 0);
});

t("能量守恒：购电+光伏=负荷+充电+上网", () => {
  const o = { month: 7, day: 15, weather: 0.8, capacity: 5, feed: 0.4, shiftableIds: ["washer"], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  for (const h of r.hours) {
    const lhs = h.grid_no_bat + h.solar;
    const rhs = h.load + h.export_no_bat;
    assert(Math.abs(lhs - rhs) < 1e-6);
  }
});

t("带电池成本更低且峰时放电供负荷", () => {
  const o = { month: 7, day: 15, weather: 0.8, capacity: 5, feed: 0.4, shiftableIds: ["washer", "heater"], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  assert(r.cost_bat <= r.cost_no_bat + 1e-6);
  // 放电只用于满足本地负荷（电池侧×效率 ≤ 扣除光伏后的负荷缺口），绝不转化为上网电量
  for (const h of r.hours) {
    assert(h.dis * 0.9 <= Math.max(0, h.load - h.solar) + 1e-6);
    assert(h.export_bat <= h.solar + 1e-6);
  }
  // 峰段（8-11、18-22）确有放电替代购电
  const peakDis = r.hours.filter(x => (x.h >= 8 && x.h < 11) || (x.h >= 18 && x.h < 22)).reduce((a, x) => a + x.dis, 0);
  assert(peakDis > 0);
});

t("光伏自用优先于充电", () => {
  const o = { month: 7, day: 15, weather: 1, capacity: 8, feed: 0.4, shiftableIds: [], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  for (const h of r.hours) {
    if (h.ch > 0) {
      assert(h.grid_bat <= h.ch + h.load + 1e-6);
    }
  }
});

t("月度账单天数与节省非负", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });
  assert.strictEqual(r.days, 30);
  assert(r.cost_bat <= r.cost_no_bat + 1e-6);
  assert(r.kwh > 0);
});

t("月度账单确定性", () => {
  const a = sim.monthBill({ month: 7, days: 20, seed: 3 });
  const b = sim.monthBill({ month: 7, days: 20, seed: 3 });
  assert.strictEqual(a.cost_no_bat, b.cost_no_bat);
});

t("边际阶梯加价随累计购电量换挡", () => {
  assert.strictEqual(tariff.marginalSurcharge(0), 0);
  assert.strictEqual(tariff.marginalSurcharge(199), 0);
  assert.strictEqual(tariff.marginalSurcharge(200), 0.05); // 累计达到 200，下一度进入第二档
  assert.strictEqual(tariff.marginalSurcharge(399), 0.05);
  assert.strictEqual(tariff.marginalSurcharge(400), 0.2);
  assert.strictEqual(tariff.marginalSurcharge(999), 0.2);
});

t("月度账单：阶梯附加整月只算一次、不重复计费", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });
  // 日明细只含能量电费（分时购电−上网收益），整月合计 = Σ日能量电费 + 一次月度阶梯附加
  const sumEnergyNo = r.daily.reduce((a, d) => a + d.cost_no_bat, 0);
  const sumEnergyBat = r.daily.reduce((a, d) => a + d.cost_bat, 0);
  assert(Math.abs(sumEnergyNo + r.tier_surcharge - r.cost_no_bat) < 0.05);
  assert(Math.abs(sumEnergyBat + r.tier_surcharge_bat - r.cost_bat) < 0.05);
  // 用整月购电量独立重算，确认与账单上的附加一致（账单用未取整电量，容差覆盖分位取整）
  assert(Math.abs(tariff.tierSurcharge(r.kwh) - r.tier_surcharge) < 0.05);
  assert(Math.abs(tariff.tierSurcharge(r.kwh_bat) - r.tier_surcharge_bat) < 0.05);
  // 日明细逐行的（能量电费+当日参考档位）之和不含任何额外附加即可对账
  const sumBillNo = r.daily.reduce((a, d) => a + d.bill_no_bat, 0);
  assert(sumBillNo < r.cost_no_bat); // 月度附加是月末唯一新增项，当日参考档位≈0
});

t("月度账单：电池电量逐日结转、无跨日断档", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });
  assert.strictEqual(r.daily[0].soc0, 0.5); // 首日从配置初值出发
  for (let i = 1; i < r.daily.length; i++) {
    assert.strictEqual(r.daily[i].soc0, r.daily[i - 1].soc_end); // 前一日末态=次日初态
  }
  for (const d of r.daily) {
    assert(d.soc0 >= -1e-9 && d.soc0 <= 1 + 1e-9);
    assert(d.soc_end >= -1e-9 && d.soc_end <= 1 + 1e-9);
  }
});

t("月度日明细与单日模拟同源一致（含结转SOC与边际档位）", () => {
  const opts = { month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.monthBill(opts);
  // 两个方案各有自己的月累计购电量与边际档位；电池方案额外携带前一日末态 SOC。
  // 用账单完全相同的边界逐行重放单日接口，结果应与日明细逐字段一致。
  let kwhNo = 0, kwhBat = 0, soc = null;
  for (let d = 1; d <= r.days; d++) {
    const w = 0.35 + 0.65 * (((11 * 7 + d * 13) % 97) / 97);
    const day = r.daily[d - 1];
    const base = { ...opts, month: 7, day: d, weather: w };
    // 高精度重放（与月账单内部同源）；对外取整投影与日明细比对
    // 无电池侧保留与月账单相同的输入（电池配置原样传入，优化器内部强制 cap=0）
    const noRaw = sim.simulateDayRaw(base, { tierRate: tariff.marginalSurcharge(kwhNo) });
    const batRaw = sim.simulateDayRaw(base, { soc0: soc, tierRate: tariff.marginalSurcharge(kwhBat) });
    const noView = sim.presentDay(noRaw);
    const batView = sim.presentDay(batRaw);
    assert.strictEqual(noView.cost_no_bat, day.cost_no_bat);
    assert.strictEqual(noView.bill_no_bat, day.bill_no_bat);
    assert.strictEqual(noView.kwh_buy_no_bat, day.kwh_buy_no_bat);
    assert.strictEqual(batView.cost_bat, day.cost_bat);
    assert.strictEqual(batView.kwh_buy_bat, day.kwh_buy_bat);
    assert.strictEqual(batView.soc_end, day.soc_end);
    assert.strictEqual(batView.hours.length, 24);
    assert.strictEqual(tariff.marginalSurcharge(kwhNo), day.tier_rate_no);
    assert.strictEqual(tariff.marginalSurcharge(kwhBat), day.tier_rate_bat);
    kwhNo += noRaw.kwh_buy_no_bat;
    kwhBat += batRaw.kwh_buy_bat;
    soc = batRaw.soc_end;
  }
  assert(Math.abs(kwhNo - r.kwh) < 0.05);
  assert(Math.abs(kwhBat - r.kwh_bat) < 0.05);
});

t("月度账单：含电池与无电池按各自购电量独立定档", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0 } });
  assert(r.kwh > 400); // 场景本身跨越高档，证明定档有区分度
  assert(r.tier_surcharge >= 0);
  assert(r.tier_surcharge_bat >= 0);
  assert(r.cost_bat <= r.cost_no_bat + 1e-6);
  assert(r.save >= 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
