// lab-engine.test.js — the Options Lab sandbox model: pricing with rates/dividends and a
// SABR smile, calendar-safe term structure, no-arbitrage checks, smile dynamics in delta, bump Greeks, desk quotes, scenario tools.
(function () {
  "use strict";
  var L = window.M1.lib.labEngine;
  var OM = window.M1.lib.optionsMath;
  var GM = window.M1.lib.greeksMath;

  function mkt(o) {
    var m = JSON.parse(JSON.stringify(L.DEFAULT_MKT));
    for (var k in (o || {})) m[k] = o[k];
    return m;
  }
  function near(a, b, tol, what) {
    if (!(Math.abs(a - b) <= tol)) throw new Error(what + ": expected " + b + " ± " + tol + ", got " + a);
  }
  var FLAT = { rho: 0, nu: 0, term: 0 };

  describe("labEngine · pricing", function () {
    it("flat 20%, r = q = 0 reproduces the C2 ATM 3M call (3.99) and the closed-form Greeks", function () {
      var m = mkt(FLAT), leg = { t: "C", q: 1, k: 100, days: 91.25 };
      near(L.legCost(m, leg), 3.99, 0.005, "price");
      var g = L.greeks(m, [leg], { S: 100, elapsed: 0, shift: 0 });
      var T = 91.25 / 365;
      near(g.delta, GM.value("delta", "C", 100, 100, T, 0.2), 1e-4, "delta");
      near(g.gamma, GM.value("gamma", "C", 100, 100, T, 0.2), 1e-4, "gamma");
      near(g.vega, GM.value("vega", "C", 100, 100, T, 0.2), 1e-4, "vega");
      near(g.vanna, GM.value("vanna", "C", 100, 100, T, 0.2), 2e-4, "vanna");
      near(g.volga, GM.value("volga", "C", 100, 100, T, 0.2), 2e-4, "volga");
      near(g.theta, GM.value("theta", "C", 100, 100, T, 0.2), 2e-3, "theta (1-day vs instantaneous)");
    });
    it("put-call parity holds with rates and dividends: C − P = e^(−rT)(F − K)", function () {
      var m = mkt({ r: 5, q: 3, rho: -0.7, nu: 1.2 });
      [80, 100, 125].forEach(function (K) {
        var c = L.legCost(m, { t: "C", q: 1, k: K, days: 182 }), p = L.legCost(m, { t: "P", q: 1, k: K, days: 182 });
        var T = 182 / 365;
        near(c - p, Math.exp(-0.05 * T) * (L.fwd(m, 100, T) - K), 1e-9, "parity K" + K);
      });
    });
    it("ATM-forward vol is exactly the ATM knob at every tenor (α is solved for it)", function () {
      var m = mkt({ atm: 23, rho: -0.6, nu: 1.4, r: 3, q: 1 });
      [7 / 365, 30 / 365, 0.25, 1, 2].forEach(function (T) {
        near(L.vol(m, L.fwd(m, 100, T), T, 100, 0), L.atmVol(m, T), 1e-6, "ATM T=" + T.toFixed(3));
      });
      near(L.atmVol(m, 0.25), 23, 1e-6, "3M ATM = knob");
    });
    it("ρ tilts, ν curves: ρ < 0 = put skew, ρ > 0 = call skew, ν = 0 & ρ = 0 = flat", function () {
      var T = 0.25, F = 100;
      var put = mkt({ rho: -0.7, nu: 1 }), call = mkt({ rho: 0.5, nu: 1 }), flat = mkt(FLAT);
      expect(L.vol(put, 90, T, 100, 0) > L.vol(put, 110, T, 100, 0)).toBe(true);
      expect(L.vol(call, 110, T, 100, 0) > L.vol(call, 90, T, 100, 0)).toBe(true);
      [70, 100, 140].forEach(function (K) { near(L.vol(flat, K, T, 100, 0), 20, 1e-9, "flat " + K); });
      var lo = L.quotes(mkt({ rho: 0, nu: 0.5 }), T).bf, hi = L.quotes(mkt({ rho: 0, nu: 1.5 }), T).bf;
      expect(hi > lo && lo > 0).toBe(true);
    });
    it("term: 1Y ATM = 3M ATM + term, and ATM total variance never falls with maturity", function () {
      near(L.atmVol(mkt({ term: 4 }), 1), 24, 1e-6, "1Y = +4");
      // the screenshot that exposed the old linear term structure: 2Y ATM had hit the 1% floor
      [mkt({ atm: 16, term: -7 }), mkt({ atm: 45, term: -18 }), mkt({ atm: 10, term: -30 }), mkt({ atm: 20, term: 30 })].forEach(function (m) {
        var prev = 0;
        for (var d = 1; d <= 1825; d += 3) {
          var T = d / 365, v = L.atmVol(m, T) / 100, w = v * v * T;
          if (w < prev - 1e-12) throw new Error("calendar arbitrage at " + d + "d (atm " + m.atm + ", term " + m.term + ")");
          prev = w;
        }
      });
      expect(L.atmVol(mkt({ atm: 16, term: -7 }), 2) > 5).toBe(true);
    });
    it("no arbitrage on every preset, and across the slider range for ATM ≤ 30%, at every tenor", function () {
      var cases = L.PRESETS.map(function (p) { return mkt(p.mkt); });
      [-0.95, -0.5, 0, 0.5, 0.95].forEach(function (rho) {
        [0, 0.5, 1, 1.5, 2].forEach(function (nu) {
          [5, 15, 30].forEach(function (atm) {
            [-20, 0, 20].forEach(function (term) { cases.push(mkt({ atm: atm, rho: rho, nu: nu, term: term })); });
          });
        });
      });
      cases.forEach(function (m) {
        [7, 30, 91, 365, 730].forEach(function (d) {
          var a = L.arbCheck(m, d / 365);
          if (!a.ok) throw new Error(a.kind + " arbitrage: atm " + m.atm + " ρ " + m.rho + " ν " + m.nu + " term " + m.term + " at " + d + "d near K " + a.at.toFixed(1));
        });
      });
    });
    it("the arbitrage check catches a surface SABR cannot price (huge vol, max ν, 1 week)", function () {
      var a = L.arbCheck(mkt({ atm: 120, rho: -0.95, nu: 3 }), 7 / 365);
      expect(a.ok).toBe(false);
    });
    it("call delta falls with strike, so a delta pins one strike (the old smile broke this)", function () {
      var m = mkt({ atm: 16, term: -7, rho: 0.95, nu: 3 });
      [30, 91, 730].forEach(function (d) {
        var T = d / 365, prev = 1;
        for (var K = 40; K <= 250; K += 1) {
          var dl = L.callDelta(m, K, T);
          if (dl > prev + 1e-9) throw new Error("delta rises at K " + K + " (" + d + "d)");
          prev = dl;
        }
      });
    });
    it("far wings stay sane: a 1M 60% strike on the crash surface is high but not absurd, and continuous", function () {
      var m = mkt({ atm: 28, term: -6, rho: -0.75, nu: 1.6 }), T = 30 / 365;
      var v60 = L.vol(m, 60, T, 100, 0);
      expect(v60 > 50 && v60 < 120).toBe(true);
      // no jumps along the strike axis
      var prev = L.vol(m, 40, T, 100, 0);
      for (var K = 40.5; K <= 200; K += 0.5) {
        var v = L.vol(m, K, T, 100, 0);
        if (Math.abs(v - prev) > 2) throw new Error("jump at K " + K + ": " + prev + " → " + v);
        prev = v;
      }
      // and no kinks: the slope changes smoothly (second difference small everywhere)
      for (var K2 = 41; K2 <= 199; K2 += 0.5) {
        var d2 = L.vol(m, K2 + 0.5, T, 100, 0) - 2 * L.vol(m, K2, T, 100, 0) + L.vol(m, K2 - 0.5, T, 100, 0);
        if (Math.abs(d2) > 0.35) throw new Error("kink at K " + K2 + ": " + d2);
      }
    });
    it("a parallel vol shift moves every strike by the same points", function () {
      var m = mkt({ rho: -0.7, nu: 1 });
      [70, 100, 130].forEach(function (K) { near(L.vol(m, K, 0.5, 100, 5) - L.vol(m, K, 0.5, 100, 0), 5, 1e-9, "shift"); });
    });
  });

  describe("labEngine · Greeks with rates and dividends (flat vol) vs closed-form Black-Scholes", function () {
    var m = mkt({ rho: 0, nu: 0, term: 0, atm: 25, r: 4, q: 2 });
    var N = window.M1.lib.optionsMath.ncdf;
    function phi(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
    [["C", 90], ["C", 110], ["P", 95], ["P", 120]].forEach(function (c) {
      it(c[0] + " " + c[1] + ": Δ = e^(−qT)N(±d1), Γ, ν, ρ, value", function () {
        var t = c[0], K = c[1], T = 182 / 365, S = 100, v = 0.25, r = 0.04, qd = 0.02;
        var d1 = (Math.log(S / K) + (r - qd + 0.5 * v * v) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
        var price = t === "C" ? S * Math.exp(-qd * T) * N(d1) - K * Math.exp(-r * T) * N(d2)
          : K * Math.exp(-r * T) * N(-d2) - S * Math.exp(-qd * T) * N(-d1);
        var g = L.greeks(m, [{ t: t, q: 1, k: K, days: 182 }], { S: 100 });
        near(g.value, price, 1e-9, "value");
        near(g.delta, t === "C" ? Math.exp(-qd * T) * N(d1) : Math.exp(-qd * T) * (N(d1) - 1), 1e-5, "delta");
        near(g.gamma, Math.exp(-qd * T) * phi(d1) / (S * v * Math.sqrt(T)), 1e-5, "gamma");
        near(g.vega, S * Math.exp(-qd * T) * phi(d1) * Math.sqrt(T) / 100, 1e-5, "vega");
        near(g.rho, (t === "C" ? 1 : -1) * K * T * Math.exp(-r * T) * N((t === "C" ? 1 : -1) * d2) / 100, 1e-5, "rho");
      });
    });
  });

  describe("labEngine · P&L explain is a correct second-order expansion", function () {
    it("the residual is third order: tiny next to the P&L, and gone faster than the move squared", function () {
      var m = mkt({ rho: -0.6, nu: 1 }), pos = [{ t: "C", q: 1, k: 100, days: 91 }, { t: "P", q: -2, k: 90, days: 91 }];
      function ex(e) { return L.explain(m, pos, { S: 100 + 4 * e, shift: 2 * e, elapsed: 0 }); }
      var a = ex(1), b = ex(0.125);
      expect(Math.abs(a.residual) < 1e-3 * Math.abs(a.actual)).toBe(true);
      // an 8× smaller move: a second-order miss would shrink 64×, a third-order one 512×
      expect(Math.abs(a.residual) / Math.abs(b.residual) > 64).toBe(true);
    });
    it("explain's actual P&L is the risk matrix's number at the same point", function () {
      var m = mkt(), pos = [{ t: "C", q: 1, k: 105, days: 60 }];
      var cell = L.riskMatrix(m, pos, 10).filter(function (r) { return r.shift === 5; })[0].cells.filter(function (c) { return c.spotPct === -5; })[0];
      near(L.explain(m, pos, { S: 95, shift: 5, elapsed: 10 }).actual, cell.pnl, 1e-12, "same P&L");
    });
    it("breakevens: exact zeros on a sample count once; a touch without crossing does not", function () {
      expect(L.crossings([98, 99, 100, 101, 102], [-2, -1, 0, 1, 2])).toEqual([100]);
      expect(L.crossings([1, 2, 3, 4, 5], [-1, 0, 0, 0, 1])).toEqual([2]);
      expect(L.crossings([1, 2, 3], [1, 0, 1])).toEqual([]);
      expect(L.crossings([1, 2], [-1, 1])).toEqual([1.5]);
      var m = mkt(), call = [{ t: "C", q: 1, k: 100, days: 91 }];
      var xs = [];
      for (var x = 60; x <= 140; x += 0.5) xs.push(x);
      var today = L.crossings(xs, xs.map(function (v) { return L.pnl(m, call, v, 0, 0); }));
      expect(today.length).toBe(1);
      near(today[0], 100, 1e-9, "day-0 breakeven at spot");
      var exp = L.crossings(xs, xs.map(function (v) { return L.pnl(m, call, v, 91, 0); }));
      near(exp[0], 100 + L.legCost(m, call[0]), 1e-9, "expiry breakeven = K + premium");
    });
    it("at expiry a leg is worth exactly its intrinsic value", function () {
      var m = mkt(), leg = { t: "P", q: 1, k: 105, days: 30 };
      near(L.legValue(m, leg, 97, 30, 0), 8, 1e-12, "intrinsic");
      near(L.legValue(m, leg, 97, 31, 0), 8, 1e-12, "after expiry");
    });
  });

  describe("labEngine · smile dynamics", function () {
    it("sticky strike vs sticky moneyness changes delta, not price, on a skewed surface", function () {
      var leg = [{ t: "P", q: 1, k: 95, days: 91 }];
      var ss = L.greeks(mkt({ rho: -0.8, nu: 1.2, dyn: "strike" }), leg, { S: 100, elapsed: 0, shift: 0 });
      var sm = L.greeks(mkt({ rho: -0.8, nu: 1.2, dyn: "moneyness" }), leg, { S: 100, elapsed: 0, shift: 0 });
      near(ss.value, sm.value, 1e-9, "same price today");
      // Sticky moneyness: spot up → the fixed 95 strike sits lower on a smile that moved with
      // the forward, i.e. at a HIGHER vol on equity skew. Delta picks up vega · dσ/dS > 0, so
      // the long put's delta is less negative than under sticky strike.
      expect(sm.delta > ss.delta).toBe(true);
      var T = 91 / 365, mm = mkt({ rho: -0.8, nu: 1.2, dyn: "moneyness" });
      near(sm.delta - ss.delta, ss.vega * (L.vol(mm, 95, T, 100.01, 0) - L.vol(mm, 95, T, 99.99, 0)) / 0.02, 2e-3, "≈ vega · dσ/dS");
    });
    it("flat vol makes the two dynamics identical", function () {
      var leg = [{ t: "C", q: 1, k: 105, days: 60 }];
      near(L.greeks(mkt({ rho: 0, nu: 0, dyn: "strike" }), leg, { S: 100 }).delta,
        L.greeks(mkt({ rho: 0, nu: 0, dyn: "moneyness" }), leg, { S: 100 }).delta, 1e-9, "flat");
    });
  });

  describe("labEngine · readouts and scenarios", function () {
    it("25Δ quotes: equity skew → negative risk reversal; smile → positive butterfly", function () {
      var q = L.quotes(mkt({ rho: -0.7, nu: 1 }), 0.25);
      expect(q.rr < 0).toBe(true);
      expect(q.bf > 0).toBe(true);
      expect(q.kPut < q.forward && q.kCall > q.forward).toBe(true);
      var f = L.quotes(mkt(FLAT), 0.25);
      near(f.rr, 0, 1e-9, "flat rr");
      near(f.bf, 0, 1e-9, "flat bf");
    });
    it("smile axes: moneyness 100 is the forward (ATM) at every tenor; delta 50 is the 50Δ strike", function () {
      var m = mkt({ r: 4, q: 1, rho: -0.6, nu: 1.3, term: 3 });
      [30 / 365, 0.5, 2].forEach(function (T) {
        near(L.smileCurve(m, T, "moneyness", [100], 0)[0], L.vol(m, L.fwd(m, 100, T), T, 100, 0), 1e-9, "K/F = 100% is ATM");
        near(L.callDelta(m, L.smileK(m, 50, T, "delta"), T), 0.5, 1e-8, "50Δ");
        [10, 25, 75, 90].forEach(function (x) { near(L.smileX(m, L.smileK(m, x, T, "delta"), T, "delta"), x, 1e-4, "round trip " + x); });
      });
    });
    it("smile axes: on equity skew the 25Δ put wing (x = 25) is richer than the 25Δ call (x = 75)", function () {
      var v = L.smileCurve(mkt({ rho: -0.7, nu: 1 }), 0.25, "delta", [25, 75], 0);
      expect(v[0] > v[1]).toBe(true);
      near(v[1] - v[0], L.quotes(mkt({ rho: -0.7, nu: 1 }), 0.25).rr, 1e-4, "matches the RR quote");
    });
    it("risk matrix: zero at the centre on day 0; a long straddle wins both ways", function () {
      var m = mkt(), pos = [{ t: "C", q: 1, k: 100, days: 91 }, { t: "P", q: 1, k: 100, days: 91 }];
      var mx = L.riskMatrix(m, pos, 0);
      var centre = mx.filter(function (r) { return r.shift === 0; })[0].cells.filter(function (c) { return c.spotPct === 0; })[0];
      near(centre.pnl, 0, 1e-9, "centre");
      var row = mx.filter(function (r) { return r.shift === 0; })[0].cells;
      expect(row[0].pnl > 0 && row[row.length - 1].pnl > 0).toBe(true);
    });
    it("P&L explain: tiny residual for a small move, bigger for a crash", function () {
      var m = mkt(), pos = [{ t: "C", q: 1, k: 100, days: 91 }];
      var small = L.explain(m, pos, { S: 101, shift: 0.5, elapsed: 1 });
      var big = L.explain(m, pos, { S: 75, shift: 15, elapsed: 30 });
      expect(Math.abs(small.residual) < 0.01).toBe(true);
      expect(Math.abs(big.residual) > Math.abs(small.residual)).toBe(true);
      near(small.explained + small.residual, small.actual, 1e-12, "adds up");
    });
    it("hedge Δ neutralises the position at the start", function () {
      var m = mkt(), opts = [{ t: "C", q: 1, k: 100, days: 91 }, { t: "P", q: 2, k: 95, days: 91 }];
      var hq = L.hedgeQty(m, opts);
      var all = opts.concat([{ t: "S", q: hq, days: 0 }]);
      near(L.greeks(m, all, { S: 100 }).delta, 0, 0.006, "hedged delta");
    });
    it("bridges: book strategies load at the spot, and lab legs classify back", function () {
      var m = mkt({ spot: 250 });
      var legs = L.fromStrategy(m, "iron-condor");
      expect(legs.map(function (l) { return l.k; })).toEqual([212.5, 237.5, 262.5, 287.5]);
      expect(OM.classify(L.toBookLegs(legs))).toEqual(["iron-condor"]);
      var cal = L.fromStrategy(m, "calendar");
      expect(OM.classify(L.toBookLegs(cal))).toEqual(["calendar"]);
      expect(L.toBookLegs([{ t: "C", q: 1, k: 1, days: 1 }, { t: "C", q: 1, k: 1, days: 2 }, { t: "C", q: 1, k: 1, days: 3 }])).toBe(null);
    });
    it("strike-axis series: flat vol makes a lone option's Greek depend only on K/S", function () {
      var m = mkt(FLAT), pos = [{ t: "C", q: 1, k: 100, days: 91 }];
      var bySpot = L.greekSeries(m, pos, "gamma", { S: 100, elapsed: 0, shift: 0 }, "strike", [90, 100, 110]);
      // K/S = 110% with S = 100 is the 110 strike: gamma of a 110 call at spot 100
      near(bySpot[2], L.greeks(m, [{ t: "C", q: 1, k: 110, days: 91 }], { S: 100 }).gamma, 1e-9, "strike axis");
    });
  });
})();
