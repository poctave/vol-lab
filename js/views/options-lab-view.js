// options-lab-view.js — the Options Lab SANDBOX, rendered inside the
// terminal-options route. window.M1.lib.optionsLabView. Pricing lives in lib/lab-engine.js.
//
// Seven panels, each = static controls + an output box (#lx-*):
//   BLD position builder (free strike, free maturity per leg, hedge Δ, book presets)
//   MKT market: spot, r, q, ATM vol, term structure, SABR ρ / ν, smile dynamics, presets, arb check
//   PNL payoff: expiry / today / scenario horizon, with spot · vol · days sliders
//   SML the smile per maturity, legs as dots, 25Δ RR / BF quotes — or the whole surface in 3D
//       (strike × maturity × vol, drag to rotate, camera presets, hover readout)
//   GRK any Greek across spot or across strike moneyness, at up to four horizons
//   EXP P&L explain: the scenario's P&L split into Taylor terms + residual
//   RSK risk matrix: spot shocks × vol shocks; click a cell to go there
// Sliders refresh only the output boxes (re-rendering the whole page would drop the slider
// mid-drag); structural edits (legs, toggles) re-render through ctx.rerender. State persists
// in localStorage (M1.options.lab).
(function () {
  "use strict";
  function L() { return window.M1.lib.labEngine; }
  function OM() { return window.M1.lib.optionsMath; }
  function F() { return window.M1.lib.terminalFrame; }
  function esc(s) { return F().esc(s); }

  var KEY = "M1.options.lab";
  var TENORS = [["1W", 7], ["2W", 14], ["1M", 30], ["2M", 61], ["3M", 91], ["6M", 182], ["9M", 274], ["1Y", 365], ["2Y", 730]];
  var GREEKS = [
    ["delta", "Δ", "Delta", "per 1 of spot"], ["gamma", "Γ", "Gamma", "Δ per 1 of spot"], ["vega", "ν", "Vega", "per vol pt"],
    ["theta", "Θ", "Theta", "per day"], ["vanna", "∂Δ/∂σ", "Vanna", "Δ per vol pt"], ["volga", "∂ν/∂σ", "Volga", "ν per vol pt"],
    ["charm", "∂Δ/∂t", "Charm", "Δ per day"], ["rho", "ρ", "Rho", "per 1% rate"]
  ];
  var CURVE = ["var(--t-blue)", "var(--t-amber)", "var(--t-purple)", "var(--t-src-mental-math)", "var(--t-src-masters)"];

  var S = null;   // { mkt, legs, scen: { spotPct, shift, elapsed }, ui: { greek, axis, horizons, smileX, smView, cam } }

  function fresh() {
    return {
      mkt: JSON.parse(JSON.stringify(L().DEFAULT_MKT)),
      legs: [{ t: "C", q: 1, k: 100, days: 91 }, { t: "P", q: 1, k: 100, days: 91 }],
      scen: { spotPct: 0, shift: 0, elapsed: 0 },
      ui: { greek: "gamma", axis: "spot", horizons: true, smileX: "strike" }
    };
  }
  function load() {
    if (S) return S;
    S = fresh();
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY));
      if (saved && saved.mkt && Array.isArray(saved.legs)) {
        ["mkt", "scen", "ui"].forEach(function (k) { for (var f in (saved[k] || {})) S[k][f] = saved[k][f]; });
        // surfaces saved before the SABR rework carry skew/smile and no ρ/ν: keep the defaults
        delete S.mkt.skew; delete S.mkt.smile;
        S.legs = saved.legs;
      }
    } catch (_e) {}
    return S;
  }
  var saveTimer = null;
  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { window.localStorage.setItem(KEY, JSON.stringify(S)); } catch (_e) {}
    }, 250);
  }

  // ---------- helpers ----------
  function pos() { return S.legs.filter(function (l) { return l.q !== 0 && (l.t === "S" || (l.k > 0 && l.days > 0)); }); }
  function point() { return { S: S.mkt.spot * (1 + S.scen.spotPct / 100), shift: S.scen.shift, elapsed: S.scen.elapsed }; }
  function maxDays() { return Math.max(1, L().lastExpiry(pos())); }
  function f(v, dp) {
    if (!isFinite(v)) return "—";
    var a = Math.abs(v);
    if (dp == null) dp = a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
    return (v < 0 ? "−" : "") + Math.abs(v).toFixed(dp);
  }
  function sf(v, dp) { return (v > 0 ? "+" : "") + f(v, dp); }
  function tenorName(days) {
    for (var i = 0; i < TENORS.length; i++) if (TENORS[i][1] === days) return TENORS[i][0];
    return days + "d";
  }
  function strikes() {
    var ks = [];
    pos().forEach(function (l) { if (l.t !== "S" && ks.indexOf(l.k) < 0) ks.push(l.k); });
    return ks.sort(function (a, b) { return a - b; });
  }

  // ---------- generic plot ----------
  // o: { xs, series: [{ ys, stroke, width, dash, op }], fill (index shaded green/red vs 0),
  //      h, xTicks: [{ x, label, strong }], yMin, yMax, zero, marker: { x, y, label },
  //      dots: [{ x, y, fill }], vline }
  var seq = 0;
  function plot(o) {
    var W = 600, H = o.h || 230, Lp = 52, R = 12, T = 12, B = 24, xs = o.xs;
    var lo = xs[0], hi = xs[xs.length - 1];
    var all = o.zero === false ? [] : [0];
    o.series.forEach(function (s) { s.ys.forEach(function (v) { if (isFinite(v)) all.push(v); }); });
    (o.dots || []).forEach(function (d) { all.push(d.y); });
    var yMin = o.yMin != null ? o.yMin : Math.min.apply(null, all), yMax = o.yMax != null ? o.yMax : Math.max.apply(null, all);
    if (o.yMin == null || o.yMax == null) {
      var pad = (yMax - yMin) * 0.1 || Math.abs(yMax) * 0.1 || 1;
      if (o.yMin == null) yMin -= pad;
      if (o.yMax == null) yMax += pad;
    }
    var sx = function (v) { return Lp + (v - lo) / (hi - lo) * (W - Lp - R); };
    var sy = function (v) { return T + (yMax - v) / (yMax - yMin) * (H - T - B); };
    var id = "lx" + (++seq), out = '<svg class="opt-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">';
    var raw = (yMax - yMin) / 4, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), n = raw / mag;
    var step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    for (var g = Math.ceil(yMin / step) * step; g <= yMax + step * 1e-6; g += step) {
      var gy = sy(g).toFixed(1);
      out += '<line x1="' + Lp + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" style="stroke:var(--t-line);" stroke-width="1"/>' +
        '<text x="' + (Lp - 5) + '" y="' + (+gy + 3) + '" text-anchor="end" class="opt-ax">' + (Math.abs(g) < step * 1e-6 ? "0" : (o.yFmt || f)(g)) + '</text>';
    }
    if (yMin < 0 && yMax > 0) {
      out += '<line x1="' + Lp + '" x2="' + (W - R) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" style="stroke:var(--t-dim);" stroke-width="1"/>';
    }
    if (o.vline != null) {
      var vx = sx(o.vline).toFixed(1);
      out += '<line x1="' + vx + '" x2="' + vx + '" y1="' + T + '" y2="' + (H - B) + '" style="stroke:var(--t-line2);" stroke-dasharray="2 4" stroke-width="1"/>';
    }
    (o.xTicks || []).forEach(function (t) {
      if (t.x < lo || t.x > hi) return;
      var tx = sx(t.x).toFixed(1);
      out += '<line x1="' + tx + '" x2="' + tx + '" y1="' + (H - B) + '" y2="' + (H - B + 4) + '" style="stroke:var(--t-dim);" stroke-width="1"/>' +
        '<text x="' + tx + '" y="' + (H - 6) + '" text-anchor="middle" class="opt-ax' + (t.strong ? " is-k" : "") + '">' + esc(t.label) + '</text>';
    });
    out += '<clipPath id="' + id + 'c"><rect x="' + Lp + '" y="' + T + '" width="' + (W - Lp - R) + '" height="' + (H - T - B) + '"/></clipPath><g clip-path="url(#' + id + 'c)">';
    function line(ys) {
      return ys.map(function (v, i) { return isFinite(v) ? sx(xs[i]).toFixed(1) + "," + sy(v).toFixed(1) : null; }).filter(Boolean).join(" ");
    }
    if (o.fill != null && o.series[o.fill] && yMin < 0 && yMax > 0) {
      var z = sy(0), poly = sx(lo).toFixed(1) + "," + z.toFixed(1) + " " + line(o.series[o.fill].ys) + " " + sx(hi).toFixed(1) + "," + z.toFixed(1);
      out += '<clipPath id="' + id + 'u"><rect x="0" y="0" width="' + W + '" height="' + z.toFixed(1) + '"/></clipPath>' +
        '<clipPath id="' + id + 'd"><rect x="0" y="' + z.toFixed(1) + '" width="' + W + '" height="' + (H - z).toFixed(1) + '"/></clipPath>' +
        '<polygon points="' + poly + '" clip-path="url(#' + id + 'u)" style="fill:var(--t-green);" fill-opacity="0.10"/>' +
        '<polygon points="' + poly + '" clip-path="url(#' + id + 'd)" style="fill:var(--t-red);" fill-opacity="0.10"/>';
    }
    o.series.forEach(function (s) {
      out += '<polyline points="' + line(s.ys) + '" fill="none" style="stroke:' + s.stroke + ';" stroke-width="' + (s.width || 1.6) + '"' +
        (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + (s.op ? ' opacity="' + s.op + '"' : '') + '/>';
    });
    (o.dots || []).forEach(function (d) {
      out += '<circle cx="' + sx(d.x).toFixed(1) + '" cy="' + sy(d.y).toFixed(1) + '" r="4.5" style="fill:' + d.fill + ';stroke:var(--t-bg);" stroke-width="1.5"/>';
    });
    out += '</g>';
    if (o.marker && isFinite(o.marker.y)) {
      var mx = sx(o.marker.x), my = sy(o.marker.y);
      out += '<line x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" style="stroke:var(--t-blue);" stroke-width="1" opacity="0.4"/>' +
        '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="5" style="fill:var(--t-blue);stroke:var(--t-bg);" stroke-width="2"/>' +
        '<text x="' + Math.min(W - R - 4, mx + 8).toFixed(1) + '" y="' + Math.max(T + 10, my - 8).toFixed(1) + '" text-anchor="' + (mx > W - 90 ? "end" : "start") +
        '" class="opt-hv">' + esc(o.marker.label) + '</text>';
    }
    return out + '</svg>';
  }
  function legend(items) {
    return '<div class="opt-legend td">' + items.map(function (it) {
      return '<span><i' + (it.dash ? ' class="dash" style="border-color:' + it.c + ';"' : ' style="background:' + it.c + ';"') + '></i>' + esc(it.t) + '</span>';
    }).join("") + '</div>';
  }
  function spotTicks(lo, hi) {
    var m = S.mkt, ticks = [{ x: m.spot, label: f(m.spot, m.spot >= 100 ? 0 : 1), strong: false }];
    strikes().forEach(function (k) {
      if (Math.abs(k - m.spot) > (hi - lo) * 0.04) ticks.push({ x: k, label: f(k, k >= 100 ? 0 : 1), strong: true });
    });
    [lo, hi].forEach(function (x) { ticks.push({ x: x, label: f(x, x >= 100 ? 0 : 1) }); });
    return ticks;
  }
  function slider(id, label, min, max, step, val, unit) {
    return '<div class="lx-sl"><span class="lb td">' + label + '</span>' +
      '<input type="range" data-lx-sl="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<span class="vl tw" data-lx-val="' + id + '">' + sliderText(id, val) + '</span>' + (unit ? '' : '') + '</div>';
  }
  function sliderText(id, v) {
    v = +v;
    switch (id) {
      case "atm": return v.toFixed(1) + "%";
      case "term": return sf(v, 1) + " pts";
      case "rho": return "ρ " + sf(v, 2);
      case "nu": return "ν " + f(v, 2);
      case "spotPct": return sf(v, 1) + "%";
      case "shift": return sf(v, 1) + " vol";
      case "elapsed": return "day " + v;
    }
    return String(v);
  }

  // ======================================================================
  // panels
  // ======================================================================
  function render() {
    load();
    var panel = F().panel;
    return panel("BLD", "LAB · POSITION", '', bldControls() + '<div id="lx-legs">' + outLegs() + '</div>') +
      panel("MKT", "MARKET", '<span class="td">the lab’s own surface</span>', mktControls() + '<div id="lx-mkt">' + outMkt() + '</div>') +
      panel("PNL", "PAYOFF · SCENARIO", "", '<div id="lx-pnl">' + outPnl() + '</div>' + pnlControls()) +
      panel("SML", S.ui.smView === "3d" ? "VOL SURFACE" : "VOL SMILE", "", smlControls() + '<div id="lx-smile">' + outSmile() + '</div>') +
      panel("GRK", "GREEKS ACROSS " + (S.ui.axis === "strike" ? "MONEYNESS" : "SPOT"), "", grkControls() + '<div id="lx-grk">' + outGreek() + '</div>') +
      panel("EXP", "P&L EXPLAIN", '<span class="td">start → scenario</span>', '<div id="lx-exp">' + outExplain() + '</div>') +
      panel("RSK", "RISK MATRIX", '<span class="td">P&amp;L · spot shock × vol shock · at day ' + '<span id="lx-rsk-day">' + S.scen.elapsed + '</span></span>',
        '<div id="lx-rsk">' + outRisk() + '</div>');
  }

  // ---------- BLD ----------
  // What the position is: a book strategy (C2 classifier, any strikes/maturities that fit),
  // a diagonal, a delta-hedged version of either, or just custom.
  function positionName(p) {
    function named(legs) {
      var book = L().toBookLegs(legs), ids = book && book.length ? OM().classify(book) : [];
      if (ids.length) return OM().strategy(ids[0]).name;
      var o = legs.filter(function (l) { return l.t !== "S"; });
      if (o.length === 2 && !legs.some(function (l) { return l.t === "S"; }) && o[0].t === o[1].t &&
          o[0].days !== o[1].days && o[0].k !== o[1].k && o[0].q * o[1].q < 0) return "Diagonal spread";
      return null;
    }
    if (!p.length) return null;
    if (p.length === 1 && p[0].t === "S") return (p[0].q > 0 ? "Long" : "Short") + " stock";
    var n = named(p);
    if (n) return n;
    var st = p.filter(function (l) { return l.t === "S"; })[0];
    if (st && Math.round(st.q) !== st.q) {
      var core = named(p.filter(function (l) { return l.t !== "S"; }));
      return "Δ-hedged " + (core ? core.charAt(0).toLowerCase() + core.slice(1) : "position");
    }
    return "";
  }

  function bldControls() {
    var p = pos(), nm = positionName(p);
    var name = nm == null ? '<span class="tf">add legs to start</span>'
      : nm ? '<span class="tg">' + esc(nm) + '</span>' : '<span class="ta">custom position</span>';

    var rows = S.legs.map(function (l, i) {
      var st = l.t === "S";
      return '<div class="opt-leg lx-leg' + (l.q > 0 ? " is-long" : " is-short") + '">' +
        '<button class="play-btn opt-side" data-lx-leg="' + i + '" data-lx-act="side">' + (l.q > 0 ? "LONG" : "SHORT") + '</button>' +
        (st
          ? '<input class="lx-in lx-qty" type="number" step="0.01" data-lx-leg="' + i + '" data-lx-field="qabs" value="' + Math.abs(l.q) + '" title="quantity">'
          : '<span class="opt-qty"><button class="play-btn" data-lx-leg="' + i + '" data-lx-act="qdn">−</button><span class="tw">' + Math.abs(l.q) + '×</span>' +
            '<button class="play-btn" data-lx-leg="' + i + '" data-lx-act="qup">+</button></span>') +
        '<button class="play-btn opt-type" data-lx-leg="' + i + '" data-lx-act="type">' + (st ? "STOCK" : l.t === "C" ? "CALL" : "PUT") + '</button>' +
        (st ? '<span class="lx-k td">@ ' + f(S.mkt.spot, 2) + '</span><span class="lx-days"></span>'
          : '<span class="lx-k"><span class="td">K</span><input class="lx-in" type="number" step="any" min="0.01" data-lx-leg="' + i + '" data-lx-field="k" value="' + l.k + '"></span>' +
            '<span class="lx-days"><input class="lx-in lx-d" type="number" step="1" min="1" max="1825" data-lx-leg="' + i + '" data-lx-field="days" value="' + l.days + '">' +
            '<select class="lx-tenor" data-lx-leg="' + i + '" data-lx-field="tenor">' +
              '<option value="">' + esc(tenorName(l.days)) + '</option>' +
              TENORS.map(function (t) { return '<option value="' + t[1] + '">' + t[0] + '</option>'; }).join("") +
            '</select></span>') +
        '<button class="play-btn opt-del" data-lx-leg="' + i + '" data-lx-act="del" aria-label="Remove leg">✕</button>' +
      '</div>';
    }).join("");
    var presets = '<option value="">load a strategy…</option>' + window.M1.data.optionStrategies.strategies.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join("");
    return '<div class="opt-labhead"><span class="td">YOU BUILT</span> <span class="opt-labname">' + name + '</span>' +
        '<span class="grow"></span><select class="opt-preset" data-lx-preset="1">' + presets + '</select></div>' +
      '<div class="opt-builder">' + (rows || '<div class="opt-empty tf">no legs yet — add one</div>') +
      '<div class="opt-add"><button class="play-btn" data-lx-add="C">+ CALL</button><button class="play-btn" data-lx-add="P">+ PUT</button>' +
        '<button class="play-btn" data-lx-add="S">+ STOCK</button>' +
        '<button class="play-btn" data-lx-hedge="1" title="add the stock that makes the position delta-neutral at the start">HEDGE Δ</button>' +
        '<span class="grow"></span>' + (S.legs.length ? '<button class="play-btn" data-lx-clear="1">CLEAR</button>' : '') + '</div></div>';
  }
  function outLegs() {
    var m = S.mkt, p = pos();
    if (!p.length) return "";
    var rows = p.map(function (l) {
      var g = L().greeks(m, [{ t: l.t, q: 1, k: l.k, days: l.days }], { S: m.spot, elapsed: 0, shift: 0 });
      var iv = L().legIv(m, l), side = l.q > 0 ? "+" : "−";
      var what = l.t === "S" ? "stock" : f(l.k, l.k >= 100 ? 1 : 2) + " " + (l.t === "C" ? "call" : "put") + " · " + tenorName(l.days);
      return '<tr><td class="' + (l.q > 0 ? "tg" : "tr") + '">' + side + Math.abs(l.q) + '</td><td class="lx-what">' + esc(what) + '</td>' +
        '<td class="num">' + (iv == null ? "—" : f(iv, 1) + "%") + '</td>' +
        '<td class="num">' + (l.t === "S" ? "—" : f(L().legCost(m, l), 2)) + '</td>' +
        '<td class="num">' + f(g.delta, 2) + '</td><td class="num">' + f(g.gamma, 3) + '</td>' +
        '<td class="num">' + f(g.vega, 2) + '</td><td class="num">' + f(g.theta, 3) + '</td></tr>';
    }).join("");
    var prem = L().premium(m, p);
    return '<table class="tt lx-legs"><thead><tr><th>QTY</th><th>LEG</th><th class="num">IV</th><th class="num">PRICE</th>' +
      '<th class="num">Δ</th><th class="num">Γ</th><th class="num">ν</th><th class="num">Θ</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="lx-note td">per unit, at the start · net option premium <span class="' + (prem > 0 ? "ta" : "tg") + '">' +
      (prem > 0 ? "pay " : "receive ") + f(Math.abs(prem), 2) + '</span>' +
      (p.some(function (l) { return l.t === "S"; }) ? " + stock" : "") + '</div>';
  }

  // ---------- MKT ----------
  function mktControls() {
    var m = S.mkt;
    var presets = '<option value="">surface preset…</option>' + L().PRESETS.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.label) + '</option>';
    }).join("");
    function num(field, label, step, val, unit) {
      return '<label class="lx-num"><span class="lb td">' + label + '</span><input class="lx-in" type="number" step="' + step + '" data-lx-mkt="' + field + '" value="' + val + '"><span class="td">' + unit + '</span></label>';
    }
    return '<div class="lx-mktrow">' + num("spot", "SPOT S₀", "any", m.spot, "") + num("r", "RATE r", "0.25", m.r, "%") + num("q", "DIV q", "0.25", m.q, "%") + '</div>' +
      slider("atm", "ATM VOL 3M", 1, 80, 0.5, m.atm) +
      slider("term", "1Y − 3M", -20, 20, 0.5, m.term) +
      slider("rho", "SKEW ρ", -0.95, 0.95, 0.01, m.rho) +
      slider("nu", "VOL OF VOL ν", 0, 2, 0.05, m.nu) +
      '<div class="play-set opt-seg"><span class="lb td">DYNAMICS</span>' +
        '<button class="play-btn' + (m.dyn === "strike" ? " is-on" : "") + '" data-lx-dyn="strike" title="a strike keeps its vol when spot moves">STICKY STRIKE</button>' +
        '<button class="play-btn' + (m.dyn === "moneyness" ? " is-on" : "") + '" data-lx-dyn="moneyness" title="the smile moves with the forward">STICKY MONEYNESS</button></div>' +
      '<div class="lx-mktrow"><select class="opt-preset lx-wide" data-lx-surface="1">' + presets + '</select></div>';
  }
  function outMkt() {
    var m = S.mkt;
    var rows = [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365], ["2Y", 730]].map(function (t) {
      var T = t[1] / 365, qd = L().quotes(m, T);
      return '<tr><td class="td">' + t[0] + '</td><td class="num">' + f(qd.forward, 2) + '</td><td class="num tw">' + f(qd.atm, 1) + '%</td>' +
        '<td class="num ' + (qd.rr < -0.05 ? "tr" : qd.rr > 0.05 ? "tg" : "td") + '">' + sf(qd.rr, 2) + '</td><td class="num">' + sf(qd.bf, 2) + '</td></tr>';
    }).join("");
    var bad = [["1W", 7], ["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365], ["2Y", 730]].map(function (t) {
      var a = L().arbCheck(m, t[1] / 365);
      return a.ok ? null : t[0] + " (" + (a.kind === "butterfly" ? "butterfly" : "call spread") + " near K " + f(a.at, 1) + ")";
    }).filter(Boolean);
    return '<table class="tt lx-quotes"><thead><tr><th>TENOR</th><th class="num">FORWARD</th><th class="num">ATM</th>' +
      '<th class="num">25Δ RR</th><th class="num">25Δ BF</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="lx-note ' + (bad.length ? "tr" : "tg") + '">' + (bad.length
        ? "⚠ arbitrage in the smile at " + esc(bad.join(", ")) + " — prices there are not tradeable; tone down ν or ρ"
        : "✓ no arbitrage: at every tenor, calls fall with strike and are convex (±4σ)") + '</div>' +
      '<div class="lx-note td">SABR (β = 1): ρ < 0 tilts vol up for low strikes (equity put skew), ρ > 0 for high strikes; ' +
      'ν (vol of vol, quoted at 3M, steeper for short tenors) curves the wings. ' +
      'RR = σ(25Δ call) − σ(25Δ put) · BF = average 25Δ wing − ATM</div>';
  }

  // ---------- PNL ----------
  function pnlControls() {
    var md = maxDays();
    if (S.scen.elapsed > md) S.scen.elapsed = md;
    return '<div class="lx-scen">' +
      slider("spotPct", "SPOT MOVE", -40, 40, 0.5, S.scen.spotPct) +
      slider("shift", "VOL SHIFT", -20, 20, 0.5, S.scen.shift) +
      slider("elapsed", "DAYS PASSED", 0, md, 1, S.scen.elapsed) +
      '<div class="lx-scenfoot"><button class="play-btn" data-lx-reset="1">RESET SCENARIO</button></div></div>';
  }
  function outPnl() {
    var m = S.mkt, p = pos();
    if (!p.length) return '<div class="opt-empty tf">the payoff draws itself as you add legs</div>';
    var lo = m.spot * 0.6, hi = m.spot * 1.4, xs = [];
    for (var i = 0; i <= 160; i++) xs.push(lo + (hi - lo) * i / 160);
    var fe = L().firstExpiry(p), pt = point();
    var hasOpt = p.some(function (l) { return l.t !== "S"; });
    var series = [], items = [];
    if (hasOpt) {
      series.push({ ys: xs.map(function (x) { return L().pnl(m, p, x, fe, 0); }), stroke: "var(--t-dim)", width: 1.4 });
      items.push({ c: "var(--t-dim)", t: (L().lastExpiry(p) > fe ? "at 1st expiry (day " + fe + ")" : "at expiry") });
    }
    var moved = pt.elapsed > 0 || pt.shift !== 0;
    if (moved) {
      series.push({ ys: xs.map(function (x) { return L().pnl(m, p, x, 0, 0); }), stroke: "var(--t-amber)", width: 1.3, dash: "6 4" });
      items.push({ c: "var(--t-amber)", t: "today", dash: true });
    }
    var hz = xs.map(function (x) { return L().pnl(m, p, x, pt.elapsed, pt.shift); });
    series.push({ ys: hz, stroke: "var(--t-blue)", width: 2.4 });
    items.push({ c: "var(--t-blue)", t: moved ? "scenario: day " + pt.elapsed + ", " + sf(pt.shift, 1) + " vol" : "today" });
    var here = L().pnl(m, p, pt.S, pt.elapsed, pt.shift);
    var be = L().crossings(xs, hz).map(function (b) { return f(b, b >= 100 ? 1 : 2); });
    var beExp = hasOpt ? L().crossings(xs, series[0].ys).map(function (b) { return f(b, b >= 100 ? 1 : 2); }) : [];
    return plot({ xs: xs, series: series, fill: series.length - 1, xTicks: spotTicks(lo, hi), vline: m.spot,
        marker: { x: pt.S, y: here, label: sf(here, 2) } }) +
      legend(items) +
      '<div class="opt-facts"><span><span class="td">AT SCENARIO</span> S ' + f(pt.S, 2) + ' <span class="td">(' + sf(S.scen.spotPct, 1) + '%)</span> → ' +
        '<span class="' + (here >= 0 ? "tg" : "tr") + '">P&amp;L ' + sf(here, 2) + '</span></span>' +
        (hasOpt ? '<span><span class="td">BREAKEVEN' + (beExp.length === 1 ? "" : "S") + ' · ' + (L().lastExpiry(p) > fe ? "1ST EXPIRY" : "EXPIRY") + '</span> ' + (beExp.join(" · ") || "none") + '</span>' : '') +
        '<span><span class="td">' + (moved ? "· SCENARIO" : "· TODAY") + '</span> ' + (be.join(" · ") || "none") + '</span></div>';
  }

  // ---------- SML ----------
  var SMILE_AXES = [
    ["strike", "STRIKE", "% of spot S₀"],
    ["moneyness", "K/F", "% of each tenor's forward — ATM is 100 at every tenor"],
    ["delta", "DELTA", "10Δ put → ATM → 10Δ call, the way desks quote the smile"]
  ];
  function smlControls() {
    var ax = S.ui.smileX || "strike", three = S.ui.smView === "3d";
    var view = '<div class="play-set opt-seg"><span class="lb td">VIEW</span>' +
      '<button class="play-btn' + (three ? "" : " is-on") + '" data-lx-smv="2d" title="one curve per maturity">SMILE</button>' +
      '<button class="play-btn' + (three ? " is-on" : "") + '" data-lx-smv="3d" title="strike × maturity × vol — drag to rotate">3D SURFACE</button></div>';
    var cams = three ? '<div class="play-set opt-seg"><span class="lb td">CAMERA</span>' + SURF_VIEWS.map(function (v) {
      return '<button class="play-btn" data-lx-cam="' + v[0] + '" title="' + esc(v[4]) + '">' + v[1] + '</button>';
    }).join("") + '</div>' : "";
    return view + '<div class="play-set opt-seg"><span class="lb td">X-AXIS</span>' + SMILE_AXES.map(function (a) {
      return '<button class="play-btn' + (ax === a[0] ? " is-on" : "") + '" data-lx-smx="' + a[0] + '" title="' + esc(a[2]) + '">' + a[1] + '</button>';
    }).join("") + '</div>' + cams;
  }

  // ---------- 3D surface ----------
  // An SVG mesh: x = the smile axis, y = maturity on a √T scale (short tenors get room),
  // z = implied vol. Orthographic camera (yaw, pitch); quads drawn far → near (painter's
  // algorithm), coloured by vol. Dragging only re-draws the <g>, so the pointer capture
  // on the <svg> survives; market changes re-draw the whole box through refresh().
  var SURF_DAYS = [7, 14, 30, 61, 91, 182, 274, 365, 548, 730];
  var SURF_VIEWS = [
    ["3d", "3D", -38, 26, "the default oblique view"],
    ["front", "SMILES", 0, 2, "look down the maturity axis: every smile stacked"],
    ["side", "TERM", -90, 2, "look down the strike axis: the term structure"],
    ["top", "TOP", 0, 89, "from above: a heatmap of the surface"]
  ];
  var RAMP = ["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d", "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c"];
  var SURF_R = 100;           // world → SVG units
  var surfPts = [];           // projected grid vertices, for the hover readout
  function rampColor(t) {
    t = Math.max(0, Math.min(1, t));
    var pos = t * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(pos)), u = pos - i;
    function ch(h, k) { return parseInt(h.substr(1 + 2 * k, 2), 16); }
    var rgb = [0, 1, 2].map(function (k) { return Math.round(ch(RAMP[i], k) + (ch(RAMP[i + 1], k) - ch(RAMP[i], k)) * u); });
    return "rgb(" + rgb.join(",") + ")";
  }
  function surfCam() {
    var c = S.ui.cam || {};
    return { yaw: typeof c.yaw === "number" ? c.yaw : SURF_VIEWS[0][2], pitch: typeof c.pitch === "number" ? c.pitch : SURF_VIEWS[0][3] };
  }
  function surfXLabel(x, ax) {
    if (ax === "delta") return x < 50 ? f(x, 0) + "Δp" : x > 50 ? f(100 - x, 0) + "Δc" : "ATM";
    return (ax === "moneyness" ? "K/F " : "K ") + f(x, 0) + "%";
  }
  function surfInner() {
    var m = S.mkt, p = pos(), sh = S.scen.shift, ax = S.ui.smileX || "strike";
    var lo = ax === "delta" ? 5 : 60, hi = ax === "delta" ? 95 : 140, N = 28, xs = [];
    for (var i = 0; i <= N; i++) xs.push(lo + (hi - lo) * i / N);
    var g = L().surface(m, ax, xs, SURF_DAYS, sh);
    var zlo = Math.floor(g.min / 5) * 5, zhi = Math.ceil(g.max / 5) * 5;
    if (zhi - zlo < 10) zhi = zlo + 10;
    var t0 = Math.sqrt(SURF_DAYS[0] / 365), t1 = Math.sqrt(SURF_DAYS[SURF_DAYS.length - 1] / 365);
    function U(x) { return (x - lo) / (hi - lo) * 2 - 1; }
    function V(d) { return (Math.sqrt(Math.max(SURF_DAYS[0], Math.min(730, d)) / 365) - t0) / (t1 - t0) * 2 - 1; }
    function W(z) { return (z - zlo) / (zhi - zlo) * 1.2 - 0.6; }
    var c = surfCam(), ya = c.yaw * Math.PI / 180, pa = c.pitch * Math.PI / 180;
    var cy = Math.cos(ya), sy = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa);
    function P(u, v, w) {
      var x1 = u * cy - v * sy, y1 = u * sy + v * cy;
      return { x: SURF_R * x1, y: -SURF_R * (w * cp + y1 * sp), d: y1 * cp - w * sp };
    }
    function pt(q) { return q.x.toFixed(1) + "," + q.y.toFixed(1); }
    function line(a, b, cls) { return '<line class="' + cls + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>'; }
    function text(q, s, cls, anchor) { return '<text class="' + cls + '" x="' + q.x.toFixed(1) + '" y="' + q.y.toFixed(1) + '" text-anchor="' + (anchor || "middle") + '">' + esc(s) + '</text>'; }

    // grid vertices
    var V3 = g.z.map(function (row, i) {
      return row.map(function (z, j) { return P(U(xs[j]), V(SURF_DAYS[i]), W(z)); });
    });
    surfPts = [];
    V3.forEach(function (row, i) { row.forEach(function (q, j) { surfPts.push({ x: q.x, y: q.y, i: i, j: j, x0: xs[j], z: g.z[i][j] }); }); });

    // floor + axes (behind the mesh)
    var fz = -0.6, out = [];
    var c00 = P(-1, -1, fz), c10 = P(1, -1, fz), c11 = P(1, 1, fz), c01 = P(-1, 1, fz);
    out.push('<polygon class="sf-floor" points="' + [c00, c10, c11, c01].map(pt).join(" ") + '"/>');
    var xt = ax === "delta" ? [10, 25, 50, 75, 90] : [60, 80, 100, 120, 140];
    // An axis seen end-on collapses its labels onto one spot: skip those (front view hides
    // maturity, side view hides strike, top view hides vol).
    var showX = Math.abs(cy) > 0.2 || pa > 1.2, showT = Math.abs(sy) > 0.2 || pa > 1.2, showZ = c.pitch < 75;
    xt.forEach(function (x) {
      var a = P(U(x), -1, fz), b = P(U(x), 1, fz);
      out.push(line(a, b, "sf-grid"));
      if (showX) out.push(text(P(U(x), -1.18, fz), surfXLabel(x, ax).replace(/^K(\/F)? /, ""), "sf-lbl"));
    });
    [[7, "1W"], [30, "1M"], [91, "3M"], [182, "6M"], [365, "1Y"], [730, "2Y"]].forEach(function (t) {
      var a = P(-1, V(t[0]), fz), b = P(1, V(t[0]), fz);
      out.push(line(a, b, "sf-grid"));
      if (showT) out.push(text(P(1.16, V(t[0]), fz), t[1], "sf-lbl", "start"));
    });
    if (showZ) {
      for (var zv = zlo; zv <= zhi + 1e-9; zv += (zhi - zlo > 30 ? 10 : 5)) {
        var qa = P(-1, 1, W(zv)), qb = P(-1.06, 1, W(zv));
        out.push(line(qa, qb, "sf-axis"));
        out.push(text(P(-1.12, 1, W(zv)), zv + "%", "sf-lbl", "end"));
      }
      out.push(line(P(-1, 1, fz), P(-1, 1, 0.6), "sf-axis"));
    }
    if (showX) out.push(text(P(0, -1.36, fz), ax === "delta" ? "DELTA" : ax === "moneyness" ? "K / F" : "STRIKE % S₀", "sf-ttl"));
    if (showT && Math.abs(cy) > 0.2) out.push(text(P(1.5, 0, fz), "MATURITY", "sf-ttl", "start"));

    // mesh, far → near
    var quads = [];
    for (var a = 0; a < V3.length - 1; a++) {
      for (var b = 0; b < xs.length - 1; b++) {
        var q = [V3[a][b], V3[a][b + 1], V3[a + 1][b + 1], V3[a + 1][b]];
        var zAvg = (g.z[a][b] + g.z[a][b + 1] + g.z[a + 1][b + 1] + g.z[a + 1][b]) / 4;
        quads.push({ d: (q[0].d + q[1].d + q[2].d + q[3].d) / 4, pts: q, col: rampColor((zAvg - zlo) / (zhi - zlo)) });
      }
    }
    quads.sort(function (x, y) { return y.d - x.d; });
    quads.forEach(function (q) { out.push('<polygon class="sf-q" fill="' + q.col + '" points="' + q.pts.map(pt).join(" ") + '"/>'); });

    // ATM line and arbitrage-failing tenors, on top
    var atx = ax === "delta" ? 50 : 100;
    var atm = SURF_DAYS.map(function (d) { return P(U(atx), V(d), W(L().smileCurve(m, d / 365, ax, [atx], sh)[0])); });
    out.push('<polyline class="sf-atm" points="' + atm.map(pt).join(" ") + '"/>');
    g.arb.forEach(function (ok, i) {
      if (!ok) out.push('<polyline class="sf-arb" points="' + V3[i].map(pt).join(" ") + '"/>');
    });

    // the position's legs, sitting on the surface
    var mats = [];
    p.forEach(function (l) { if (l.t !== "S" && mats.indexOf(l.days) < 0) mats.push(l.days); });
    mats.sort(function (x, y) { return x - y; });
    p.forEach(function (l) {
      if (l.t === "S") return;
      var T = l.days / 365, x = L().smileX(m, l.k, T, ax);
      if (x < lo || x > hi) return;
      var q = P(U(x), V(l.days), W(L().vol(m, l.k, T, m.spot, sh)));
      out.push('<circle class="sf-leg" cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="4" fill="' + CURVE[Math.max(0, mats.indexOf(l.days)) % CURVE.length] + '"/>');
    });
    out.push('<circle id="lx-surf-hl" class="sf-hl" cx="0" cy="0" r="0"/>');
    S._surf = { zlo: zlo, zhi: zhi, arbBad: g.arb.filter(function (ok) { return !ok; }).length };
    return out.join("");
  }
  function outSurface() {
    var inner = surfInner(), info = S._surf, sh = S.scen.shift;
    return '<svg class="lx-surf" viewBox="-185 -150 400 300" role="img" aria-label="implied volatility surface">' +
      '<g id="lx-surf-g">' + inner + '</g></svg>' +
      '<div class="lx-note"><span id="lx-surf-read">hover for a point · drag to rotate · double-click to reset</span></div>' +
      '<div class="lx-note td"><span class="lx-ramp" style="background:linear-gradient(90deg,' + RAMP.join(",") + ');"></span> ' +
      info.zlo + '% → ' + info.zhi + '% · dashed = ATM' + ((S.ui.smileX || "strike") === "delta" ? " (50Δ)" : " (K = 100% on this axis)") +
      ' · dots = your legs' + (info.arbBad ? ' · <span class="tr">red = a tenor whose smile admits arbitrage</span>' : '') +
      ' · moves live with ATM / term / ρ / ν' + (sh ? " and the " + sf(sh, 1) + " scenario shift" : "") + '</div>';
  }
  function wireSurface(box) {
    var drag = null;
    function svgPoint(svg, e) {
      var pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      var mtx = svg.getScreenCTM();
      return mtx ? pt.matrixTransform(mtx.inverse()) : null;
    }
    function redraw() {
      var gEl = box.querySelector("#lx-surf-g");
      if (gEl) gEl.innerHTML = surfInner();
    }
    box.addEventListener("pointerdown", function (e) {
      var svg = e.target.closest && e.target.closest("svg.lx-surf");
      if (!svg) return;
      var c = surfCam();
      drag = { x: e.clientX, y: e.clientY, yaw: c.yaw, pitch: c.pitch, svg: svg };
      try { svg.setPointerCapture(e.pointerId); } catch (_e) {}
      e.preventDefault();
    });
    box.addEventListener("pointermove", function (e) {
      if (drag) {
        S.ui.cam = {
          yaw: Math.round(drag.yaw + (e.clientX - drag.x) * 0.5),
          pitch: Math.max(0, Math.min(89, Math.round(drag.pitch + (e.clientY - drag.y) * 0.4)))
        };
        redraw();
        return;
      }
      var svg = e.target.closest && e.target.closest("svg.lx-surf"), read = box.querySelector("#lx-surf-read"), hl = box.querySelector("#lx-surf-hl");
      if (!svg || !read) return;
      var q = svgPoint(svg, e), best = null, bd = 144;
      if (!q) return;
      surfPts.forEach(function (v) {
        var dd = (v.x - q.x) * (v.x - q.x) + (v.y - q.y) * (v.y - q.y);
        if (dd < bd) { bd = dd; best = v; }
      });
      if (!best) { read.textContent = "hover for a point · drag to rotate · double-click to reset"; if (hl) hl.setAttribute("r", "0"); return; }
      read.innerHTML = '<span class="tw">' + esc(surfXLabel(best.x0, S.ui.smileX || "strike")) + '</span> · <span class="tw">' +
        esc(SURF_DAYS[best.i] === 548 ? "18M" : tenorName(SURF_DAYS[best.i])) + '</span> · σ <span class="tb">' + f(best.z, 1) + '%</span>';
      if (hl) { hl.setAttribute("cx", best.x.toFixed(1)); hl.setAttribute("cy", best.y.toFixed(1)); hl.setAttribute("r", "4"); }
    });
    function end() { if (drag) { drag = null; save(); } }
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("dblclick", function (e) {
      if (!(e.target.closest && e.target.closest("svg.lx-surf"))) return;
      S.ui.cam = { yaw: SURF_VIEWS[0][2], pitch: SURF_VIEWS[0][3] };
      save(); redraw();
    });
  }

  function outSmile() {
    if (S.ui.smView === "3d") return outSurface();
    var m = S.mkt, p = pos(), sh = S.scen.shift, ax = S.ui.smileX || "strike";
    var mats = [];
    p.forEach(function (l) { if (l.t !== "S" && mats.indexOf(l.days) < 0) mats.push(l.days); });
    mats.sort(function (a, b) { return a - b; });
    if (!mats.length) mats = [30, 91, 365];
    mats = mats.slice(0, 5);
    var lo = ax === "delta" ? 5 : 60, hi = ax === "delta" ? 95 : 140, xs = [];
    for (var i = 0; i <= 120; i++) xs.push(lo + (hi - lo) * i / 120);
    var series = mats.map(function (d, j) {
      return { ys: L().smileCurve(m, d / 365, ax, xs, sh), stroke: CURVE[j], width: 2 };
    });
    var dots = [];
    p.forEach(function (l) {
      if (l.t === "S") return;
      var j = mats.indexOf(l.days), T = l.days / 365, x = L().smileX(m, l.k, T, ax);
      if (x >= lo && x <= hi) dots.push({ x: x, y: L().vol(m, l.k, T, m.spot, sh), fill: CURVE[Math.max(0, j)] });
    });
    var ticks = ax === "delta"
      ? [[5, "5Δp"], [10, "10Δp"], [25, "25Δp"], [50, "ATM"], [75, "25Δc"], [90, "10Δc"], [95, "5Δc"]].map(function (t) {
          return { x: t[0], label: t[1], strong: t[0] === 50 };
        })
      : [60, 80, 90, 100, 110, 120, 140].map(function (x) { return { x: x, label: x + "%", strong: x === 100 }; });
    var quotes = mats.map(function (d, j) {
      var q = L().quotes(m, d / 365);
      return '<span style="color:' + CURVE[j] + ';">' + esc(tenorName(d)) + '</span> <span class="td">ATM</span> ' + f(q.atm + sh, 1) +
        ' <span class="td">RR</span> ' + sf(q.rr, 2) + ' <span class="td">BF</span> ' + sf(q.bf, 2);
    }).join(' <span class="tf">·</span> ');
    var axisTxt = { strike: "strike as % of spot", moneyness: "strike as % of each tenor's forward (K/F) — tenors line up at ATM",
      delta: "call delta, read put wing → call wing (x = 100·(1 − Δcall)): 25Δp sits at 25, 25Δc at 75 — RR is their gap" }[ax];
    return plot({ xs: xs, series: series, dots: dots, xTicks: ticks, vline: ax === "delta" ? 50 : 100, zero: false, h: 210,
        yFmt: function (v) { return f(v, 0) + "%"; } }) +
      '<div class="lx-note">' + quotes + '</div>' +
      '<div class="lx-note td">implied vol vs ' + esc(axisTxt) + ' · dots = your legs · moves live with ATM / term / ρ / ν' +
      (sh ? " and the " + sf(sh, 1) + " scenario shift" : "") + '</div>';
  }

  // ---------- GRK ----------
  function grkControls() {
    var u = S.ui;
    return '<div class="lx-grkbar">' + GREEKS.map(function (g) {
      return '<button class="play-btn' + (u.greek === g[0] ? " is-on" : "") + '" data-lx-greek="' + g[0] + '" title="' + esc(g[2] + " · " + g[3]) + '">' + esc(g[1]) + '</button>';
    }).join("") + '</div>' +
      '<div class="play-set opt-seg"><span class="lb td">X-AXIS</span>' +
        '<button class="play-btn' + (u.axis === "spot" ? " is-on" : "") + '" data-lx-axis="spot">SPOT</button>' +
        '<button class="play-btn' + (u.axis === "strike" ? " is-on" : "") + '" data-lx-axis="strike" title="spot fixed; all strikes slide together — the first leg\'s K/S on the axis">MONEYNESS K/S</button>' +
        '<span class="grow"></span>' +
        '<button class="play-btn' + (u.horizons ? " is-on" : "") + '" data-lx-hz="1" title="overlay the same Greek later in the life of the trade">HORIZONS</button></div>';
  }
  function outGreek() {
    var m = S.mkt, p = pos(), u = S.ui, pt = point();
    if (!p.length) return '<div class="opt-empty tf">add legs to see their Greeks</div>';
    var gd = GREEKS.filter(function (g) { return g[0] === u.greek; })[0];
    var axis = u.axis === "strike" && p.some(function (l) { return l.t !== "S"; }) ? "strike" : "spot";
    var xs = [], lo, hi;
    if (axis === "spot") { lo = m.spot * 0.6; hi = m.spot * 1.4; }
    else { lo = 60; hi = 140; }
    for (var i = 0; i <= 100; i++) xs.push(lo + (hi - lo) * i / 100);
    var fe = L().firstExpiry(p);
    var hzs = [pt.elapsed];
    if (u.horizons && fe > 2) {
      [0, Math.round(fe * 0.5), Math.max(0, fe - Math.max(1, Math.round(fe * 0.1)))].forEach(function (d) {
        if (d !== pt.elapsed && d < fe && hzs.indexOf(d) < 0) hzs.push(d);
      });
    }
    var series = hzs.map(function (d, j) {
      return { ys: L().greekSeries(m, p, u.greek, { S: pt.S, elapsed: d, shift: pt.shift }, axis, xs),
        stroke: j === 0 ? "var(--t-blue)" : CURVE[j], width: j === 0 ? 2.4 : 1.3, dash: j === 0 ? null : "5 3" };
    });
    var lead = p.filter(function (l) { return l.t !== "S"; })[0];
    var hereX = axis === "spot" ? pt.S : 100 * lead.k / pt.S;
    var hereY = L().greek(m, p, u.greek, pt);
    var ticks = axis === "spot" ? spotTicks(lo, hi)
      : [60, 80, 90, 100, 110, 120, 140].map(function (x) { return { x: x, label: x + "%", strong: x === 100 }; });
    var items = hzs.map(function (d, j) { return { c: j === 0 ? "var(--t-blue)" : CURVE[j], t: "day " + d + (j === 0 ? " (scenario)" : ""), dash: j > 0 }; });
    var all = L().greeks(m, p, pt);
    var tiles = GREEKS.map(function (g) {
      var v = all[g[0]];
      return '<div class="lx-gt' + (g[0] === u.greek ? " is-on" : "") + '"><span class="gs">' + esc(g[1]) + '</span><span class="gv ' + (v > 1e-9 ? "tg" : v < -1e-9 ? "tr" : "td") + '">' +
        sf(v, Math.abs(v) >= 1 ? 2 : 3) + '</span></div>';
    }).join("");
    return plot({ xs: xs, series: series, xTicks: ticks, vline: axis === "spot" ? m.spot : 100, marker: { x: hereX, y: hereY, label: sf(hereY, 3) } }) +
      legend(items) +
      '<div class="lx-note td">' + esc(gd[2]) + ' (' + esc(gd[3]) + ') of the whole position · ' +
        (axis === "spot" ? "spot on the axis, strikes fixed" : "spot fixed at " + f(pt.S, 2) + ", every strike slid so the first leg's K/S is on the axis — the smile re-prices each point") +
        ' · bump-and-reprice on the lab surface (' + (m.dyn === "moneyness" ? "sticky moneyness" : "sticky strike") + ')</div>' +
      '<div class="lx-gtiles">' + tiles + '</div>';
  }

  // ---------- EXP ----------
  function outExplain() {
    var m = S.mkt, p = pos(), pt = point();
    if (!p.length) return '<div class="opt-empty tf">—</div>';
    var ex = L().explain(m, p, pt);
    var big = Math.max(1e-9, Math.abs(ex.actual));
    ex.terms.forEach(function (t) { big = Math.max(big, Math.abs(t.v)); });
    big = Math.max(big, Math.abs(ex.residual));
    function bar(label, v, cls) {
      var w = Math.round(Math.abs(v) / big * 100);
      return '<div class="lx-bar"><span class="lb' + (cls ? " " + cls : " td") + '">' + esc(label) + '</span>' +
        '<span class="tr-bar"><span class="half l"><i style="width:' + (v < 0 ? w : 0) + '%;"></i></span>' +
        '<span class="half r"><i style="width:' + (v > 0 ? w : 0) + '%;"></i></span></span>' +
        '<span class="vl ' + (v > 0 ? "tg" : v < 0 ? "tr" : "td") + '">' + sf(v, 2) + '</span></div>';
    }
    var moveTxt = "dS " + sf(ex.dS, 2) + " · dσ " + sf(ex.dv, 1) + " pts · dt " + ex.dt + " d";
    var resPct = ex.actual !== 0 ? Math.abs(ex.residual / ex.actual) : 0;
    return '<div class="lx-note td">' + moveTxt + '</div>' +
      ex.terms.map(function (t) { return bar(t.label, t.v); }).join("") +
      '<div class="lx-sep"></div>' + bar("explained", ex.explained, "tw") + bar("residual", ex.residual, "ta") + bar("actual P&L", ex.actual, "tw") +
      '<div class="lx-note td">' + (Math.abs(ex.residual) < 0.01 ? "The Greeks explain it — the move is small enough for the Taylor expansion."
        : resPct > 0.1 ? "The residual is large: the move is too big for Greeks taken at the start (higher-order terms, expiry crossing or smile re-marking)."
        : "Small residual: higher-order terms the expansion leaves out.") + '</div>';
  }

  // ---------- RSK ----------
  function outRisk() {
    var m = S.mkt, p = pos();
    if (!p.length) return '<div class="opt-empty tf">—</div>';
    var mx = L().riskMatrix(m, p, S.scen.elapsed), big = 1e-9;
    mx.forEach(function (r) { r.cells.forEach(function (c) { big = Math.max(big, Math.abs(c.pnl)); }); });
    var head = '<tr><th class="td">VOL \\ SPOT</th>' + L().SPOT_SHOCKS.map(function (s) { return '<th class="num">' + sf(s, 0) + '%</th>'; }).join("") + '</tr>';
    var body = mx.map(function (r) {
      return '<tr><td class="td">' + sf(r.shift, 0) + '</td>' + r.cells.map(function (c) {
        var a = Math.min(0.55, Math.abs(c.pnl) / big * 0.55);
        var bg = c.pnl > 0 ? "rgba(76,195,138," + a.toFixed(3) + ")" : "rgba(229,72,77," + a.toFixed(3) + ")";
        var here = c.spotPct === S.scen.spotPct && c.shift === S.scen.shift;
        return '<td class="num lx-cell' + (here ? " is-here" : "") + '" style="background:' + bg + ';" data-lx-cell="' + c.spotPct + '|' + c.shift + '">' + f(c.pnl, Math.abs(c.pnl) >= 100 ? 0 : 2) + '</td>';
      }).join("") + '</tr>';
    }).join("");
    return '<table class="tt lx-risk"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
      '<div class="lx-note td">rows: parallel vol shift (pts) · columns: spot shock · click a cell to make it the scenario</div>';
  }

  // ======================================================================
  // wiring
  // ======================================================================
  function refresh(rootEl) {
    var map = { "lx-pnl": outPnl, "lx-smile": outSmile, "lx-grk": outGreek, "lx-exp": outExplain, "lx-rsk": outRisk, "lx-mkt": outMkt, "lx-legs": outLegs };
    Object.keys(map).forEach(function (id) {
      var el = rootEl.querySelector("#" + id);
      if (el) el.innerHTML = map[id]();
    });
    var day = rootEl.querySelector("#lx-rsk-day");
    if (day) day.textContent = S.scen.elapsed;
    // keep the scenario sliders in step when something else moved them (a risk-matrix click)
    ["spotPct", "shift", "elapsed"].forEach(function (k) {
      var el = rootEl.querySelector('[data-lx-sl="' + k + '"]'), lab = rootEl.querySelector('[data-lx-val="' + k + '"]');
      if (el && +el.value !== S.scen[k]) el.value = S.scen[k];
      if (lab) lab.textContent = sliderText(k, S.scen[k]);
    });
    wireCells(rootEl);
  }

  function wireCells(rootEl) {
    rootEl.querySelectorAll("[data-lx-cell]").forEach(function (el) {
      el.addEventListener("click", function () {
        var v = el.getAttribute("data-lx-cell").split("|");
        S.scen.spotPct = +v[0]; S.scen.shift = +v[1];
        save(); refresh(rootEl);
      });
    });
  }

  function wire(rootEl, ctx) {
    load();
    function on(sel, fn) {
      rootEl.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (e) { e.preventDefault(); fn(el); });
      });
    }
    function changed() { save(); ctx.rerender(); }

    // sliders: live, outputs only
    rootEl.querySelectorAll("[data-lx-sl]").forEach(function (el) {
      el.addEventListener("input", function () {
        var k = el.getAttribute("data-lx-sl"), v = +el.value;
        if (k in S.scen) S.scen[k] = v; else S.mkt[k] = v;
        var lab = rootEl.querySelector('[data-lx-val="' + k + '"]');
        if (lab) lab.textContent = sliderText(k, v);
        save(); refresh(rootEl);
      });
    });
    rootEl.querySelectorAll("[data-lx-mkt]").forEach(function (el) {
      el.addEventListener("change", function () {
        var k = el.getAttribute("data-lx-mkt"), v = parseFloat(el.value);
        if (!isFinite(v) || (k === "spot" && v <= 0)) { el.value = S.mkt[k]; return; }
        if (k === "spot" && S.mkt.spot > 0) {
          // re-centre the position on the new spot: strikes scale with it
          var r = v / S.mkt.spot;
          S.legs.forEach(function (l) { if (l.t !== "S") l.k = Math.round(l.k * r * 100) / 100; });
        }
        S.mkt[k] = v;
        changed();
      });
    });
    on("[data-lx-dyn]", function (el) { S.mkt.dyn = el.getAttribute("data-lx-dyn"); changed(); });
    var surf = rootEl.querySelector("[data-lx-surface]");
    if (surf) surf.addEventListener("change", function () {
      var p = L().PRESETS.filter(function (x) { return x.id === surf.value; })[0];
      if (!p) return;
      S.mkt.r = 0; S.mkt.q = 0;
      for (var k in p.mkt) S.mkt[k] = p.mkt[k];
      changed();
    });

    // position
    on("[data-lx-add]", function (el) {
      var t = el.getAttribute("data-lx-add");
      if (t === "S") {
        var st = S.legs.filter(function (l) { return l.t === "S"; })[0];
        if (st) st.q += st.q > 0 ? 1 : -1; else S.legs.push({ t: "S", q: 1, days: 0 });
      } else {
        S.legs.push({ t: t, q: 1, k: Math.round(S.mkt.spot * 100) / 100, days: (pos().filter(function (l) { return l.t !== "S"; })[0] || { days: 91 }).days });
      }
      changed();
    });
    on("[data-lx-clear]", function () { S.legs = []; S.scen = { spotPct: 0, shift: 0, elapsed: 0 }; changed(); });
    on("[data-lx-hedge]", function () {
      var opts = S.legs.filter(function (l) { return l.t !== "S"; });
      var hq = L().hedgeQty(S.mkt, opts);
      S.legs = opts;
      if (hq !== 0) S.legs.push({ t: "S", q: hq, days: 0 });
      changed();
    });
    on("[data-lx-act]", function (el) {
      var i = +el.getAttribute("data-lx-leg"), l = S.legs[i], act = el.getAttribute("data-lx-act");
      if (!l) return;
      if (act === "side") l.q = -l.q;
      else if (act === "qup") l.q += l.q > 0 ? 1 : -1;
      else if (act === "qdn") { if (Math.abs(l.q) > 1) l.q -= l.q > 0 ? 1 : -1; }
      else if (act === "del") S.legs.splice(i, 1);
      else if (act === "type") {
        var nt = { C: "P", P: "S", S: "C" }[l.t];
        if (nt === "S" && S.legs.some(function (o, j) { return j !== i && o.t === "S"; })) nt = "C";
        l.t = nt;
        if (nt === "S") { delete l.k; l.days = 0; }
        else if (!l.k) { l.k = Math.round(S.mkt.spot * 100) / 100; l.days = 91; }
      }
      changed();
    });
    rootEl.querySelectorAll("[data-lx-field]").forEach(function (el) {
      el.addEventListener("change", function () {
        var i = +el.getAttribute("data-lx-leg"), l = S.legs[i], fld = el.getAttribute("data-lx-field");
        if (!l) return;
        var v = parseFloat(el.value);
        if (fld === "tenor") { if (el.value) l.days = +el.value; }
        else if (fld === "k") { if (v > 0) l.k = v; }
        else if (fld === "days") { if (v >= 1) l.days = Math.min(1825, Math.round(v)); }
        else if (fld === "qabs") { if (v > 0) l.q = (l.q < 0 ? -1 : 1) * Math.round(v * 100) / 100; }
        changed();
      });
    });
    var preset = rootEl.querySelector("[data-lx-preset]");
    if (preset) preset.addEventListener("change", function () {
      if (!preset.value) return;
      loadStrategy(preset.value);
      ctx.rerender();
    });

    // scenario + greek view
    on("[data-lx-reset]", function () { S.scen = { spotPct: 0, shift: 0, elapsed: 0 }; changed(); });
    on("[data-lx-greek]", function (el) { S.ui.greek = el.getAttribute("data-lx-greek"); changed(); });
    on("[data-lx-axis]", function (el) { S.ui.axis = el.getAttribute("data-lx-axis"); changed(); });
    on("[data-lx-hz]", function () { S.ui.horizons = !S.ui.horizons; changed(); });
    on("[data-lx-smx]", function (el) { S.ui.smileX = el.getAttribute("data-lx-smx"); changed(); });
    on("[data-lx-smv]", function (el) { S.ui.smView = el.getAttribute("data-lx-smv"); changed(); });
    on("[data-lx-cam]", function (el) {
      var v = SURF_VIEWS.filter(function (x) { return x[0] === el.getAttribute("data-lx-cam"); })[0];
      if (v) { S.ui.cam = { yaw: v[2], pitch: v[3] }; changed(); }
    });
    var smileBox = rootEl.querySelector("#lx-smile");
    if (smileBox) wireSurface(smileBox);
    wireCells(rootEl);
  }

  // Put a book strategy in the lab, priced on the lab's market.
  function loadStrategy(id) {
    load();
    S.legs = L().fromStrategy(S.mkt, id);
    S.scen = { spotPct: 0, shift: 0, elapsed: 0 };
    save();
  }

  window.M1.lib.optionsLabView = {
    render: render, wire: wire, loadStrategy: loadStrategy,
    _state: function () { return load(); }, _reset: function () { S = null; }
  };
})();
