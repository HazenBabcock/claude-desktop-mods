# Handoff: patch the Claude Code desktop app to show context-window % instead of 5-hour usage %

> **Superseded in places.** Kept as the original spec. Its central assumption — that
> the badge lives in `app.asar`, so a patch holds until an intentional `apt upgrade` —
> is wrong: the window UI is served from claude.ai. See `README.md` for what was
> actually found and built.

## Goal

The Claude Code desktop app's usage indicator (bottom of the window) used to show the
**session context-window fraction**. It now shows the **5-hour rate-limit fraction**.
I want the context-window number back in the always-visible badge.

Hovering the badge already reveals all the usage numbers, so the data is present in the
app — it's only a question of which value gets promoted to the persistent slot.

## What's already been established (don't re-research this)

- **There is no setting for it.** Not in `settings.json`, not in `/config`, not an env var.
  The change from context-fraction to 5-hour-fraction is a hardcoded default.
- **`statusLine` does not apply.** The `statusLine` key in `~/.claude/settings.json` is a
  CLI/terminal-only feature. The desktop app silently ignores it.
  See github.com/anthropics/claude-code/issues/41456 (open — asks for desktop to honor
  `statusLine`) and issue 33257 (closed as not planned).
- **Native fallbacks that do work in the desktop app:** `/context` (context breakdown on
  demand) and `/usage` (limit detail). Both are on-demand, not glanceable — which is the
  whole reason for this patch.
- The status line JSON schema (documented for the CLI) shows the app has access to both
  `context_window.used_percentage` / `.remaining_percentage` and
  `rate_limits.five_hour.used_percentage` / `.resets_at`. Useful as a hint for what the
  renderer's internal field names might resemble — but do not assume the renderer uses
  these exact names.

## Environment

- Dell Inspiron 15 3530, Linux, LXQt desktop, X11 session, xfwm4 window manager
  (likely a Lubuntu / LXQt Ubuntu spin)
- `claude-desktop` installed from Anthropic's apt repo (`.deb`, Electron app)
- **The Linux desktop app does not self-update.** Updates only arrive via
  `sudo apt upgrade`. This means a patch persists until an intentional upgrade — good news
  for us, and it makes the re-apply story predictable.
- Asar integrity fuses (`EnableEmbeddedAsarIntegrityValidation`) are generally enforced on
  macOS and Windows but typically not on Linux — so a repacked asar usually just loads.
  **Verify rather than assume**; if the app refuses to start after repacking, this is the
  first suspect.

## Plan

Do these in order. Stop and report at each checkpoint rather than barreling ahead —
step 2 is what decides whether the rest is worth doing.

### 1. Locate the bundle

```bash
dpkg -L claude-desktop | grep -E 'asar|resources'
dpkg -s claude-desktop | grep -i version
```

Record the exact asar path and the installed version (the version matters — any patch is
version-specific and will need re-applying after an upgrade).

### 2. Prototype live in DevTools BEFORE modifying anything on disk

```bash
claude-desktop --remote-debugging-port=9222
```

Attach from Chrome via `chrome://inspect` → "Configure" → add `localhost:9222` → inspect
the renderer target.

In that console, work out:

- Which DOM element is the usage badge (inspect it; note a stable-looking selector, and
  note how stable it actually looks — minified class names are not stable across releases)
- Whether the context-window percentage is reachable from renderer state, or only lives in
  the tooltip's DOM when the tooltip is open. **This is the key question.** If the number is
  only computed on hover, the patch is harder and may need to reach further back into the
  data source.
- Whether a `MutationObserver` that rewrites the badge's text content from the
  context-window value actually holds up as the app re-renders

Get a working snippet in the console first. Report what you found before proceeding.

### 3. Persist it by injection, not surgery

Prefer **appending** your observer script to the renderer entry point over editing the
badge component in place. The component is minified and will be renamed on every release;
appended code that anchors on something structural has a chance of surviving an upgrade.

```bash
# back up first — non-negotiable
sudo cp /path/to/app.asar /path/to/app.asar.orig

npx @electron/asar extract /path/to/app.asar ./app-unpacked
# edit ./app-unpacked/... to append the injection
npx @electron/asar pack ./app-unpacked app.asar
sudo cp app.asar /path/to/app.asar
```

Restart the app and verify.

### 4. Make it repeatable

- `sudo apt-mark hold claude-desktop` so an `apt upgrade` doesn't silently revert the patch
  without me noticing.
- Write the whole thing as a shell script (`repatch.sh`) that backs up, extracts, injects,
  repacks, and installs — so re-applying after an intentional upgrade is one command.
- Have the script fail loudly if its anchor point isn't found, rather than producing a
  silently-unpatched app.

## Recovery

If the app won't launch after a repack:

```bash
sudo cp /path/to/app.asar.orig /path/to/app.asar
```

Or, worst case, reinstall the package:

```bash
sudo apt install --reinstall claude-desktop
```

Reinstalling is cheap. Losing an in-flight session to a broken app is the real cost, so
don't test a repack in the middle of work I care about.

## Constraints and expectations

- This is unsupported. It will break periodically, and it's on me to maintain.
- Don't touch anything outside the asar and the repatch script.
- Don't disable or work around security features (code signing, sandbox flags, integrity
  checks). If the patch turns out to require that, stop and tell me — the answer is to
  abandon the patch, not to defeat the check.
- Anchor on structure, not on minified identifiers, wherever there's a choice.
- If step 2 shows the context-window value isn't reachable from the renderer, say so
  plainly and stop. Better to know that in ten minutes than after an hour of asar wrangling.
