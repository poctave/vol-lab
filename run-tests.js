#!/usr/bin/env node
// Runs the unit tests in Node: no dependencies, no build. `node run-tests.js`
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ctx = { console: console }; ctx.globalThis = ctx; vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
["js/_namespace.js", "tests/test-framework.js", "js/options-math.js", "js/greeks-math.js", "js/data/option-strategies.js", "js/lab-engine.js"].forEach(load);
fs.readdirSync(path.join(__dirname, "tests")).filter(f => f.endsWith(".test.js")).sort()
  .forEach(f => load("tests/" + f));
const r = ctx.window.M1.testFramework.run();
r.failures.forEach(f => console.log("  FAIL  " + f.suite + " > " + f.test + "\n        " + f.err.message));
console.log("\n  " + r.passed + " passed, " + r.failed + " failed");
process.exit(r.failed ? 1 : 0);
