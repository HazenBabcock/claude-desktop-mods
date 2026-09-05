# context-badge — context-window % beside the Claude Desktop usage ring

Companion to `handoff.md`, the original spec. Read this first if you're picking
the work up cold; several of that document's assumptions turned out to be wrong.

## What we found (corrections to the handoff)

**The badge is not in the asar.** The main window's local `index.html` says so
outright: *"this is the html for app title bar and error UI. everything else gets
loaded from claude.ai"*. The local `main_window` renderer is 85 KB — a title bar
and a load-error overlay. The local i18n file has 636 strings, all shell/tray. The
Code tab runs at `https://claude.ai/epitaxy/<session>`; the badge is remote React.

The `five_hour` / `resets_at` / `utilization` strings that *are* in the asar belong
to the **system tray menu** and `~/.config/Claude/plan-usage-history.json`. The
`contextWindow` hits are the `contextWindowByModel` settings schema. None of them
drive the in-window badge.

**Consequences.** `apt-mark hold` does not protect this patch from its most likely
cause of breakage, because the UI re-downloads from claude.ai on every launch.
Expect breakage on Anthropic's web-deploy cadence, not on your upgrade schedule.
The hold is still set, so that asar upgrades stay deliberate.

**The badge is a bare SVG ring**, no text — `stroke-dasharray` = 2πr, fraction =
`1 - dashoffset/dasharray`. There is no number in the DOM at rest.

**Developer mode.** `~/.config/Claude/developer_settings.json` = `{"allowDevTools":
true}` enables DevTools. The menu item is gated on a value read at module load, so
it stays hidden until restart — but **Ctrl+Alt+I works immediately**, because that
path calls a forced re-read. Right-click → Inspect Element also becomes available.

## Where the number comes from

Not from IPC. `contextBridge.exposeInMainWorld` creates non-configurable properties,
so `claudeAppBindings.registerBinding` cannot be wrapped from the page — attempting
it raises `TypeError: Cannot redefine property`.

Instead, the React tree holds the transcript with per-message Anthropic API `usage`
objects. Context occupancy is:

    input_tokens + cache_creation_input_tokens + cache_read_input_tokens

taken from the **newest** message. Newest, not largest: after a compaction the
largest is a stale high-water mark that never comes back down.

## How the patch works

`context-badge.js` runs in the page's main world, injected by the preload
(`/.vite/build/mainView.js`) via `webFrame.executeJavaScript` — which a preload can
call to reach the main world, and which is not subject to page CSP.

Every ~2 s it walks the fiber tree for the newest `usage`, computes a percentage
against `CONTEXT_WINDOW_TOKENS` (**1,000,000**, set at the top of the file), and
injects a small `<span data-ctx-badge>` beside the ring. The ring itself is left
alone, so it keeps agreeing with its own tooltip.

It anchors only on things that survive minification: **API field names**, **React
fiber internals**, and **SVG geometry** (a circle whose dasharray equals its own
circumference). No component names, no CSS classes.

If the ring or the usage data can't be found it **removes its own label** and warns
to the console once a minute, rather than leaving a stale number on screen.

## Applying it

    sudo DRY_RUN=1 ./repatch.sh    # build + verify, install nothing (app may be running)
    # quit the app fully, then:
    sudo ./repatch.sh

`repatch.sh` refuses to run against a live app, backs up to a **version-stamped**
`app.asar.orig-<version>` (a flat `.orig` would be a stale wrong-version backup
after an upgrade), and re-patches from that backup if the live archive is already
patched — so it is safe to run repeatedly.

`asar_patch.py` rewrites exactly one entry and copies the other 282 verbatim.
This is deliberately not `asar pack`: three entries are flagged `unpacked` and live
in `app.asar.unpacked/`, and a repack without matching `--unpack-dir` patterns
silently breaks the native modules. It also preserves asar's content dedup (several
entries share one offset) and recomputes the SHA256 **integrity** metadata that all
283 entries carry — the check stays valid; nothing is disabled.

