"use strict";

const DEFAULT_TOU = [
  { start: 8, end: 11, price: 1.02, label: "峰" },
  { start: 18, end: 22, price: 1.02, label: "峰" },
  { start: 6, end: 8, price: 0.63, label: "平" },
  { start: 11, end: 18, price: 0.63, label: "平" },
  { start: 22, end: 24, price: 0.63, label: "平" },
  { start: 0, end: 6, price: 0.32, label: "谷" },
];

const DEFAULT_TIER = [
  { limit: 200, surcharge: 0 },
  { limit: 400, surcharge: 0.05 },
  { limit: Infinity, surcharge: 0.2 },
];

function touPrice(hour, tou) {
  const table = tou || DEFAULT_TOU;
  for (const seg of table) {
    if (hour >= seg.start && hour < seg.end) return seg.price;
  }
  return 0.6;
}

function touLabel(hour, tou) {
  const table = tou || DEFAULT_TOU;
  for (const seg of table) {
    if (hour >= seg.start && hour < seg.end) return seg.label;
  }
  return "—";
}

function tierSurcharge(monthKwh, tier) {
  const t = tier || DEFAULT_TIER;
  let total = 0;
  let remaining = Math.max(0, monthKwh);
  let prev = 0;
  for (const seg of t) {
    const span = Math.min(seg.limit, monthKwh) - prev;
    if (span > 0) total += span * seg.surcharge;
    prev = seg.limit;
    if (monthKwh <= seg.limit) break;
  }
  return total;
}

// 已累计 monthKwh 度时，下一度购电所处档位的边际加价（元/kWh）。
// 与 tierSurcharge 的“按档累计”边界一致：累计量达到门槛（k >= limit）后，
// 下一度即按更高一档加价（前 200 度为第一档，第 201 度起 +0.05）。
// 月度逐日调度时传入当日优化器，使其能提前规避跨档。
function marginalSurcharge(monthKwh, tier) {
  const t = tier || DEFAULT_TIER;
  const k = Math.max(0, monthKwh || 0);
  let rate = t[0].surcharge;
  for (let i = 0; i + 1 < t.length; i++) {
    // 达到第 i 档门槛后，下一度进入第 i+1 档，适用其加价
    if (k >= t[i].limit && isFinite(t[i].limit)) rate = t[i + 1].surcharge;
  }
  return rate;
}

function hourlyPrices(tou) {
  const out = [];
  for (let h = 0; h < 24; h++) out.push(touPrice(h, tou));
  return out;
}

module.exports = { DEFAULT_TOU, DEFAULT_TIER, touPrice, touLabel, tierSurcharge, marginalSurcharge, hourlyPrices };
