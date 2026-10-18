// Minimal in-process test framework. Works in browser and Node.
(function () {
  var suites = [];
  var current = null;

  function describe(name, fn) {
    var suite = { name: name, tests: [] };
    suites.push(suite);
    current = suite;
    try { fn(); } finally { current = null; }
  }

  function it(name, fn) {
    if (!current) throw new Error("it() called outside describe()");
    current.tests.push({ name: name, fn: fn });
  }

  function expect(actual) {
    return {
      toBe: function (expected) {
        if (actual !== expected) {
          throw new Error("Expected " + JSON.stringify(actual) + " to be " + JSON.stringify(expected));
        }
      },
      toEqual: function (expected) {
        var a = JSON.stringify(actual), b = JSON.stringify(expected);
        if (a !== b) throw new Error("Expected " + a + " to equal " + b);
      },
      toBeCloseTo: function (expected, decimals) {
        decimals = decimals == null ? 5 : decimals;
        var diff = Math.abs(actual - expected);
        var tol = Math.pow(10, -decimals) / 2;
        if (diff > tol) throw new Error("Expected " + actual + " to be close to " + expected + " (within " + tol + ")");
      },
      toBeTruthy: function () { if (!actual) throw new Error("Expected truthy, got " + actual); },
      toBeFalsy: function () { if (actual) throw new Error("Expected falsy, got " + actual); },
      toBeNaN: function () { if (!Number.isNaN(actual)) throw new Error("Expected NaN, got " + actual); },
      toThrow: function (msgPattern) {
        var threw = false, err;
        try { actual(); } catch (e) { threw = true; err = e; }
        if (!threw) throw new Error("Expected function to throw");
        if (msgPattern && !String(err.message).match(msgPattern)) {
          throw new Error("Threw '" + err.message + "', expected match " + msgPattern);
        }
      }
    };
  }

  function run() {
    var passed = 0, failed = 0, failures = [];
    suites.forEach(function (suite) {
      suite.tests.forEach(function (t) {
        try { t.fn(); passed++; }
        catch (e) {
          failed++;
          failures.push({ suite: suite.name, test: t.name, err: e });
        }
      });
    });
    return { passed: passed, failed: failed, failures: failures };
  }

  function reset() { suites = []; current = null; }

  var api = { describe: describe, it: it, expect: expect, run: run, reset: reset };

  // Expose globally so test files don't need to import.
  if (typeof window !== "undefined") {
    window.describe = describe; window.it = it; window.expect = expect;
    window.M1 = window.M1 || { data: {}, lib: { views: {} } };
    window.M1.testFramework = api;
  } else {
    globalThis.describe = describe; globalThis.it = it; globalThis.expect = expect;
  }
})();
