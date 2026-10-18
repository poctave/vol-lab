// _namespace.js — defines window.M1 if not already present.
// Browser: window already exists.
// Node: globalThis is the global; we attach a window alias.
(function () {
  var g = (typeof window !== "undefined") ? window
        : (typeof globalThis !== "undefined") ? globalThis
        : this;
  if (!g.window) g.window = g;
  if (!g.window.M1) g.window.M1 = { data: {}, theoryData: {}, lib: { views: {} } };
})();
