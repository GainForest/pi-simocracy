# vhs hero tape — the README's main demo for pi-simocracy 0.5.x.
#
# Hides pi's boot sequence so the recording opens *inside* a live pi
# session, then loads two sims back-to-back: Duo (a Duolingo owl
# codex-pet — animated 6-frame idle in real terminals; this vhs shows
# the universal half-block fallback because xterm.js can't render Kitty
# graphics) and Mr Meow (a pipoya pixel-art cat). Each is asked a
# one-liner so persona injection is visible too.
#
# Render with:  vhs demo/sim-hero.tape
# Outputs:      demo/sim-hero.{webm,gif}

Output demo/sim-hero.webm
Output demo/sim-hero.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1400
Set Height 900
Set TypingSpeed 35ms
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"

# vhs renders through xterm.js, which can't display Kitty graphics or
# iTerm2 inline images. But vhs inherits the parent shell's env (e.g.
# `TERM_PROGRAM=ghostty` when this tape is rendered from inside cmux),
# which would make pi-simocracy think inline graphics are available and
# emit escape sequences that xterm.js silently drops — leaving the
# sprite invisible. Force the half-block fallback so the recording
# actually shows the loaded sims.
Env SIMOCRACY_INLINE_GRAPHICS "ansi"

# ─── Hidden boot ──────────────────────────────────────────────────────
# Clean working directory, launch pi with the dev extension. Pi takes a
# few seconds to wake up; we hide that so the recording opens on a
# fresh pi prompt rather than the boot banner.
Hide
Type "cd /tmp && rm -rf vhs-hero && mkdir vhs-hero && cd vhs-hero"
Enter
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Type "pi -e ~/Projects/pi-simocracy/src/index.ts -ne -ns -nc"
Enter
Sleep 6s
Show

# ─── Recording starts here ────────────────────────────────────────────
Sleep 800ms

# 1. Load a codex pet — Duolingo's owl mascot. In Kitty / Ghostty /
#    WezTerm / iTerm2 the sprite renders as a true-pixel inline image
#    that animates through 6 idle frames at 5 fps. xterm.js (vhs)
#    falls back to the universal half-block render: same source RGBA,
#    `▀` / `▄` 24-bit colour cells.
Type "/sim duo"
Sleep 800ms
Enter
# Cold-load timing: indexer ~2s + PDS listRecords ~2s + ~2 MB WebP
# petSheet fetch ~10–14s + wasm decode ~110ms + render <50ms.
# Sleep 22s for headroom.
Sleep 22s

# 2. Ask Duo something quick so the persona is visible — the model
#    replies in Duo's snarky Duolingo voice.
Type "in one streak-keeping sentence: why should I learn Spanish?"
Enter
Sleep 20s

# 3. Switch to a pipoya pixel-art sim mid-conversation.
Type "/sim mr meow"
Sleep 800ms
Enter
# Pipoya sprite sheet is a tiny PNG (no WebP decode), so this is much
# faster than the codex pet path — ~5s including persona hydration.
Sleep 6s

# 4. Same prompt, different persona — Mr Meow answers in lenny faces.
Type "in one sentence: who are you?"
Enter
Sleep 20s

# 5. Drop the persona explicitly so the demo ends on default pi.
Type "/sim unload"
Sleep 400ms
Enter
Sleep 2s

# ─── Hidden teardown ──────────────────────────────────────────────────
Hide
Ctrl+c
Sleep 400ms
Ctrl+c
Sleep 400ms
