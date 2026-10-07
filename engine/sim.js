"use strict";
const tariff = require("./tariff");
const solarMod = require("./solar");
const loadsMod = require("./loads");
const battery = require("./battery");

function simulateDay(opts) {
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

  const noBat = battery.optimizeBattery({
    load, solar, price: prices, feed,
    capKwh: 0.001, maxKw: 0, eff: 0.9, soc0: 0,
  });
  const batCfg = o.battery;
  const bat = batCfg && batCfg.capKwh > 0
    ? battery.optimizeBattery({
        load, solar, price: prices, feed,
        capKwh: batCfg.capKwh,
        maxKw: batCfg.maxKw == null ? 3 : batCfg.maxKw,
        eff: batCfg.eff == null ? 0.9 : batCfg.eff,
        soc0: batCfg.soc0 == null ? 0.5 : batCfg.soc0,
      })
    : null;

  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      h,
      load: Math.round(load[h] * 1000) / 1000,
      solar: Math.round(solar[h] * 1000) / 1000,
      price: prices[h],
      grid_no_bat: noBat.hours[h].grid_in,
      export_no_bat: noBat.hours[h].export,
      ...(bat
        ? {
            grid_bat: bat.hours[h].grid_in,
            export_bat: bat.hours[h].export,
            ch: bat.hours[h].ch,
            dis: bat.hours[h].dis,
            soc: bat.hours[h].soc,
          }
        : {}),
    });
  }
  const surcharge = tariff.tierSurcharge(noBat.kwh_buy, o.tier);
  return {
    hours,
    plan,
    cost_no_bat: Math.round((noBat.cost + surcharge) * 100) / 100,
    cost_bat: bat ? Math.round((bat.cost + surcharge) * 100) / 100 : null,
    save: bat ? Math.round((noBat.cost - bat.cost) * 100) / 100 : 0,
    kwh_buy_no_bat: noBat.kwh_buy,
    kwh_buy_bat: bat ? bat.kwh_buy : null,
    kwh_export: noBat.kwh_export,
    soc0: bat ? (batCfg.soc0 == null ? 0.5 : batCfg.soc0) : null,
  };
}

function monthBill(opts) {
  const o = opts || {};
  const days = Math.max(7, Math.min(62, o.days || 30));
  const seed = o.seed == null ? 11 : o.seed;
  let kwh = 0;
  let costNo = 0;
  let costBat = 0;
  let exportKwh = 0;
  const daily = [];
  for (let d = 1; d <= days; d++) {
    const w = 0.35 + 0.65 * (((seed * 7 + d * 13) % 97) / 97);
    const r = simulateDay({ ...o, month: o.month || 7, day: d, weather: w });
    kwh += r.kwh_buy_no_bat;
    exportKwh += r.kwh_export;
    costNo += r.cost_no_bat;
    costBat += r.cost_bat || 0;
    daily.push({ day: d, cost_no_bat: r.cost_no_bat, cost_bat: r.cost_bat, weather: Math.round(w * 100) / 100 });
  }
  const surcharge = tariff.tierSurcharge(kwh, o.tier);
  const total = kwh > 0 ? surcharge : 0;
  return {
    days,
    kwh: Math.round(kwh * 100) / 100,
    export_kwh: Math.round(exportKwh * 100) / 100,
    tier_surcharge: Math.round(surcharge * 100) / 100,
    cost_no_bat: Math.round((costNo + total) * 100) / 100,
    cost_bat: Math.round((costBat + total) * 100) / 100,
    save: Math.round((costNo - costBat) * 100) / 100,
    daily,
  };
}

module.exports = { simulateDay, monthBill };
