// options-math.js — pure option maths for the Options Lab .
// window.M1.lib.optionsMath. No DOM, no storage.
//
// Black-Scholes at zero rates with the C2 equity skew (vol by strike, sticky-strike), so
// every number matches the C2 strategy tables. A POSITION is a list of concrete legs:
//   { t: "C" | "P" | "S", q: signed qty, k: strike (options), exp: "F" | "B" }
// "B" = the 3-month tenor, "F" = the 1-month front (only the calendar uses it). Premiums
// are paid at inception; stock is bought at spot.
//
// The classifier (`classify`) is the other half: it names an arbitrary position by
// matching it against every strategy template's leg pattern, up to a common size
// multiple and with the strike ORDER the template implies (a put spread is long the
// higher strike, whatever the strikes are).
(function () {
  "use strict";
  window.M1 = window.M1 || {};
  window.M1.lib = window.M1.lib || {};

  function D() { return window.M1.data.optionStrategies; }

  // ---------- normal distribution ----------
  // Abramowitz & Stegun 7.1.26 — |error| < 1.5e-7, far below anything displayed.
  function erf(x) {
    var s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function ncdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
  function npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  // ---------- skew ----------
  // Implied vol (decimal) at strike k: linear between the C2 nodes, linear past the ends.
  function volAt(k, bump) {
    var s = D().skew, v;
    if (k <= s[0][0]) v = s[0][1] + (k - s[0][0]) * (s[1][1] - s[0][1]) / (s[1][0] - s[0][0]);
    else if (k >= s[s.length - 1][0]) {
      var a = s[s.length - 2], b = s[s.length - 1];
      v = b[1] + (k - b[0]) * (b[1] - a[1]) / (b[0] - a[0]);
    } else {
      for (var i = 1; i < s.length; i++) {
        if (k <= s[i][0]) {
          v = s[i - 1][1] + (k - s[i - 1][0]) * (s[i][1] - s[i - 1][1]) / (s[i][0] - s[i - 1][0]);
          break;
        }
      }
    }
    return Math.max(1, v + (bump || 0)) / 100;
  }

  function tenorOf(leg) { return leg.exp === "F" ? D().frontTenor : D().tenor; }

  // ---------- Black-Scholes (r = 0) ----------
  function bs(type, S, K, T, vol) {
    if (T <= 1e-9) return type === "C" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    var sq = vol * Math.sqrt(T);
    var d1 = (Math.log(S / K) + 0.5 * vol * vol * T) / sq, d2 = d1 - sq;
    return type === "C" ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
  }

  // Value of one leg (per unit, before qty) at spot S with `elapsed` years gone.
  function legValue(leg, S, elapsed, volBump) {
    if (leg.t === "S") return S;
    var T = Math.max(0, tenorOf(leg) - (elapsed || 0));
    return bs(leg.t, S, leg.k, T, volAt(leg.k, volBump));
  }

  // Inception premium of one leg per unit (stock: its price).
  function legPremium(leg) { return legValue(leg, D().spot, 0, 0); }

  // Net premium of the OPTIONS (positive = you pay). Stock is reported separately.
  function netPremium(pos) {
    var p = 0;
    pos.forEach(function (l) { if (l.t !== "S") p += l.q * legPremium(l); });
    return p;
  }
  function hasStock(pos) { return pos.some(function (l) { return l.t === "S" && l.q !== 0; }); }

  // P&L of the whole position at spot S after `elapsed` years (premium + stock cost included).
  function pnl(pos, S, elapsed) {
    var v = 0;
    pos.forEach(function (l) { v += l.q * (legValue(l, S, elapsed, 0) - legPremium(l)); });
    return v;
  }

  // The "expiry" horizon: when the first leg expires (the calendar is read at front expiry).
  function horizon(pos) {
    var h = D().tenor;
    pos.forEach(function (l) { if (l.t !== "S") h = Math.min(h, tenorOf(l)); });
    return h;
  }
  function pnlAtExpiry(pos, S) { return pnl(pos, S, horizon(pos)); }
  function pnlToday(pos, S) { return pnl(pos, S, 0); }

  // Expiry P&L with the premium stripped (pure intrinsic + stock move).
  function intrinsicAtExpiry(pos, S) {
    var v = 0;
    pos.forEach(function (l) {
      if (l.t === "S") v += l.q * (S - D().spot);
      else v += l.q * (l.t === "C" ? Math.max(S - l.k, 0) : Math.max(l.k - S, 0));
    });
    return v;
  }

  // ---------- Greeks at inception ----------
  // delta & gamma per 1 point of spot, vega per +1 vol point on every strike, theta per
  // calendar day (one day passes, spot and vols unchanged) — the C2 conventions.
  function greeks(pos) {
    var S = D().spot, g = { delta: 0, gamma: 0, vega: 0, theta: 0 };
    pos.forEach(function (l) {
      if (l.t === "S") { g.delta += l.q; return; }
      var T = tenorOf(l), vol = volAt(l.k), sq = vol * Math.sqrt(T);
      var d1 = (Math.log(S / l.k) + 0.5 * vol * vol * T) / sq;
      g.delta += l.q * (l.t === "C" ? ncdf(d1) : ncdf(d1) - 1);
      g.gamma += l.q * npdf(d1) / (S * sq);
      g.vega += l.q * S * npdf(d1) * Math.sqrt(T) / 100;
      g.theta += l.q * (bs(l.t, S, l.k, T - 1 / 365, vol) - bs(l.t, S, l.k, T, vol));
    });
    return g;
  }

  // Sign profile: -1 / 0 / +1 per Greek, with "≈ 0" bands wide enough that skew residue
  // (a butterfly's −0.08 delta, a collar's −0.005 gamma) reads as flat, as C2 says it should.
  var FLAT = { delta: 0.10, gamma: 0.008, vega: 0.03, theta: 0.003, premium: 0.25 };
  function sgn(x, band) { return Math.abs(x) < band ? 0 : x > 0 ? 1 : -1; }
  function signProfile(pos) {
    var g = greeks(pos);
    return {
      delta: sgn(g.delta, FLAT.delta), gamma: sgn(g.gamma, FLAT.gamma),
      vega: sgn(g.vega, FLAT.vega), theta: sgn(g.theta, FLAT.theta),
      premium: sgn(netPremium(pos), FLAT.premium)
    };
  }
  function sameSigns(a, b) {
    return a.delta === b.delta && a.gamma === b.gamma && a.vega === b.vega && a.theta === b.theta && a.premium === b.premium;
  }

  // ---------- templates ----------
  function strategy(id) {
    var list = D().strategies;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // Concrete legs for a strategy at centre c and width w.
  function instantiate(s, params) {
    if (typeof s === "string") s = strategy(s);
    var c = params && params.c != null ? params.c : s.def.c;
    var w = params && params.w != null ? params.w : s.def.w;
    return s.legs.map(function (l) {
      var leg = { t: l.t, q: l.q, exp: l.exp || "B" };
      if (l.t !== "S") leg.k = c + l.off * w;
      return leg;
    });
  }

  function strikesOf(pos) {
    var ks = [];
    pos.forEach(function (l) { if (l.t !== "S" && ks.indexOf(l.k) < 0) ks.push(l.k); });
    return ks.sort(function (a, b) { return a - b; });
  }

  // Every (c, w) on the 5-point strike grid that keeps all strikes inside [min, max].
  // Strategies whose wing width does not matter (single strike) still vary c.
  function paramGrid(s, opts) {
    if (typeof s === "string") s = strategy(s);
    opts = opts || {};
    var lo = D().minStrike, hi = D().maxStrike, out = [];
    var cs = opts.cs || [80, 85, 90, 95, 100, 105, 110, 115, 120];
    var ws = opts.ws || [5, 10, 15, 20];
    var usesW = s.legs.some(function (l) { return l.t !== "S" && l.off !== 0; });
    cs.forEach(function (c) {
      (usesW ? ws : [s.def.w]).forEach(function (w) {
        var ok = s.legs.every(function (l) {
          if (l.t === "S") return true;
          var k = c + l.off * w;
          return k >= lo && k <= hi && Math.abs(k / 5 - Math.round(k / 5)) < 1e-9;
        });
        if (ok) out.push({ c: c, w: w });
      });
    });
    return out;
  }

  // ---------- position hygiene ----------
  // Merge legs that are the same instrument, drop zero quantities.
  function normalize(pos) {
    var map = {}, order = [];
    pos.forEach(function (l) {
      var exp = l.t === "S" ? "B" : (l.exp || "B");
      var key = l.t === "S" ? "S" : l.t + "|" + l.k + "|" + exp;
      if (!map[key]) { map[key] = { t: l.t, q: 0, exp: exp }; if (l.t !== "S") map[key].k = l.k; order.push(key); }
      map[key].q += l.q;
    });
    return order.map(function (k) { return map[k]; }).filter(function (l) { return l.q !== 0; });
  }

  // ---------- classifier ----------
  // Pattern leg = template leg with a strike SYMBOL (its offset). Two pattern legs with the
  // same offset must share a strike; a lower offset must sit at a lower strike. Quantities
  // must be one common positive multiple of the template's. Expiries must match the
  // template (all-same for everything but the calendar).
  function permutations(n) {
    var out = [];
    (function rec(cur, used) {
      if (cur.length === n) { out.push(cur.slice()); return; }
      for (var i = 0; i < n; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(i); rec(cur, used); cur.pop(); used[i] = false;
      }
    })([], []);
    return out;
  }
  var PERMS = {};
  function perms(n) { return PERMS[n] || (PERMS[n] = permutations(n)); }

  function matchesTemplate(s, legs) {
    var pat = s.legs;
    if (pat.length !== legs.length) return false;
    var ps = perms(legs.length);
    for (var p = 0; p < ps.length; p++) {
      var mult = null, ok = true, symK = {};
      for (var i = 0; i < pat.length && ok; i++) {
        var pl = pat[i], ul = legs[ps[p][i]];
        if (pl.t !== ul.t) { ok = false; break; }
        var m = ul.q / pl.q;
        if (m <= 0 || Math.abs(m - Math.round(m)) > 1e-9) { ok = false; break; }
        if (mult == null) mult = m; else if (m !== mult) { ok = false; break; }
        if (pl.t === "S") continue;
        if ((pl.exp || "B") !== ul.exp) { ok = false; break; }
        var sym = String(pl.off);
        if (symK[sym] == null) symK[sym] = ul.k; else if (symK[sym] !== ul.k) ok = false;
      }
      if (!ok) continue;
      // distinct symbols → distinct strikes, in the template's order
      var syms = Object.keys(symK).map(Number).sort(function (a, b) { return a - b; });
      for (var j = 1; j < syms.length && ok; j++) {
        if (!(symK[String(syms[j - 1])] < symK[String(syms[j])])) ok = false;
      }
      if (ok) return true;
    }
    return false;
  }

  // Ids of every strategy the position IS (usually 0 or 1; a put butterfly is not in the
  // book, so it returns nothing and the payoff-twin check takes over).
  function classify(pos) {
    var legs = normalize(pos);
    if (!legs.length) return [];
    // A calendar needs two expiries; anything else needs one.
    return D().strategies.filter(function (s) { return matchesTemplate(s, legs); }).map(function (s) { return s.id; });
  }

  // ---------- equivalence ----------
  var GRID = (function () { var g = []; for (var x = 60; x <= 140; x += 1) g.push(x); return g; })();

  // Same expiry P&L (premium included) everywhere on the grid.
  function samePnl(a, b, tol) {
    tol = tol == null ? 0.05 : tol;
    if (Math.abs(horizon(a) - horizon(b)) > 1e-9) return false;
    for (var i = 0; i < GRID.length; i++) {
      if (Math.abs(pnlAtExpiry(a, GRID[i]) - pnlAtExpiry(b, GRID[i])) > tol) return false;
    }
    return true;
  }
  // Same expiry payoff SHAPE: the P&Ls differ by a constant (a parity twin, or the same
  // structure entered for a different premium).
  function sameShape(a, b, tol) {
    tol = tol == null ? 0.05 : tol;
    if (Math.abs(horizon(a) - horizon(b)) > 1e-9) return false;
    var d0 = pnlAtExpiry(a, GRID[0]) - pnlAtExpiry(b, GRID[0]);
    for (var i = 1; i < GRID.length; i++) {
      if (Math.abs(pnlAtExpiry(a, GRID[i]) - pnlAtExpiry(b, GRID[i]) - d0) > tol) return false;
    }
    return true;
  }
  // Indistinguishable on screen: within half a displayed digit (Δ ν to 2 dp, Γ Θ to 3 dp).
  // Looser bands let a 100/120 strangle pass for a 100 put — the 120 call is nearly free,
  // but its Greeks still show at those decimals.
  function closeGreeks(a, b) {
    var ga = greeks(a), gb = greeks(b);
    return Math.abs(ga.delta - gb.delta) < 0.006 && Math.abs(ga.gamma - gb.gamma) < 0.0006 &&
      Math.abs(ga.vega - gb.vega) < 0.006 && Math.abs(ga.theta - gb.theta) < 0.0006;
  }

  // Can strategy `id`, at SOME strikes on the grid, produce something that satisfies `pred`?
  // Returns the params that did, or null. This is how a parity twin gets credit.
  function canMatch(id, pred) {
    var s = strategy(id);
    if (!s) return null;
    var grid = paramGrid(s);
    for (var i = 0; i < grid.length; i++) {
      if (pred(instantiate(s, grid[i]))) return grid[i];
    }
    return null;
  }

  // ---------- readouts ----------
  // Breakevens of the expiry P&L inside [lo, hi] (linear interpolation on a fine grid).
  function breakevens(pos, lo, hi) {
    lo = lo == null ? 50 : lo; hi = hi == null ? 150 : hi;
    var out = [], step = 0.25, prev = pnlAtExpiry(pos, lo);
    for (var x = lo + step; x <= hi + 1e-9; x += step) {
      var v = pnlAtExpiry(pos, x);
      if (prev === 0) { if (out.indexOf(x - step) < 0) out.push(x - step); }
      else if ((prev < 0 && v > 0) || (prev > 0 && v < 0)) {
        out.push(x - step + step * (-prev) / (v - prev));
      }
      prev = v;
    }
    // collapse near-duplicates (flat zero segments)
    return out.filter(function (b, i) { return i === 0 || Math.abs(b - out[i - 1]) > 0.5; })
      .map(function (b) { return Math.round(b * 10) / 10; });
  }

  // Max gain / loss at expiry over S in [0, 300]; "unlimited" when still rising at the edge.
  function extremes(pos) {
    var maxV = -Infinity, minV = Infinity;
    for (var x = 0; x <= 300; x += 0.5) {
      var v = pnlAtExpiry(pos, x);
      if (v > maxV) maxV = v;
      if (v < minV) minV = v;
    }
    var slopeHi = pnlAtExpiry(pos, 300) - pnlAtExpiry(pos, 299);
    return {
      maxGain: slopeHi > 1e-6 ? Infinity : maxV,
      maxLoss: slopeHi < -1e-6 ? -Infinity : minV
    };
  }

  // "Long 100 put (20.0% vol, pay 3.99)" — the C2 way of writing a leg.
  function describeLeg(l) {
    var n = Math.abs(l.q), side = l.q > 0 ? "Long" : "Short";
    if (l.t === "S") return side + (n > 1 ? " " + n + "×" : "") + " stock at " + D().spot;
    var prem = legPremium(l);
    return side + (n > 1 ? " " + n + "×" : "") + " " + l.k + " " + (l.t === "C" ? "call" : "put") +
      (l.exp === "F" ? " (1M)" : "") +
      " — " + (volAt(l.k) * 100).toFixed(1) + "% vol, " + (l.q > 0 ? "pay " : "receive ") + (n * prem).toFixed(2);
  }

  window.M1.lib.optionsMath = {
    ncdf: ncdf, volAt: volAt, bs: bs,
    legPremium: legPremium, netPremium: netPremium, hasStock: hasStock,
    pnl: pnl, pnlAtExpiry: pnlAtExpiry, pnlToday: pnlToday, intrinsicAtExpiry: intrinsicAtExpiry,
    horizon: horizon, greeks: greeks, signProfile: signProfile, sameSigns: sameSigns, FLAT: FLAT,
    strategy: strategy, instantiate: instantiate, paramGrid: paramGrid, strikesOf: strikesOf,
    normalize: normalize, classify: classify,
    samePnl: samePnl, sameShape: sameShape, closeGreeks: closeGreeks, canMatch: canMatch,
    breakevens: breakevens, extremes: extremes, describeLeg: describeLeg
  };
})();
