// frame.js — the standalone console chrome: top bar, main area, status bar, keyboard.
// window.M1.lib.terminalFrame — the same small API the views use (esc, panel, mount).
(function () {
  "use strict";
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function panel(code, title, meta, body, scroll) {
    return '<section class="term-panel p-' + code.toLowerCase() + '" data-panel="' + code + '">' +
      '<header class="term-ph"><span class="code">' + code + '</span><span>' + esc(title) + '</span>' +
      (meta ? '<span class="ph-meta">' + meta + '</span>' : '') + '</header>' +
      '<div class="term-pb' + (scroll ? ' scroll' : '') + '">' + body + '</div></section>';
  }
  function themeIsLight() { var T = window.M1.lib.theme; return !!(T && T.isLight()); }

  var keyHandler = null, themeHandler = null;

  function mount(rootEl, view) {
    var light = themeIsLight();
    var brand = window.M1.APP_BRAND || "VOL";
    rootEl.innerHTML = '<div class="term-root is-standalone">' +
      '<div class="term-top"><div class="term-top-segs">' +
        '<div class="seg term-brand">' + brand + '</div>' +
        (view.topSegs || "") + '<div class="spacer"></div></div>' +
        '<button class="term-theme" data-theme-toggle="1" aria-label="Toggle light mode" title="Light / dark (l)">' +
          (light ? "☾" : "☀") + '</button></div>' +
      '<div class="term-frame"><div class="term-main' + (view.mainCls ? " " + view.mainCls : "") + '">' + view.main + '</div></div>' +
      '<div class="term-status"><span class="seg">' + (view.statusHints || "") + '</span>' +
        '<span class="spacer"></span>' + (view.statusSegs || "") + '</div>' +
      '</div>';

    function paintThemeBtn() {
      var btn = rootEl.querySelector("[data-theme-toggle]");
      if (btn) btn.textContent = themeIsLight() ? "☾" : "☀";
    }
    var tb = rootEl.querySelector("[data-theme-toggle]");
    if (tb) tb.addEventListener("click", function (e) { e.preventDefault(); window.M1.lib.theme.toggle(); });
    if (themeHandler) window.removeEventListener("m1:themechange", themeHandler);
    themeHandler = paintThemeBtn;
    window.addEventListener("m1:themechange", themeHandler);

    if (keyHandler) document.removeEventListener("keydown", keyHandler);
    keyHandler = function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter" && (tag === "BUTTON" || tag === "A")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (view.onKey && view.onKey(e)) return;
      if (e.key === "r" && view.remount) view.remount();
    };
    document.addEventListener("keydown", keyHandler);
    return function teardown() {
      if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
    };
  }

  window.M1.lib.terminalFrame = { esc: esc, panel: panel, mount: mount };
})();
