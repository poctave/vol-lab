// lab-engine.js — the Options Lab sandbox's pricing model. window.M1.lib.labEngine. Pure.
//
// The game modes price on C2's fixed setup (optionsMath); the LAB prices on a market you
// control:
//   spot S₀, rate r, dividend yield q (forward F = S·e^{(r−q)T}), and a SABR vol surface
//   (β = 1, Hagan's lognormal expansion) per tenor T:
//     σ(K) = α · z / x(z) · [1 + (ρνα/4 + (2 − 3ρ²)ν²/24) · T],   z = (ν/α) · ln(F/K)
//   ρ (skew: ρ < 0 = equity put skew) and ν (vol of vol: the smile's curvature) are knobs;
//   ν is quoted at 3M and scales as ν·√(0.25/T), so short tenors carry steeper smiles in
//   strike space and the expansion's error term ν²T stays the same at every tenor. α is
//   solved per tenor so the ATM-forward vol is exactly atm(T).
//   atm(T) = atm + term · g(T): g(0.25) = 0, g(1) = 1 (term = 1Y ATM minus 3M ATM, pts),
//   g flattens beyond 1Y — and ATM total variance σ²T is forced non-decreasing in T, so
//   the term structure can never carry calendar arbitrage.
// The previous quadratic-in-moneyness smile let vol rise with strike fast enough that calls
// got DEARER with strike (arbitrage) and delta stopped falling; SABR's wings grow like
// ν·|ln K| instead. `arbCheck` still verifies each tenor and the UI flags any breach.
//
// Smile dynamics when spot moves: "strike" (sticky strike — a strike keeps its vol) or
// "moneyness" (sticky moneyness — the smile rides with the forward). Every Greek is
// bump-and-reprice on this model, so the dynamics show up in delta, as on a desk.
//
// Leg: { t: "C" | "P" | "S", q: signed qty, k: strike, days: calendar days to expiry }.
// Scenario point: { S, shift (parallel vol pts), elapsed (days) }.
(function () {
  "use strict";
  window.M1 = window.M1 || {};
  window.M1.lib = window.M1.lib || {};

  function ncdf(x) { return window.M1.lib.optionsMath.ncdf(x); }

  var DEFAULT_MKT = { spot: 100, r: 0, q: 0, atm: 20, term: 0, rho: -0.7, nu: 1.0, dyn: "strike" };
  var PRESETS = [
    { id: "flat", label: "Flat 20%", mkt: { atm: 20, term: 0, rho: 0, nu: 0 } },
    { id: "c2", label: "C2-like equity skew", mkt: { atm: 20, term: 0, rho: -0.7, nu: 1.0 } },
    { id: "crash", label: "Index after a sell-off", mkt: { atm: 28, term: -6, rho: -0.75, nu: 1.6 } },
    { id: "fx", label: "FX major (symmetric smile)", mkt: { atm: 8, term: 1, rho: -0.05, nu: 1.3 } },
    { id: "cmdty", label: "Commodity (call skew)", mkt: { atm: 32, term: -4, rho: 0.4, nu: 1.2 } },
    { id: "earnings", label: "Single stock into earnings", mkt: { atm: 45, term: -18, rho: -0.3, nu: 1.5 } },
    { id: "rates", label: "High rates, 3% dividend", mkt: { atm: 20, term: 0, rho: -0.7, nu: 1.0, r: 5, q: 3 } }
  ];

  var MIN_T = 0.5 / 365;
  var NU_FLOOR_T = 7 / 365;                    // ν stops steepening below one week

  function fwd(m, S, T) { return S * Math.exp((m.r - m.q) / 100 * T); }

  // ---------- term structure ----------
  function gTerm(T) { return (1 - Math.exp(-(T - 0.25) / 0.5)) / (1 - Math.exp(-1.5)); }
  function rawAtm(m, T) { return Math.max(1, m.atm + m.term * gTerm(T)); }
  // ATM total variance w = σ²T must not fall with T. Where the raw curve's w would dip (a
  // steeply inverted term structure), it is held at its earlier peak. P[i] = running max of
  // w over [0, g_i]; each cell's interior peak is located on 32 sub-samples so the floor
  // never dips between grid points. Off the floor, atmVol is exactly the raw curve.
  var TS_CACHE = {}, TS_N = 400;
  var TS_GRID = (function () {
    var g = [], lo = Math.log(MIN_T), hi = Math.log(6);
    for (var i = 0; i <= TS_N; i++) g.push(Math.exp(lo + (hi - lo) * i / TS_N));
    return g;
  })();
  function wRaw(m, T) { var v = rawAtm(m, T) / 100; return v * v * T; }
  function termTable(m) {
    var key = m.atm + "|" + m.term;
    if (TS_CACHE[key]) return TS_CACHE[key];
    var P = [], peak = [], peakT = [], run = 0;
    for (var i = 0; i <= TS_N; i++) {
      run = Math.max(run, wRaw(m, TS_GRID[i]));
      P.push(run);
      if (i < TS_N) {
        var best = -1, bestT = 0;
        for (var k = 1; k < 32; k++) {
          var t = TS_GRID[i] * Math.pow(TS_GRID[i + 1] / TS_GRID[i], k / 32), w = wRaw(m, t);
          if (w > best) { best = w; bestT = t; }
        }
        peak.push(best); peakT.push(bestT);
        run = Math.max(run, best);
      }
    }
    if (Object.keys(TS_CACHE).length > 50) TS_CACHE = {};
    return (TS_CACHE[key] = { P: P, peak: peak, peakT: peakT });
  }
  function atmVol(m, T) {
    T = Math.max(T, MIN_T);
    var tb = termTable(m), g = TS_GRID, w = wRaw(m, T);
    if (T >= g[TS_N]) w = Math.max(w, tb.P[TS_N]);
    else {
      var lo = Math.log(g[0]), step = (Math.log(g[TS_N]) - lo) / TS_N;
      var i = Math.max(0, Math.min(TS_N - 1, Math.floor((Math.log(T) - lo) / step)));
      if (g[i] > T && i > 0) i--;
      w = Math.max(w, tb.P[i], T >= tb.peakT[i] ? tb.peak[i] : 0);
    }
    return Math.max(1, 100 * Math.sqrt(w / T));
  }

  // ---------- SABR (β = 1) ----------
  function nuAt(m, T) { return m.nu * Math.sqrt(0.25 / Math.max(T, NU_FLOOR_T)); }
  // α so that σ(F) = atm: (ρνT/4)·α² + (1 + (2 − 3ρ²)ν²T/24)·α − σ_atm = 0
  function alphaFor(sAtm, rho, nu, T) {
    var A = rho * nu * T / 4, B = 1 + (2 - 3 * rho * rho) * nu * nu * T / 24;
    if (Math.abs(A) < 1e-12) return sAtm / B;
    var disc = B * B + 4 * A * sAtm;
    if (disc <= 0) return sAtm / B;
    var r1 = (-B + Math.sqrt(disc)) / (2 * A);
    return r1 > 0 ? r1 : sAtm / B;
  }
  function sabr(F, K, T, alpha, rho, nu) {
    var corr = 1 + (rho * nu * alpha / 4 + (2 - 3 * rho * rho) * nu * nu / 24) * T;
    if (nu < 1e-9) return alpha * corr;
    var z = (nu / alpha) * Math.log(F / K), zx;
    if (Math.abs(z) < 1e-5) zx = 1 - rho * z / 2;
    else {
      var x = Math.log((Math.sqrt(1 - 2 * rho * z + z * z) + z - rho) / (1 - rho));
      zx = z / x;
    }
    return alpha * zx * corr;
  }

  // Implied vol in vol POINTS for strike K at T years; Sref anchors the smile (see dynamics).
  function vol(m, K, T, Sref, shift) {
    T = Math.max(T, MIN_T);
    var rho = Math.max(-0.99, Math.min(0.99, m.rho || 0)), nu = Math.max(0, nuAt(m, T) || 0);
    var sAtm = atmVol(m, T) / 100;
    var v = 100 * sabr(fwd(m, Sref, T), K, T, alphaFor(sAtm, rho, nu, T), rho, nu) + (shift || 0);
    return Math.max(1, Math.min(300, v));
  }

  // Black-76 on the forward, discounted at r. vol as a decimal.
  function bsF(type, F, K, T, v, r) {
    var df = Math.exp(-r / 100 * T);
    if (T <= 0) return type === "C" ? Math.max(F - K, 0) : Math.max(K - F, 0);
    var sq = v * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sq * sq) / sq, d2 = d1 - sq;
    return type === "C" ? df * (F * ncdf(d1) - K * ncdf(d2)) : df * (K * ncdf(-d2) - F * ncdf(-d1));
  }

  function anchor(m, S) { return m.dyn === "moneyness" ? S : m.spot; }

  // One unit of a leg at spot S, `elapsed` days in, vols shifted by `shift` pts.
  function legValue(m, leg, S, elapsed, shift) {
    if (leg.t === "S") return S;
    var days = leg.days - (elapsed || 0);
    if (days <= 1e-9) return leg.t === "C" ? Math.max(S - leg.k, 0) : Math.max(leg.k - S, 0);
    var T = days / 365;
    var v = vol(m, leg.k, T, anchor(m, S), shift) / 100;
    return bsF(leg.t, fwd(m, S, T), leg.k, T, v, m.r);
  }
  function legCost(m, leg) { return legValue(m, leg, m.spot, 0, 0); }
  function legIv(m, leg) { return leg.t === "S" ? null : vol(m, leg.k, leg.days / 365, m.spot, 0); }

  function value(m, pos, S, elapsed, shift) {
    var v = 0;
    pos.forEach(function (l) { v += l.q * legValue(m, l, S, elapsed, shift); });
    return v;
  }
  function cost(m, pos) {
    var c = 0;
    pos.forEach(function (l) { c += l.q * legCost(m, l); });
    return c;
  }
  // Net option premium (+ = pay); stock reported apart.
  function premium(m, pos) {
    var c = 0;
    pos.forEach(function (l) { if (l.t !== "S") c += l.q * legCost(m, l); });
    return c;
  }
  function pnl(m, pos, S, elapsed, shift) { return value(m, pos, S, elapsed, shift) - cost(m, pos); }

  function firstExpiry(pos) {
    var d = Infinity;
    pos.forEach(function (l) { if (l.t !== "S") d = Math.min(d, l.days); });
    return d === Infinity ? 0 : d;
  }
  function lastExpiry(pos) {
    var d = 0;
    pos.forEach(function (l) { if (l.t !== "S") d = Math.max(d, l.days); });
    return d;
  }

  // ---------- Greeks: bump and reprice on the model ----------
  // At point p = { S, elapsed, shift }. Units: Δ per 1 of spot, Γ per 1 of spot, ν per vol pt,
  // Θ per calendar day, vanna Δ per vol pt, volga ν per vol pt, charm Δ per day, rho per 1% r.
  function greeks(m, pos, p) {
    var out = {};
    GREEK_IDS.forEach(function (g) { out[g] = greek(m, pos, g, p); });
    out.value = value(m, pos, p.S, p.elapsed || 0, p.shift || 0);
    return out;
  }
  var GREEK_IDS = ["delta", "gamma", "vega", "theta", "vanna", "volga", "charm", "rho"];
  // One Greek only — the charts ask for one Greek at ~100 points × several horizons per tick.
  function greek(m, pos, name, p) {
    var S = p.S, el = p.elapsed || 0, sh = p.shift || 0, h = Math.max(1e-4, S * 1e-3);
    function V(s, e, x) { return value(m, pos, s, e, x); }
    // Vol bumps of ±0.05 pt: a ±0.5 pt bump drags in O(h²) curvature (vega off by ~1e-4
    // relative, explain's residual polluted at second order).
    var hv = 0.05;
    function D(e, x) { return (V(S + h, e, x) - V(S - h, e, x)) / (2 * h); }
    function Vg(e, x) { return (V(S, e, x + hv) - V(S, e, x - hv)) / (2 * hv); }
    switch (name) {
      case "delta": return D(el, sh);
      case "gamma": return (V(S + h, el, sh) - 2 * V(S, el, sh) + V(S - h, el, sh)) / (h * h);
      case "vega": return Vg(el, sh);
      case "theta": return V(S, el + 1, sh) - V(S, el, sh);
      case "vanna": return (D(el, sh + hv) - D(el, sh - hv)) / (2 * hv);
      case "volga": return (Vg(el, sh + hv) - Vg(el, sh - hv)) / (2 * hv);
      case "charm": return D(el + 1, sh) - D(el, sh);
      case "rho":
        var mr = clone(m), ml = clone(m);
        mr.r = m.r + 0.05; ml.r = m.r - 0.05;
        return (value(mr, pos, S, el, sh) - value(ml, pos, S, el, sh)) / 0.1;
    }
    return NaN;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // A Greek of the position across an axis:
  //   axis "spot": spot runs over xs (absolute levels)
  //   axis "strike": spot fixed at p.S, EVERY option strike scaled so the first option leg's
  //     K/S runs over xs (in %): the moneyness view, smile included.
  function greekSeries(m, pos, name, p, axis, xs) {
    var lead = pos.filter(function (l) { return l.t !== "S"; })[0];
    return xs.map(function (x) {
      if (axis === "strike" && lead) {
        var f = (x / 100) * p.S / lead.k;
        var moved = pos.map(function (l) { return l.t === "S" ? l : { t: l.t, q: l.q, k: l.k * f, days: l.days }; });
        return greek(m, moved, name, { S: p.S, elapsed: p.elapsed, shift: p.shift });
      }
      return greek(m, pos, name, { S: x, elapsed: p.elapsed, shift: p.shift });
    });
  }

  // ---------- smile readouts ----------
  // Forward delta of a call at strike K with its own smile vol.
  function callDelta(m, K, T) {
    var F = fwd(m, m.spot, T), v = vol(m, K, T, m.spot, 0) / 100, sq = v * Math.sqrt(T);
    return ncdf((Math.log(F / K) + 0.5 * sq * sq) / sq);
  }
  // Call delta along a log-strike grid around the forward (±6 ATM standard deviations).
  function deltaGrid(m, T) {
    var F = fwd(m, m.spot, T), sd = Math.max(0.02, atmVol(m, T) / 100 * Math.sqrt(T)), ks = [], ds = [];
    for (var i = 0; i <= 480; i++) {
      var k = F * Math.exp(-6 * sd + 12 * sd * i / 480);
      ks.push(k); ds.push(callDelta(m, k, T));
    }
    return { ks: ks, ds: ds, mid: 240 };
  }
  // Strike with call delta = target, found by walking OUT from the forward to the first
  // crossing (log-linear interpolation). A bisection assumes delta falls with strike, which
  // only holds on an arbitrage-free smile — this stays sane, and arbCheck flags the rest.
  function strikeForDelta(m, T, target, grid) {
    var g = grid || deltaGrid(m, T), i;
    if (target <= g.ds[g.mid]) {
      for (i = g.mid; i < g.ks.length - 1; i++) {
        if (g.ds[i + 1] <= target) return refineK(m, T, g.ks[i], g.ks[i + 1], target);
      }
      return g.ks[g.ks.length - 1];
    }
    for (i = g.mid; i > 0; i--) {
      if (g.ds[i - 1] >= target) return refineK(m, T, g.ks[i - 1], g.ks[i], target);
    }
    return g.ks[0];
  }
  // Bisection inside the bracketing cell (delta falls across it: ds[lo] ≥ target ≥ ds[hi]).
  function refineK(m, T, kLo, kHi, target) {
    for (var n = 0; n < 40; n++) {
      var mid = Math.sqrt(kLo * kHi);
      if (callDelta(m, mid, T) > target) kLo = mid; else kHi = mid;
    }
    return Math.sqrt(kLo * kHi);
  }

  // No-arbitrage check of one tenor's smile within ±4 ATM standard deviations: undiscounted
  // call prices must fall with strike (slope in [−1, 0]) and be convex.
  function arbCheck(m, T) {
    var F = fwd(m, m.spot, T), sd = Math.max(0.02, atmVol(m, T) / 100 * Math.sqrt(T));
    var ks = [], cs = [];
    for (var i = 0; i <= 200; i++) {
      var k = F * Math.exp(-4 * sd + 8 * sd * i / 200);
      ks.push(k);
      cs.push(bsF("C", F, k, T, vol(m, k, T, m.spot, 0) / 100, 0));
    }
    var tol = 1e-7 * F, prevSlope = -Infinity;
    for (var j = 1; j < ks.length; j++) {
      var slope = (cs[j] - cs[j - 1]) / (ks[j] - ks[j - 1]);
      if (slope > tol || slope < -1 - 1e-6) return { ok: false, kind: "spread", at: ks[j] };
      if (slope < prevSlope - 1e-6) return { ok: false, kind: "butterfly", at: ks[j] };
      prevSlope = slope;
    }
    return { ok: true };
  }

  // 25Δ risk reversal and butterfly at tenor T (vol pts), the way a desk quotes the smile.
  function quotes(m, T) {
    var F = fwd(m, m.spot, T), g = deltaGrid(m, T);
    var kc = strikeForDelta(m, T, 0.25, g), kp = strikeForDelta(m, T, 0.75, g);   // 25Δ put = 75Δ call
    var vc = vol(m, kc, T, m.spot, 0), vp = vol(m, kp, T, m.spot, 0), va = vol(m, F, T, m.spot, 0);
    return { atm: va, rr: vc - vp, bf: (vc + vp) / 2 - va, kCall: kc, kPut: kp, forward: F };
  }

  // ---------- smile axes ----------
  // Where a strike sits on a smile x-axis, and back:
  //   "strike"    K as % of spot S₀
  //   "moneyness" K as % of the tenor's forward F (ATM = 100 at every tenor)
  //   "delta"     100 · (1 − call Δ): 10 = 10Δ put … 50 = ATM (50Δ) … 90 = 10Δ call — low
  //               strikes stay on the left, the desk's put-wing-to-call-wing reading order
  function smileX(m, K, T, axis) {
    if (axis === "moneyness") return 100 * K / fwd(m, m.spot, T);
    if (axis === "delta") return 100 * (1 - callDelta(m, K, T));
    return 100 * K / m.spot;
  }
  function smileK(m, x, T, axis) {
    if (axis === "moneyness") return fwd(m, m.spot, T) * x / 100;
    if (axis === "delta") return strikeForDelta(m, T, 1 - x / 100);
    return m.spot * x / 100;
  }
  // Vol (pts) along a smile axis at tenor T; `shift` = the scenario's parallel shift.
  function smileCurve(m, T, axis, xs, shift) {
    var g = axis === "delta" ? deltaGrid(m, T) : null;
    return xs.map(function (x) {
      var K = g ? strikeForDelta(m, T, 1 - x / 100, g) : smileK(m, x, T, axis);
      return vol(m, K, T, m.spot, shift);
    });
  }

  // The whole surface on one grid: rows = tenors (days), columns = points on a smile axis.
  // z[i][j] = vol (pts) at tenor days[i] and smile coordinate xs[j]; arb[i] = that tenor's
  // smile passes arbCheck. The 3D view and the smile panel read the same numbers.
  function surface(m, axis, xs, days, shift) {
    var z = days.map(function (d) { return smileCurve(m, d / 365, axis, xs, shift); });
    var arb = days.map(function (d) { return arbCheck(m, d / 365).ok; });
    var lo = Infinity, hi = -Infinity;
    z.forEach(function (row) { row.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; }); });
    return { xs: xs, days: days, z: z, arb: arb, min: lo, max: hi };
  }

  // ---------- scenario tools ----------
  var SPOT_SHOCKS = [-20, -10, -5, -2, 0, 2, 5, 10, 20];
  var VOL_SHOCKS = [-10, -5, -2, 0, 2, 5, 10];
  function riskMatrix(m, pos, elapsed) {
    return VOL_SHOCKS.slice().reverse().map(function (dv) {
      return { shift: dv, cells: SPOT_SHOCKS.map(function (ds) {
        return { spotPct: ds, shift: dv, pnl: pnl(m, pos, m.spot * (1 + ds / 100), elapsed, dv) };
      }) };
    });
  }

  // P&L from the start (S₀, no shift, day 0) to the scenario, split into Taylor terms with the
  // Greeks at the start; `residual` is what the expansion misses.
  function explain(m, pos, p) {
    var g = greeks(m, pos, { S: m.spot, elapsed: 0, shift: 0 });
    var dS = p.S - m.spot, dv = p.shift || 0, dt = p.elapsed || 0;
    var terms = [
      { id: "delta", label: "Δ · dS", v: g.delta * dS },
      { id: "gamma", label: "½ Γ · dS²", v: 0.5 * g.gamma * dS * dS },
      { id: "vega", label: "ν · dσ", v: g.vega * dv },
      { id: "theta", label: "Θ · dt", v: g.theta * dt },
      { id: "vanna", label: "vanna · dS · dσ", v: g.vanna * dS * dv },
      { id: "volga", label: "½ volga · dσ²", v: 0.5 * g.volga * dv * dv },
      { id: "charm", label: "charm · dS · dt", v: g.charm * dS * dt }
    ];
    var actual = pnl(m, pos, p.S, dt, dv), sum = 0;
    terms.forEach(function (t) { sum += t.v; });
    return { terms: terms, explained: sum, actual: actual, residual: actual - sum, dS: dS, dv: dv, dt: dt };
  }

  // Breakevens of a P&L curve sampled on xs.
  // Exact zeros on a sample point count too (a long option's today-curve is exactly 0 at
  // S₀ on day 0); a run of zeros is one breakeven, and touching zero without crossing is not.
  function crossings(xs, ys) {
    var out = [];
    for (var i = 1; i < xs.length; i++) {
      var a = ys[i - 1], b = ys[i];
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) out.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-a) / (b - a));
      else if (b === 0 && a !== 0) {
        var j = i;
        while (j + 1 < ys.length && ys[j + 1] === 0) j++;
        var after = j + 1 < ys.length ? ys[j + 1] : 0;
        if ((a < 0 && after > 0) || (a > 0 && after < 0)) out.push(xs[i]);
        i = j;
      }
    }
    return out;
  }

  // ---------- bridges ----------
  // Lab legs → optionsMath legs, so the C2 classifier can name the structure: one maturity =
  // "B"; two = shorter "F", longer "B"; more = unnameable (returns null).
  function toBookLegs(pos) {
    var days = [];
    pos.forEach(function (l) { if (l.t !== "S" && days.indexOf(l.days) < 0) days.push(l.days); });
    if (days.length > 2) return null;
    days.sort(function (a, b) { return a - b; });
    return pos.map(function (l) {
      if (l.t === "S") return { t: "S", q: l.q, exp: "B" };
      return { t: l.t, q: l.q, k: l.k, exp: days.length === 2 && l.days === days[0] ? "F" : "B" };
    });
  }
  // A book strategy → lab legs on this market: strikes scaled to the spot, 3M (front 1M).
  function fromStrategy(m, id) {
    var OM = window.M1.lib.optionsMath;
    return OM.instantiate(id).map(function (l) {
      if (l.t === "S") return { t: "S", q: l.q, days: 0 };
      return { t: l.t, q: l.q, k: Math.round(l.k * m.spot / 100 * 100) / 100, days: l.exp === "F" ? 30 : 91 };
    });
  }
  // Stock to add so the position is delta-neutral at the start (2 dp).
  function hedgeQty(m, pos) {
    var opts = pos.filter(function (l) { return l.t !== "S"; });
    var d = greeks(m, opts, { S: m.spot, elapsed: 0, shift: 0 }).delta;
    return Math.round(-d * 100) / 100;
  }

  window.M1.lib.labEngine = {
    DEFAULT_MKT: DEFAULT_MKT, PRESETS: PRESETS, SPOT_SHOCKS: SPOT_SHOCKS, VOL_SHOCKS: VOL_SHOCKS,
    fwd: fwd, atmVol: atmVol, vol: vol, bsF: bsF,
    legValue: legValue, legCost: legCost, legIv: legIv, value: value, cost: cost, premium: premium, pnl: pnl,
    firstExpiry: firstExpiry, lastExpiry: lastExpiry,
    GREEK_IDS: GREEK_IDS, greeks: greeks, greek: greek, greekSeries: greekSeries, quotes: quotes, strikeForDelta: strikeForDelta,
    callDelta: callDelta, smileX: smileX, smileK: smileK, smileCurve: smileCurve, surface: surface, arbCheck: arbCheck, nuAt: nuAt,
    riskMatrix: riskMatrix, explain: explain, crossings: crossings,
    toBookLegs: toBookLegs, fromStrategy: fromStrategy, hedgeQty: hedgeQty
  };
})();
