# Boot pi with the local pi-simocracy build, load Einstein (the only
# `spriteKind: codexPet` sim on the indexer today — webp petSheet, no
# image PNG fallback), watch the WebP atlas decode, the idle cell crop,
# the box-downscale, and the half-block ANSI render fire inline.
#
# Run from the pi-simocracy repo root:
#   vhs demo/codex-pet-load.tape

Output demo/codex-pet-load.webm
Output demo/codex-pet-load.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1400
Set Height 900
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"

# Clean working directory so pi doesn't load a stray AGENTS.md.
Hide
Type "cd /tmp && rm -rf vhs-codex-pet && mkdir vhs-codex-pet && cd vhs-codex-pet"
Enter
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Show

# Boot pi with only the local pi-simocracy extension (no global ones, no
# skills, no context). -ne disables auto-discovery so /sim is loaded
# exclusively from the working tree we're testing.
Type "pi -e ~/Projects/pi-simocracy/src/index.ts -ne -ns"
Enter
Sleep 6s

# Fuzzy-load the codex pet sim by name. Real-world timing under pi's
# interactive event loop on a residential connection: indexer search
# ~2s, PDS listRecords ~2s, ~2 MB WebP petSheet fetch ~10–15s (the
# main bottleneck — satyam2.climateai.org's getBlob endpoint is
# slower than its listRecords), wasm decode ~110 ms, render <50 ms.
# Total roughly 15–20s; we sleep 25s for headroom.
Type "/sim einstein"
Sleep 600ms
Enter
Sleep 25s

# Ask Einstein a one-liner so the persona injection is visible too.
Type "in one short sentence: who are you?"
Enter
Sleep 22s

# Quit cleanly so vhs finishes encoding.
Ctrl+c
Sleep 600ms
Ctrl+c
Sleep 600ms
