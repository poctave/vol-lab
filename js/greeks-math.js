// greeks-math.js — single-option Greek profiles for the Options Lab Greek modes.
// window.M1.lib.greeksMath. Pure; Black-Scholes at zero rates, FLAT vol (the textbook
// shapes — the skew lives in optionsMath, for the strategy modes).
//
// Units, per one long option on an underlying around 100:
//   delta  per 1 pt of spot          gamma  delta per 1 pt of spot
//   vega   value per +1 vol pt       theta  value per calendar day (negative = decay)
//   vanna  delta per +1 vol pt       volga  vega per +1 vol pt
//   charm  delta change per calendar day as time passes
(function () {
  "use strict";
  window.M1 = window.M1 || {};
  window.M1.lib = window.M1.lib || {};

  function OM() { return window.M1.lib.optionsMath; }
  function npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  // tier 1 = the main four, tier 2 = the second-order cross Greeks.
  var GREEKS = [
    { id: "delta", tier: 1, name: "Delta", sym: "Δ", def: "∂V/∂S — how the option value moves with spot",
      names: ["delta", "δ", "Δ", "dv ds", "dvds"],
      look: "An S-curve: 0 → 1 for a call, −1 → 0 for a put, steepest at the strike. Shorter tenor = steeper." },
    { id: "gamma", tier: 1, name: "Gamma", sym: "Γ", def: "∂Δ/∂S — how delta moves with spot",
      names: ["gamma", "γ", "Γ", "ddelta ds", "d2v ds2", "convexity"],
      look: "A bell centred just below the strike, identical for calls and puts. Spikes as expiry nears." },
    { id: "vega", tier: 1, name: "Vega", sym: "ν", def: "∂V/∂σ — value per vol point",
      names: ["vega", "ν", "kappa", "dv dvol", "dv dsigma"],
      look: "A bell centred just above the strike, the same for calls and puts. Grows with √T, unlike gamma." },
    { id: "theta", tier: 1, name: "Theta", sym: "Θ", def: "∂V/∂t — value lost per day",
      names: ["theta", "θ", "Θ", "time decay", "decay", "dv dt"],
      look: "An upside-down bell for a long option: the decay is worst at the strike. At zero rates Θ = −½·Γ·S²·σ²." },
    { id: "vanna", tier: 2, name: "Vanna", sym: "∂Δ/∂σ", def: "∂Δ/∂σ = ∂ν/∂S — delta per vol point",
      names: ["vanna", "ddelta dvol", "ddelta dsigma", "dvega dspot", "dvega ds", "d delta d vol", "d vega d spot"],
      look: "Antisymmetric around the strike: a long option is long vanna below it, short above (zero where d₂ = 0)." },
    { id: "volga", tier: 2, name: "Volga", sym: "∂ν/∂σ", def: "∂ν/∂σ — vega per vol point (vomma)",
      names: ["volga", "vomma", "vega convexity", "dvega dvol", "dvega dsigma", "vol gamma", "d vega d vol"],
      look: "Two humps in the wings, a small dip at the money: OTM options are where vega itself moves with vol." },
    { id: "charm", tier: 2, name: "Charm", sym: "∂Δ/∂t", def: "∂Δ/∂t — delta drift per day (delta decay)",
      names: ["charm", "delta decay", "delta bleed", "ddelta dt", "ddelta dtime", "d delta d time"],
      look: "Antisymmetric, mirror of vanna: as days pass OTM deltas bleed towards 0 and ITM deltas towards ±1." }
  ];
  function greek(id) {
    for (var i = 0; i < GREEKS.length; i++) if (GREEKS[i].id === id) return GREEKS[i];
    return null;
  }

  // One long option, per unit. type "C" | "P".
  function value(id, type, S, K, T, vol) {
    var sq = vol * Math.sqrt(T);
    var d1 = (Math.log(S / K) + 0.5 * vol * vol * T) / sq, d2 = d1 - sq, p = npdf(d1);
    switch (id) {
      case "delta": return type === "C" ? OM().ncdf(d1) : OM().ncdf(d1) - 1;
      case "gamma": return p / (S * sq);
      case "vega": return S * p * Math.sqrt(T) / 100;
      case "theta": return -S * p * vol / (2 * Math.sqrt(T)) / 365;
      case "vanna": return -p * d2 / vol / 100;
      case "volga": return S * p * Math.sqrt(T) * d1 * d2 / vol / 10000;
      case "charm": return p * d2 / (2 * T) / 365;
    }
    return NaN;
  }

  // opt: { t: "C" | "P", q: ±1, k }. Signed by the position.
  function series(id, opt, T, vol, xs) {
    return xs.map(function (S) { return opt.q * value(id, opt.t, S, opt.k, T, vol); });
  }

  function grid(lo, hi, step) {
    var out = [];
    for (var x = lo; x <= hi + 1e-9; x += step) out.push(Math.round(x * 100) / 100);
    return out;
  }

  // ATM numbers + their rules of thumb (φ(0) ≈ 0.4), for the back-of-the-envelope mode.
  // Exact values are Black-Scholes at the money-forward-ish strike K = S, r = 0.
  function atm(kind, S, vol, T) {
    var sT = Math.sqrt(T);
    switch (kind) {
      case "straddle": return { exact: 2 * OM().bs("C", S, S, T, vol), rule: 0.8 * S * vol * sT };
      case "call": return { exact: OM().bs("C", S, S, T, vol), rule: 0.4 * S * vol * sT };
      case "gamma": return { exact: value("gamma", "C", S, S, T, vol), rule: 0.4 / (S * vol * sT) };
      case "vega": return { exact: value("vega", "C", S, S, T, vol), rule: 0.4 * S * sT / 100 };
      case "theta": return { exact: -value("theta", "C", S, S, T, vol), rule: 0.2 * S * vol / sT / 365 };
      case "move": return { exact: S * vol / Math.sqrt(365), rule: S * vol / 19 };
    }
    return null;
  }

  window.M1.lib.greeksMath = {
    GREEKS: GREEKS, greek: greek, value: value, series: series, grid: grid, atm: atm
  };
})();