Verification before install: 283 entries, the same 3 unpacked paths, exactly one
changed file, marker present exactly once, integrity recomputed correctly, and the
archive's size delta exactly equal to the target file's. Any mismatch aborts.

## Reverting

    sudo cp /usr/lib/claude-desktop/resources/app.asar.orig-<version> \
            /usr/lib/claude-desktop/resources/app.asar
    # or
    sudo apt install --reinstall claude-desktop

## Debugging (DevTools console, Ctrl+Alt+I)

    window.__ctxBadge.state         // { pct, tokens, lastScanMs, lastWarn }
    window.__ctxBadge.getWindow()   // current denominator
    window.__ctxBadge.setWindow(2e5)// try a different window size live
    window.__ctxBadge.remove()      // remove the label until the next tick

`[ctx-badge] installed` on startup means the injection ran. `[ctx-badge] anchor
missing` means the ring or the usage data moved — the most likely symptom of a
claude.ai deploy.

## Traps (both cost a patch cycle — don't rediscover them)

**`webFrame.executeJavaScript` from the preload does reach the main world.** With
`contextIsolation` on it is easy to assume otherwise and go hunting for
`executeJavaScriptInIsolatedWorld(0, ...)` or a `<script>` injection. Verified
empirically: the payload runs in the page's world, where React lives.

**Never read a property during the fiber walk outside a try/catch.** The tree holds
references to cross-origin frame Windows (the `a.claude.ai/isolated-segment.html`
analytics iframe). Reading *any* named property on one throws
`SecurityError: Blocked a frame with origin ... from accessing a cross-origin frame`,
which kills the whole tick. Hence `safeGet` / `safeKeys` / `isForeign`, and the
frame-hopping keys (`contentWindow`, `defaultView`, `parent`, `top`, ...) in `SKIP`.
The tell for a cross-origin Window is that even `v.window === v` throws.

**Stopping a bad copy needs a restart.** `delete window.__ctxBadge` only drops the
global handle; the `setTimeout` chain lives in a closure and keeps running. Pasting a
fixed copy into the console works fine alongside it (the broken one throws before
reaching any DOM code), but the console noise persists until the app restarts.

## Verifying which payload is installed

Do not grep the whole archive: identifiers like `contextTokens` also occur in the
bundled agent code, so a whole-file grep gives false positives. Check inside the
preload entry:

    python3 - <<'EOF'
    import sys; sys.path.insert(0, '.')
    from asar_patch import read_asar, walk
    f, h, b = read_asar('/usr/lib/claude-desktop/resources/app.asar')
    n = dict(walk(h))['/.vite/build/mainView.js']
    f.seek(b + int(n['offset']))
    d = f.read(n['size'])
    for t in (b'contextTokens', b'safeGet'):
        print(t.decode(), t in d)
    EOF

**Verify against a turn that makes several tool calls**, not a plain question. The
token count comes from a turn-completion record whose `usage` is summed over every
API iteration, so on a single-iteration turn a wrong formula and a right one agree
exactly. That is how the roll-up bug survived its first check against the tooltip.

## Known limits

- The 1,000,000 denominator was confirmed once against the badge tooltip on
  2026-09-04, but it is asserted rather than discovered; nothing in the page
  exposes the per-model window. If the effective window differs, the number is
  wrong by that ratio — `setWindow()` to check before editing the file.
- The fiber walk is a polling scan, not an event subscription. It costs a few ms
  every 2 s and backs off to 8 s if a scan exceeds 150 ms.
- React may remove the injected label when it re-renders that subtree; the next
  tick puts it back, so brief flicker is possible.
- Untested against asar integrity **fuses**. These are generally enforced on macOS
  and Windows but not Linux. Integrity metadata is recomputed correctly either way,
  but if the app refuses to launch after patching, this is the first suspect —
  revert, and do not attempt to disable the fuse.
