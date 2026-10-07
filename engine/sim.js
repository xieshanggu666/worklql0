"use strict";
const tariff = require("./tariff");
const solarMod = require("./solar");
const loadsMod = require("./loads");
const battery = require("./battery");

// 取整辅助：日明细与对外单日接口共用，保证两者展示完全一致。
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

// 单日模拟（高精度，不做任何账单取整）。
// 阶梯附加本质是月度结算项，这里仅按当日购电量给出参考值，
// 并与能量电费（分时购电 − 上网收益）分开返回，由调用方决定如何汇总。
// carry.soc0 为前一天结转的 SOC 比例（0-1），缺省时回退到电池配置的初值。
function simulateDayRaw(opts, carry) {
  const o = opts || {};
  const month = o.month || 7;
  const day = o.day || 15;
  const weather = o.weather == null ? 0.8 : Math.max(0, Math.min(1, o.weather));
  const capacity = Math.max(0, o.capacity || 0);
  const feed = o.feed == null ? 0.4 : o.feed;
  const prices = tariff.hourlyPrices(o.tou);
  const base = loadsMod.baselineLoad();
  const solar = solarMod.solarProfile(month, day, capacity, weather);
  const ids = o.shiftableIds && o.shiftableIds.length
    ? o.shiftableIds
    : loadsMod.SHIFTABLE.map(s => s.id);
  const shiftables = loadsMod.SHIFTABLE.filter(s => ids.includes(s.id));
  const { load, plan } = loadsMod.scheduleShiftable(base, solar, prices, feed, shiftables);

  // 月度逐日推进时，carry.tierRate 为当前累计购电量所处档位的边际加价；
  // 单日独立模拟不带 carry，档位加价为 0（单日购电本就远低于 200 度的月门槛）。
  const tierRate = carry && carry.tierRate != null ? Math.max(0, carry.tierRate) : 0;
  const noBat = battery.optimizeBattery({
    load, solar, price: prices, feed,
    capKwh: 0.001, maxKw: 0, eff: 0.9, soc0: 0, tierRate,
  });

  const batCfg = o.battery;
  const hasBat = !!(batCfg && batCfg.capKwh > 0);
  const socStart = hasBat
    ? (carry && carry.soc0 != null ? carry.soc0 : (batCfg.soc0 == null ? 0.5 : batCfg.soc0))
    : null;
  const bat = hasBat
    ? battery.optimizeBattery({
        load, solar, price: prices, feed,
        capKwh: batCfg.capKwh,
        maxKw: batCfg.maxKw == null ? 3 : batCfg.maxKw,
        eff: batCfg.eff == null ? 0.9 : batCfg.eff,
        soc0: socStart,
        tierRate,
      })
    : null;

  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      h,
      load: r3(load[h]),
      solar: r3(solar[h]),
      price: prices[h],
      grid_no_bat: r3(noBat.hours[h].grid_in),
      export_no_bat: r3(noBat.hours[h].export),
      ...(bat
        ? {
            grid_bat: r3(bat.hours[h].grid_in),
            export_bat: r3(bat.hours[h].export),
            ch: bat.hours[h].ch,
            dis: bat.hours[h].dis,
            soc: bat.hours[h].soc,
          }
        : {}),
    });
  }

  return {
    hours,
    plan,
    weather,
    // —— 无电池方案 ——
    energy_no_bat: noBat.cost,          // 分时购电费 − 上网收益
    tier_no_bat: tariff.tierSurcharge(noBat.kwh_buy, o.tier), // 仅当日参考
    kwh_buy_no_bat: noBat.kwh_buy,
    kwh_export_no_bat: noBat.kwh_export,
    // —— 含电池方案 ——
    energy_bat: bat ? bat.cost : null,
    tier_bat: bat ? tariff.tierSurcharge(bat.kwh_buy, o.tier) : null,
    kwh_buy_bat: bat ? bat.kwh_buy : null,
    kwh_export_bat: bat ? bat.kwh_export : null,
    // —— SOC 结转 ——
    soc0: bat ? bat.soc0_frac : null,
    soc_end: bat ? bat.soc_end_frac : null,
  };
}

// 单日对外结构：能量电费 / 阶梯附加 / 当日合计分开，
// 月账单的 daily 行复用同一份投影，保证日明细与单日模拟逐字段一致。
function presentDay(r) {
  const billNo = r.energy_no_bat + r.tier_no_bat;
  const billBat = r.energy_bat == null ? null : r.energy_bat + r.tier_bat;
  return {
    hours: r.hours,
    plan: r.plan,
    cost_no_bat: r2(r.energy_no_bat),
    cost_bat: r.energy_bat == null ? null : r2(r.energy_bat),
    tier_no_bat: r2(r.tier_no_bat),
    tier_bat: r.tier_bat == null ? null : r2(r.tier_bat),
    bill_no_bat: r2(billNo),
    bill_bat: billBat == null ? null : r2(billBat),
    save: r.energy_bat == null ? 0 : r2(r.energy_no_bat - r.energy_bat),
    kwh_buy_no_bat: r.kwh_buy_no_bat,
    kwh_buy_bat: r.kwh_buy_bat,
    kwh_export: r.kwh_export_no_bat,
    soc0: r.soc0,
    soc_end: r.soc_end,
  };
}

