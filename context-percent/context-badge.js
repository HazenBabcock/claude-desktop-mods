/* context-badge — show context-window usage beside the Claude Desktop usage ring.
 *
 * Runs in the page's MAIN world, injected by the preload via webFrame.executeJavaScript.
 *
 * The badge button carries its own accessibility text, e.g.
 *   "Usage: 16% of 5-hour limit, Resets in 1 hr 28 min, Context 318.1k / 1M (32%)"
 * That is the app's own figure, already scoped to the visible session, and it is a
 * plain DOM attribute present at rest. Reading it beats recomputing the number from
 * raw token counts in the React tree: that earlier approach had to sum API usage
 * correctly, pick the right entry shape, and identify which of several open sessions
 * the log belonged to -- and got each of those wrong in turn.
 *
 * Anchors: SVG geometry (a circle whose stroke-dasharray equals its own
 * circumference) and the numeric shape "<used> / <total> (<pct>%)". Deliberately not
 * the word "Context", which localizes; digits, "/" and "%" do not.
 */
(function () {
  'use strict';
  if (window.__ctxBadge) return;

  var POLL_MS = 2000;      // cadence; the scan is now a couple of DOM reads
  var MISS_LIMIT = 3;      // consecutive misses before giving up (~6 s)
  var MARK = 'data-ctx-badge';

  /* "318.1k / 1M (32%)" -- the trailing parenthesised percent is the context one;
   * the leading "16%" in the same string is the 5-hour figure and is not in parens. */
  var NUM = '\\d+(?:[.,]\\d+)?\\s*[kKmM]?';
  var FULL = new RegExp('(' + NUM + ')\\\\s*/\\\\s*(' + NUM + ')\\\\s*\\\\((\\\\d+)\\\\s*%\\\\)');
  var PARENS_PCT = /\((\d+)\s*%\)/g;

  var state = { pct: null, detail: null, raw: null, misses: 0, lastWarn: 0, lastScanMs: 0 };

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /* The gauge: a <circle> whose stroke-dasharray is one full circumference.
   * If several match, take the lowest on screen (the status bar). */
  function findRing() {
    var cs = document.querySelectorAll('svg circle[stroke-dasharray]');
    var best = null;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      var da = parseFloat(c.getAttribute('stroke-dasharray'));
      var r = parseFloat(c.getAttribute('r'));
      if (!isFinite(da) || !isFinite(r) || r <= 0) continue;
      if (Math.abs(da - 2 * Math.PI * r) > 0.01) continue;
      var rect = c.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (!best || rect.bottom > best.rect.bottom) best = { el: c, rect: rect };
    }
    return best ? best.el : null;
  }

  /* Walk up from the ring rather than querying the document, so the text we read
   * belongs to this ring -- and therefore to the session actually on screen. */
  function ariaFor(ring) {
    var n = ring, i, a;
    for (i = 0; i < 8 && n; i++, n = n.parentElement) {
      a = n.getAttribute && n.getAttribute('aria-label');
      if (a && FULL.test(a)) return a;
    }
    for (n = ring, i = 0; i < 8 && n; i++, n = n.parentElement) {
      a = n.getAttribute && n.getAttribute('aria-label');
      if (a && a.indexOf('%)') !== -1) return a;
    }
    return null;
  }

  function parse(aria) {
    var m = FULL.exec(aria);
    if (m) return { pct: parseInt(m[3], 10), used: m[1].trim(), total: m[2].trim() };
    /* Fallback: last parenthesised percentage in the string. */
    var last = null, x;
    PARENS_PCT.lastIndex = 0;
    while ((x = PARENS_PCT.exec(aria)) !== null) last = x[1];
    return last === null ? null : { pct: parseInt(last, 10), used: null, total: null };
  }

  function ensureLabel(ring, text, title) {
    var svg = ring.ownerSVGElement || ring.closest('svg');
    if (!svg || !svg.parentElement) return false;
    var el = svg.parentElement.querySelector('[' + MARK + ']');
    if (!el) {
      el = document.createElement('span');
      el.setAttribute(MARK, '1');
      el.setAttribute('aria-hidden', 'true');   /* the button's own label already says it */
      el.style.cssText = 'font-size:11px;line-height:1;opacity:0.75;white-space:nowrap;' +
                         'font-variant-numeric:tabular-nums;pointer-events:none;';
      svg.insertAdjacentElement('afterend', el);
    }
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
    return true;
  }

  function clearLabels() {
    var els = document.querySelectorAll('[' + MARK + ']');
    for (var i = 0; i < els.length; i++) els[i].remove();
  }

  function tick() {
    var t0 = now();
    try {
      var ring = findRing();
      var aria = ring ? ariaFor(ring) : null;
      var got = aria ? parse(aria) : null;
      if (!ring || !got) {
        /* One missed tick is usually a re-render, not a failure. Give up only after
         * MISS_LIMIT consecutive misses -- long enough to ride out a re-render,
         * short enough that a stale number never lingers. */
        state.misses++;
        if (state.misses >= MISS_LIMIT) {
          clearLabels();
          state.pct = null; state.detail = null; state.raw = null;
          if (Date.now() - state.lastWarn > 60000) {
            state.lastWarn = Date.now();
            console.warn('[ctx-badge] anchor missing for ' + state.misses +
                         ' ticks — ring:', !!ring, 'aria:', aria);
          }
        }
      } else {
        state.misses = 0;
        state.pct = got.pct;
        state.detail = got.used ? got.used + ' / ' + got.total : null;
        state.raw = aria;
        ensureLabel(ring, got.pct + '%',
                    state.detail ? 'Context ' + state.detail : aria);
      }
    } catch (e) {
      console.error('[ctx-badge] tick failed', e);
    }
    state.lastScanMs = Math.round(now() - t0);
    setTimeout(tick, POLL_MS);
  }

  window.__ctxBadge = {
    version: 2,
    state: state,
    read: function () { var r = findRing(); return r ? ariaFor(r) : null; },
    remove: clearLabels
  };

  setTimeout(tick, 1500);
  console.log('[ctx-badge] installed (reads the badge\'s own aria-label)');
})();
