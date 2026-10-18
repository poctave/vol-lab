// theme.js — dark/light appearance for the OPS console. window.M1.lib.theme.
//
// One attribute drives everything: <html data-theme="dark|light">. terminal.css
// declares the dark palette on :root and overrides it under [data-theme=light],
// so flipping the attribute re-themes the console, the term-skin views and every
// var()-referencing inline style at once — no re-render needed.
//
// Device-local: this is a comfort setting for the light you're sitting in, so the phone can be light in
// the sun while the desktop stays dark.
(function () {
  "use strict";

  var KEY = "M1.theme";
  var DEFAULT = "dark";
  var VALID = { dark: 1, light: 1 };

  // Resolved per call so tests can swap them in and out via _setEnv.
  var storeOverride = null, rootOverride = null;

  function store() {
    if (storeOverride) return storeOverride;
    try { return (typeof window !== "undefined" && window.localStorage) || null; }
    catch (_e) { return null; }   // Safari private mode throws on access
  }
  function root() {
    if (rootOverride) return rootOverride;
    return (typeof document !== "undefined" && document.documentElement) || null;
  }
  function _setEnv(s, r) { storeOverride = s; rootOverride = r; }

  function get() {
    var s = store();
    if (!s) return DEFAULT;
    var v;
    try { v = s.getItem(KEY); } catch (_e) { return DEFAULT; }
    return VALID[v] ? v : DEFAULT;
  }

  function isLight() { return get() === "light"; }

  // Stamp the current preference onto <html> without touching storage.
  function apply() {
    var r = root();
    if (r) r.setAttribute("data-theme", get());
    return get();
  }

  function set(v) {
    if (!VALID[v]) return get();
    var s = store();
    if (s) { try { s.setItem(KEY, v); } catch (_e) {} }
    var r = apply();
    announce();          // here, not at the call sites — a caller that forgot
    return r;            // would leave stale glyphs behind with no other symptom
  }

  function toggle() { return set(get() === "light" ? "dark" : "light"); }

  // Two tabs of the app are separate documents sharing one localStorage,
  // so a flip in either has to reach the other.
  function onStorageEvent(e) {
    if (e && e.key === KEY) { apply(); announce(); }
  }

  // Views that paint a theme-dependent colour in JS rather than CSS (the 9c
  // heatmap ramp) and the console's own toggle glyph listen for this.
  function announce() {
    if (typeof window === "undefined" || !window.dispatchEvent || typeof CustomEvent !== "function") return;
    try { window.dispatchEvent(new CustomEvent("m1:themechange", { detail: { theme: get() } })); } catch (_e) {}
  }

  // 'l' toggles, but only when it isn't a character the user meant to type and
  // isn't part of a chord the browser owns (Cmd+L focuses the address bar).
  function shouldHandleKey(e) {
    if (!e || String(e.key).toLowerCase() !== "l") return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    var t = e.target || {};
    if (t.isContentEditable) return false;
    var tag = t.tagName || "";
    return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
  }

  function onKeydown(e) {
    if (!shouldHandleKey(e)) return;
    toggle();
  }

  // The console frame renders its own toggle into the top bar, and the interactive
  // flows now run inside that frame. The skinned routes still reachable without it
  // (the 9C readout's direct entry) get this one floating control instead — CSS
  // shows it only under html.term-skin, and hides it again whenever the frame is up.
  function mountFloatingToggle() {
    if (typeof document === "undefined" || !document.body) return;
    if (document.querySelector(".term-theme-float")) return;
    var btn = document.createElement("button");
    btn.className = "term-theme-float";
    btn.setAttribute("data-theme-float", "1");
    btn.setAttribute("aria-label", "Toggle light mode");
    function paint() {
      var lit = isLight();
      btn.textContent = lit ? "☾" : "☀";
      btn.title = (lit ? "Switch to dark" : "Switch to light") + " (l)";
    }
    paint();
    btn.addEventListener("click", function (e) { e.preventDefault(); toggle(); });
    window.addEventListener("m1:themechange", paint);
    document.body.appendChild(btn);
  }

  function init() {
    apply();
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", onStorageEvent);
      // Global, not per-view: 'l' has to work on every route, framed by the
      // console or not, so it can't hang off any one view's chrome.
      window.addEventListener("keydown", onKeydown);
    }
    mountFloatingToggle();
  }

  window.M1.lib.theme = {
    get: get, set: set, toggle: toggle, isLight: isLight,
    apply: apply, announce: announce,
    onStorageEvent: onStorageEvent, shouldHandleKey: shouldHandleKey,
    init: init,
    KEY: KEY,
    _setEnv: _setEnv  // for tests
  };
})();
