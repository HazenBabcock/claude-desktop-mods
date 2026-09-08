# context-badge — context-window % beside the Claude Desktop usage ring

Companion to `handoff.md`, the original spec. Read this first if you're picking
the work up cold; several of that document's assumptions turned out to be wrong.

## What we found (corrections to the handoff)

**The badge is not in the asar.** The main window's local `index.html` says so
outright: *"this is the html for app title bar and error UI. everything else gets
loaded from claude.ai"*. The local `main_window` renderer is 85 KB — a title bar and
a load-error overlay. The local i18n file has 636 strings, all shell/tray. The Code
tab runs at `https://claude.ai/epitaxy/<session>`; the badge is remote React.

The `five_hour` / `resets_at` / `utilization` strings that *are* in the asar belong
to the **system tray menu** and `~/.config/Claude/plan-usage-history.json`. The
`contextWindow` hits are the `contextWindowByModel` settings schema. None of them
drive the in-window badge.

**Consequences.** `apt-mark hold` does not protect this patch from its most likely
cause of breakage, because the UI re-downloads from claude.ai on every launch.
Expect breakage on Anthropic's web-deploy cadence, not on your upgrade schedule.
The hold is still set, so that asar upgrades stay deliberate.

**The badge is a bare SVG ring**, no text — `stroke-dasharray` = 2πr, fraction =
`1 - dashoffset/dasharray`. That fraction is the **5-hour** figure, not context.

**Developer mode.** `~/.config/Claude/developer_settings.json` = `{"allowDevTools":
true}` enables DevTools. The menu item is gated on a value read at module load, so
it stays hidden until restart — but **Ctrl+Alt+I works immediately**, because that
path calls a forced re-read. Right-click → Inspect Element also becomes available.

The app **refuses to launch** with `--remote-debugging-port` or other debugging /
network-override switches. That is deliberate; don't try to defeat it. Diagnostics
go through the DevTools console by hand.

## Where the number comes from

The badge button carries its own accessibility text:

    aria-label = "Usage: 16% of 5-hour limit, Resets in 1 hr 28 min,
                  Context 318.1k / 1M (32%)"

That is the app's own figure, already scoped to the visible session, carrying its own
denominator, present as a plain DOM attribute at rest — no hover, no React.

## How the patch works

`context-badge.js` runs in the page's main world, injected by the preload
(`/.vite/build/mainView.js`) via `webFrame.executeJavaScript` — which a preload can
call to reach the main world, and which is not subject to page CSP.

Every 2 s it finds the ring, walks **up from it** to the nearest ancestor whose
`aria-label` matches, parses the percentage, and injects a small
`<span data-ctx-badge>` beside the ring. Walking up rather than querying the document
is what keeps it scoped to the session on screen. The ring itself is left alone, so
it keeps agreeing with its own tooltip.

Anchors: **SVG geometry** (a circle whose dasharray equals its own circumference) and
the **numeric shape** `<used> / <total> (<pct>%)`. Deliberately not the word
"Context" — digits, `/` and `%` survive localization; English does not.

If the ring or a parseable label can't be found it **removes its own label** rather
than leaving a stale number, after `MISS_LIMIT` consecutive misses (3, ~6 s). The
delay matters: the ring is briefly unmatchable while React re-renders that subtree,
and clearing on the first miss made the label blink out during ordinary use.

## Why not read the React tree

The first implementation walked the fiber tree for raw API `usage` objects and summed
tokens. It worked, then failed three separate ways:

1. **`SecurityError` every tick** — the tree holds cross-origin frame `Window`s (the
   analytics iframe); reading any named property on one throws.
2. **2–4× too high** — a turn-completion record's `usage` is a roll-up summed over
   every API iteration, and each iteration re-reads most of the context.
3. **Wrong session entirely** — the walk searched the whole page, so a *different*
   project's log could outrank the visible one. `storm-analysis-tuning` showed 41%
   (another session's number) when it was actually at 76%.

All three were reconstructions of a number the app had already computed correctly, on
an attribute a few nodes up from where the walk was digging. Read the aria-label.

## Applying it

    sudo DRY_RUN=1 ./repatch.sh    # build + verify, install nothing (app may be running)
    # quit the app fully, then:
    sudo ./repatch.sh

`repatch.sh` refuses to run against a live app, backs up to a **version-stamped**
`app.asar.orig-<version>` (a flat `.orig` would be a stale wrong-version backup after
an upgrade), and re-patches from that backup if the live archive is already patched —
so it is safe to run repeatedly.

`asar_patch.py` rewrites exactly one entry and copies the other 282 verbatim. This is
deliberately not `asar pack`: three entries are flagged `unpacked` and live in
`app.asar.unpacked/`, and a repack without matching `--unpack-dir` patterns silently
breaks the native modules. It also preserves asar's content dedup (several entries
share one offset) and recomputes the SHA256 **integrity** metadata that all 283
entries carry — the check stays valid; nothing is disabled.

Verification before install: 283 entries, the same 3 unpacked paths, exactly one
changed file, marker present exactly once, integrity recomputed correctly, and the
archive's size delta exactly equal to the target file's. Any mismatch aborts.

## Reverting

    sudo cp /usr/lib/claude-desktop/resources/app.asar.orig-<version> \
            /usr/lib/claude-desktop/resources/app.asar
    # or
    sudo apt install --reinstall claude-desktop

## Debugging (DevTools console, Ctrl+Alt+I)

    window.__ctxBadge.state    // { pct, detail, raw, misses, lastScanMs, lastWarn }
    window.__ctxBadge.read()   // the raw aria-label currently being parsed
    window.__ctxBadge.remove() // remove the label until the next tick

`[ctx-badge] installed` on startup means the injection ran. `[ctx-badge] anchor
missing` means the ring or the label format moved — the likeliest symptom of a
claude.ai deploy. `read()` shows the string, which usually makes the cause obvious.

Ground truth without the badge: session records live in
`~/.config/Claude/claude-code-sessions/*/*/local_<id>.json` (they carry `title`,
`cwd`, and `cliSessionId`), and the transcript is
`~/.claude/projects/<cwd-encoded>/<cliSessionId>.jsonl`. The last record's
`message.usage` summed as `input + cache_creation_input + cache_read_input` is the
real context. Note the `sessionId` *inside* transcript records is the session that
wrote them, which after a fork or resume is not the session displaying them — do not
use it to identify a session.

## Verifying which payload is installed

Do not grep the whole archive: identifiers can also occur in the bundled agent code,
so a whole-file grep gives false positives. Check inside the preload entry:

    python3 - <<'EOF'
    import sys; sys.path.insert(0, '.')
    from asar_patch import read_asar, walk
    f, h, b = read_asar('/usr/lib/claude-desktop/resources/app.asar')
    n = dict(walk(h))['/.vite/build/mainView.js']
    f.seek(b + int(n['offset']))
    d = f.read(n['size'])
    for t in (b'ariaFor', b'MISS_LIMIT'):
        print(t.decode(), t in d)
    EOF

## Known limits

- Depends on the aria-label's shape. If Anthropic restructures that string the
  pattern stops matching; the label then removes itself rather than going stale.
- Polls every 2 s rather than subscribing, so the number can lag a moment.
- React may remove the injected label when it re-renders that subtree; the next tick
  puts it back, so brief flicker is possible. A sustained disappearance (>6 s) is the
  real failure signal and logs `anchor missing`.
- Untested against asar integrity **fuses**. These are generally enforced on macOS
  and Windows but not Linux. Integrity metadata is recomputed correctly either way,
  but if the app refuses to launch after patching, this is the first suspect —
  revert, and do not attempt to disable the fuse.
