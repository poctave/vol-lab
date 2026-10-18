# Vol Lab

**Try it in your browser: https://poctave.github.io/vol-lab/**

An options and volatility sandbox that runs in the browser. You control the market and see how any position behaves.

- **Position builder**: free strikes and maturities per leg, delta hedge, presets from a book of 30+ strategies. The structure is named automatically.
- **Market**: spot, rates, dividends, ATM vol and term structure, and a SABR smile (β = 1; ρ = skew, ν = vol-of-vol). Sticky-strike or sticky-moneyness dynamics. Each tenor has a no-arbitrage check.
- **Payoff**: at expiry, today, or at a scenario horizon, with spot, vol and days sliders.
- **Smile**: per maturity, plotted against strike, forward moneyness or delta, with 25Δ risk reversal and butterfly quotes.
- **Greeks**: Δ Γ ν Θ vanna volga charm ρ, across spot or moneyness, at several horizons.
- **P&L explain**: the scenario P&L split into Taylor terms plus a residual.
- **Risk matrix**: spot shocks × vol shocks.

## Run it

Online: https://poctave.github.io/vol-lab/. Locally: it is a static page with no build step and no dependencies, so open `index.html` in a browser, or serve the folder (`python3 -m http.server`). State is kept in `localStorage`.

## Tests

```
node run-tests.js
```

## Layout

- `js/lab-engine.js`: the pricing model (Black-Scholes with rates and dividends, SABR smile, term structure, arbitrage checks, bump Greeks, scenarios).
- `js/options-math.js`, `js/data/option-strategies.js`: the strategy book and the classifier that names a position.
- `js/views/options-lab-view.js`: the UI. `js/frame.js` is the console chrome.

The "C2" strategy sheet is the reference setup the strategy book is calibrated on: S₀ = 100, 3-month options, zero rates, and an equity skew (20% at 100, 23.7% at 90, 25.7% at 85, 16.7% at 110, 15.1% at 115).
