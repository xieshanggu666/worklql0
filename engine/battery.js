"use strict";

function r3(x) {
  return Math.round(x * 1000) / 1000;
}

function optimizeBattery({ load, solar, price, feed, capKwh, maxKw, eff, soc0, tierRate }) {
  const H = 24;
  const n = 21;
  const step = capKwh / (n - 1);
  const socOf = i => i * step;
  const INF = Infinity;
  // soc0 统一为 0-1 的 SOC 比例（与界面一致），并吸附到最近的 SOC 网格点；
  // 这样逐日结转时前一天的末态网格点就是次日精确的初态，不会产生跨日偏差。
  const frac0 = Math.max(0, Math.min(1, soc0 == null ? 0.5 : soc0));
  const i0 = Math.max(0, Math.min(n - 1, Math.round(frac0 * (n - 1))));
  const eff2 = eff || 0.9;
  const maxP = Math.max(0, maxKw || 0);
  // 月度阶梯边际加价：购电价按当前档位抬升，使日内调度不会为谷电套利虚增购电量。
  const tier = Math.max(0, tierRate || 0);
  const buyPrice = h => price[h] + tier;

  let dp = new Array(n).fill(INF);
  dp[i0] = 0;
  const parents = [];

  for (let h = 0; h < H; h++) {
    const ndp = new Array(n).fill(INF);
    const par = new Array(n).fill(-1);
    const chActs = new Array(n).fill(0);
    const disActs = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const cur = dp[i];
      if (!isFinite(cur)) continue;
      const soc = socOf(i);
      for (let j = 0; j < n; j++) {
        const d = socOf(j) - soc;
        let ch = 0;
        let dis = 0;
        if (d > 1e-12) ch = d / eff2;
        else if (d < -1e-12) dis = -d;
        if (ch > maxP + 1e-9 || dis > maxP + 1e-9) continue;
        // 放电只供本地负荷：能由光伏直接满足的部分无需放电，
        // 电池放电上限为扣除光伏后的剩余负荷（电池不向电网反送），
        // 避免“谷电充电→富余时段放电上网”的虚假套利。
        const loadGap = Math.max(0, load[h] - solar[h]);
        const disUse = Math.min(dis, loadGap / eff2);
        if (dis - disUse > 1e-9) continue;
        const netLoad = Math.max(0, load[h] - disUse * eff2);
        const gridIn = Math.max(0, netLoad + ch - solar[h]);
        const exp = Math.max(0, solar[h] - netLoad - ch);
        const v = cur + buyPrice(h) * gridIn - feed * exp;
        if (v < ndp[j] - 1e-9) {
          ndp[j] = v;
          par[j] = i;
          chActs[j] = ch;
          disActs[j] = dis;
        }
      }
    }
    dp = ndp;
    parents.push({ par, chActs, disActs });
  }

  let j = 0;
  for (let i = 1; i < n; i++) if (dp[i] < dp[j]) j = i;
  const total = dp[j];

  const ch = new Array(H).fill(0);
  const dis = new Array(H).fill(0);
  const soc = new Array(H + 1).fill(0);
  soc[H] = socOf(j);
  for (let h = H - 1; h >= 0; h--) {
    const p = parents[h];
    ch[h] = p.chActs[j];
    dis[h] = p.disActs[j];
    j = p.par[j];
    soc[h] = socOf(j);
  }
  soc[0] = socOf(j);

  const hours = [];
  let kwhBuy = 0;
  let kwhExport = 0;
  for (let h = 0; h < H; h++) {
    const loadGap = Math.max(0, load[h] - solar[h]);
    const disUse = Math.min(dis[h], loadGap / eff2);
    const netLoad = Math.max(0, load[h] - disUse * eff2);
    const gridIn = Math.max(0, netLoad + ch[h] - solar[h]);
    const exp = Math.max(0, solar[h] - netLoad - ch[h]);
    kwhBuy += gridIn;
    kwhExport += exp;
    hours.push({
      h,
      ch: r3(ch[h]),
      dis: r3(disUse),
      soc: r3(soc[h] / capKwh),
      grid_in: r3(gridIn),
      export: r3(exp),
      net_load: r3(netLoad),
    });
  }
  return {
    hours,
    cost: total,
    kwh_buy: r3(kwhBuy),
    kwh_export: r3(kwhExport),
    soc0_frac: i0 / (n - 1),
    soc_end_kwh: r3(soc[H]),
    soc_end_frac: r3(soc[H] / capKwh),
  };
}

module.exports = { optimizeBattery };