function simulateDay(opts) {
  const o = opts || {};
  // 可选月度上下文：monthKwhBefore（当天之前的月累计购电量）与 socCarry（前一天末态 SOC 比例）。
  // 单日独立模拟不传时，档位加价为 0、SOC 用电池配置初值。
  const hasCtx = o.monthKwhBefore != null || (o.socCarry != null);
  const raw = simulateDayRaw(o, hasCtx
    ? {
        soc0: o.socCarry,
        tierRate: o.monthKwhBefore != null
          ? tariff.marginalSurcharge(o.monthKwhBefore, o.tier)
          : 0,
      }
    : null);
  return presentDay(raw);
}

function monthBill(opts) {
  const o = opts || {};
  const days = Math.max(7, Math.min(62, o.days || 30));
  const seed = o.seed == null ? 11 : o.seed;
  const hasBat = !!(o.battery && o.battery.capKwh > 0);

  // 两个方案分别累计购电量与能量电费；阶梯附加只在月末按整月购电量统一计算一次。
  // 逐日推进时，各方案按自己的月累计购电量取得边际档位加价，指导当日调度规避跨档。
  let kwhNo = 0;
  let kwhBat = 0;
  let exportNo = 0;
  let exportBat = 0;
  let energyNo = 0;
  let energyBat = 0;
  let socCarry = null; // 逐日结转的 SOC 比例（0-1），null 表示首日用配置初值
  const daily = [];

  for (let d = 1; d <= days; d++) {
    const w = 0.35 + 0.65 * (((seed * 7 + d * 13) % 97) / 97);
    const dayOpts = { ...o, month: o.month || 7, day: d, weather: w };

    // 当日开始前的边际档位（基于此前累计购电量）——记录下来供日明细对账与精确复现
    const rateNoIn = tariff.marginalSurcharge(kwhNo, o.tier);
    const rateBatIn = hasBat ? tariff.marginalSurcharge(kwhBat, o.tier) : null;

    // 无电池方案：按自身累计档位独立推进（电池配置原样传入，优化器内部 cap=0 自动失效）
    const rawNo = simulateDayRaw(dayOpts, { tierRate: rateNoIn });
    // 含电池方案：同样独立定档，并从前一天末态 SOC 继续
    const rawBat = hasBat ? simulateDayRaw(dayOpts, { soc0: socCarry, tierRate: rateBatIn }) : null;

    // 合并为单日完整视图（hours/plan 与含电池方案一致，供日明细复用同一投影）
    const raw = hasBat
      ? {
          ...rawBat,
          energy_no_bat: rawNo.energy_no_bat,
          tier_no_bat: rawNo.tier_no_bat,
          kwh_buy_no_bat: rawNo.kwh_buy_no_bat,
          kwh_export_no_bat: rawNo.kwh_export_no_bat,
        }
      : rawNo;

    kwhNo += raw.kwh_buy_no_bat;
    exportNo += raw.kwh_export_no_bat;
    energyNo += raw.energy_no_bat;
    if (hasBat) {
      kwhBat += raw.kwh_buy_bat;
      exportBat += raw.kwh_export_bat;
      energyBat += raw.energy_bat;
      socCarry = raw.soc_end; // 当日末态电量结转次日，避免跨日断档
    }

    // 日明细直接复用单日对外结构，与 /api/simulate 完全同源同口径。
    const view = presentDay(raw);
    daily.push({
      day: d,
      weather: r3(w),
      cost_no_bat: view.cost_no_bat,
      cost_bat: view.cost_bat,
      bill_no_bat: view.bill_no_bat,
      bill_bat: view.bill_bat,
      kwh_buy_no_bat: view.kwh_buy_no_bat,
      kwh_buy_bat: view.kwh_buy_bat,
      kwh_export: view.kwh_export,
      soc0: view.soc0,
      soc_end: view.soc_end,
      // 该日在月度推进中实际采用的边界条件；用同样参数调单日接口即可逐字段复现本行
      tier_rate_no: r3(rateNoIn),
      tier_rate_bat: rateBatIn == null ? null : r3(rateBatIn),
    });
  }

  // 整月统一计算阶梯：无电池与含电池分别按各自整月购电量定档，杜绝重复计费。
  const tierNo = tariff.tierSurcharge(kwhNo, o.tier);
  const tierBat = hasBat ? tariff.tierSurcharge(kwhBat, o.tier) : null;
  const totalNo = energyNo + tierNo;
  const totalBat = hasBat ? energyBat + tierBat : null;

  return {
    days,
    kwh: r2(kwhNo),
    kwh_bat: hasBat ? r2(kwhBat) : null,
    export_kwh: r2(exportNo),
    export_kwh_bat: hasBat ? r2(exportBat) : null,
    energy_cost_no_bat: r2(energyNo),
    energy_cost_bat: hasBat ? r2(energyBat) : null,
    tier_surcharge: r2(tierNo),
    tier_surcharge_bat: tierBat == null ? null : r2(tierBat),
    cost_no_bat: r2(totalNo),
    cost_bat: totalBat == null ? null : r2(totalBat),
    save: hasBat ? r2(totalNo - totalBat) : 0,
    daily,
  };
}

module.exports = { simulateDay, simulateDayRaw, presentDay, monthBill };
