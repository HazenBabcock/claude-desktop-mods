/* context-badge — show context-window usage beside the desktop app's usage ring.
 *
 * Runs in the page's MAIN world (injected by the preload via webFrame.executeJavaScript).
 * Deliberately anchors only on:
 *   - Anthropic API field names (input_tokens, cache_read_input_tokens, ...)
 *   - React's internal fiber conventions (__reactFiber$, memoizedProps/State, child/sibling)
 *   - SVG geometry (a circle whose stroke-dasharray equals its own circumference)
 * It never references a minified component name or a CSS class, because those change
 * on every claude.ai deploy.
 */
(function () {
  'use strict';
  if (window.__ctxBadge) return;

  var CONTEXT_WINDOW_TOKENS = 1000000;   // effective context window; change here if it differs
  var POLL_MS = 2000;                    // normal cadence
  var SLOW_MS = 8000;                    // backoff when a scan is expensive
  var MARK = 'data-ctx-badge';

  var state = { pct: null, tokens: null, lastWarn: 0, lastScanMs: 0 };

  function isUsage(u) {
    return !!u && typeof u === 'object' &&
      (typeof u.input_tokens === 'number' || typeof u.cache_read_input_tokens === 'number');
  }
  /* A turn-completion record's `usage` is a ROLL-UP summed over every API
   * iteration in that turn, and each iteration re-reads most of the context.
   * A tool-using turn therefore reports 2-4x the real context. The true final
   * context is the LAST iteration. Last, not max: after a compaction the max
   * is a stale high-water mark. Falls back to the object itself when there is
   * no iterations array (a plain per-message usage). */
  function contextTokens(u) {
    var it = safeGet(u, 'iterations');
    var last = (it && it.length) ? it[it.length - 1] : u;
    if (!last || typeof last !== 'object') last = u;
    return (safeGet(last, 'input_tokens') || 0) +
           (safeGet(last, 'cache_creation_input_tokens') || 0) +
           (safeGet(last, 'cache_read_input_tokens') || 0);
  }

  function reactRoot() {
    var host = document.getElementById('root') || document.body;
    if (host) {
      var hk = Object.keys(host);
      for (var i = 0; i < hk.length; i++) {
        if (hk[i].indexOf('__reactContainer$') === 0) return host[hk[i]];
      }
    }
    var els = document.querySelectorAll('body *');
    for (var j = 0; j < els.length; j++) {
      var ek = Object.keys(els[j]);
      for (var k = 0; k < ek.length; k++) {
        if (ek[k].indexOf('__reactFiber$') === 0) {
          var f = els[j][ek[k]];
          while (f && f.return) f = f.return;
          return f;
        }
      }
    }
    return null;
  }

  /* Among containers holding usage-bearing entries, prefer the one with the most
   * entries (the real transcript), and within it the highest numeric index — the
   * newest message. Using the newest rather than the largest matters: after a
   * compaction the largest is a stale high-water mark that never comes back down. */
  /* Every property read below can throw: the fiber tree holds references to
   * cross-origin frame Windows (the analytics iframe), and touching any named
   * property on one raises SecurityError. Nothing is read outside a try. */
  function safeGet(o, k) { try { return o[k]; } catch (e) { return undefined; } }
  function safeKeys(o) { try { return Object.keys(o); } catch (e) { return null; } }
  function isForeign(v) {
    /* A cross-origin Window. Even the identity check throws, which is itself the tell. */
    try { return v.window === v || v.self === v; } catch (e) { return true; }
  }

  function considerContainer(o, keys, best) {
    if (!keys.length || keys.length > 5000) return best;
    var bestIdx = -1, found = null, count = 0;
    for (var i = 0; i < keys.length; i++) {
      var v = safeGet(o, keys[i]);
      if (!v || typeof v !== 'object' || isForeign(v)) continue;
      var u = safeGet(v, 'usage');
      if (!isUsage(u)) continue;
      count++;
      var n = parseInt(keys[i], 10);
      if (!isNaN(n)) { if (n > bestIdx) { bestIdx = n; found = u; } }
      else if (!found) { found = u; }
    }
    if (found && (!best || count >= best.count)) return { count: count, usage: found };
    return best;
  }

  var SKIP = { children: 1, _owner: 1, _store: 1, stateNode: 1, return: 1, child: 1,
               sibling: 1, alternate: 1, _debugOwner: 1, dependencies: 1, updateQueue: 1,
               window: 1, self: 1, parent: 1, top: 1, frames: 1, opener: 1, location: 1,
               contentWindow: 1, contentDocument: 1, ownerDocument: 1, defaultView: 1,
               view: 1, target: 1, currentTarget: 1, srcElement: 1, relatedTarget: 1 };

  function findLatestUsage(root) {
    var best = null, seen = new Set(), visited = 0, stack = [root];
    function scan(o, depth) {
      if (!o || typeof o !== 'object' || depth > 3 || seen.has(o)) return;
      seen.add(o);
      var keys = safeKeys(o);
      if (!keys) return;
      best = considerContainer(o, keys, best);
      for (var i = 0; i < keys.length && i < 200; i++) {
        var k = keys[i];
        if (SKIP[k]) continue;
        var v = safeGet(o, k);
        if (v && typeof v === 'object' && !isForeign(v)) scan(v, depth + 1);
      }
    }
    while (stack.length && visited < 40000) {
      var f = stack.pop();
      if (!f) continue;
      visited++;
      if (f.memoizedProps) scan(f.memoizedProps, 0);
      var h = f.memoizedState, hi = 0;
      while (h && typeof h === 'object' && hi < 25) {
        if (h.memoizedState) scan(h.memoizedState, 0);
        h = h.next; hi++;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return best ? best.usage : null;
  }

  /* The gauge: a <circle> whose stroke-dasharray equals 2*pi*r, i.e. one full
   * circumference. If several match, take the lowest on screen (the status bar). */
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

  function ensureLabel(ring, text, title) {
    var svg = ring.ownerSVGElement || ring.closest('svg');
    if (!svg || !svg.parentElement) return false;
    var el = svg.parentElement.querySelector('[' + MARK + ']');
    if (!el) {
      el = document.createElement('span');
      el.setAttribute(MARK, '1');
      el.setAttribute('aria-label', 'Context window used');
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
    var t0 = (performance && performance.now) ? performance.now() : Date.now();
    var next = POLL_MS;
    try {
      var ring = findRing();
      var root = ring ? reactRoot() : null;
      var usage = root ? findLatestUsage(root) : null;
      if (!ring || !usage) {
        /* Fail visibly rather than leaving a stale number on screen. */
        clearLabels();
        state.pct = null; state.tokens = null;
        if (Date.now() - state.lastWarn > 60000) {
          state.lastWarn = Date.now();
          console.warn('[ctx-badge] anchor missing — ring:', !!ring, 'usage:', !!usage);
        }
      } else {
        var tok = contextTokens(usage);
        var pct = Math.round(tok / CONTEXT_WINDOW_TOKENS * 100);
        state.tokens = tok; state.pct = pct;
        ensureLabel(ring, pct + '%',
          'Context: ' + tok.toLocaleString() + ' / ' +
          CONTEXT_WINDOW_TOKENS.toLocaleString() + ' tokens');
      }
    } catch (e) {
      console.error('[ctx-badge] tick failed', e);
    }
    var dt = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
    state.lastScanMs = Math.round(dt);
    if (dt > 150) next = SLOW_MS;
    setTimeout(tick, next);
  }

  window.__ctxBadge = {
    version: 1,
    state: state,
    setWindow: function (n) { CONTEXT_WINDOW_TOKENS = n; },
    getWindow: function () { return CONTEXT_WINDOW_TOKENS; },
    remove: clearLabels
  };

  setTimeout(tick, 3000);
  console.log('[ctx-badge] installed (window =', CONTEXT_WINDOW_TOKENS, 'tokens)');
})();
