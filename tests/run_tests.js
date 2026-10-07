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

t("带电池成本更低且谷电充电", () => {
  const o = { month: 7, day: 15, weather: 0.8, capacity: 5, feed: 0.4, shiftableIds: ["washer", "heater"], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  assert(r.cost_bat <= r.cost_no_bat + 1e-6);
  const buyNo = r.hours.filter(x => x.h < 6).reduce((a, x) => a + x.grid_no_bat, 0);
  const buyBat = r.hours.filter(x => x.h < 6).reduce((a, x) => a + x.grid_bat, 0);
  assert(buyBat >= buyNo - 1e-6);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
