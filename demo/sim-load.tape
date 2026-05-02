# vhs tape: load Mr Meow into pi, see the persona + status, then chat with him.
# Run from the pi-simocracy/ repo root:
#   vhs demo/sim-load.tape

Output demo/sim-load.gif
Output demo/sim-load.webm

Set Shell "zsh"
Set FontSize 14
Set Width 1400
Set Height 800
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

# Use a clean working directory so pi doesn't load the simocracy AGENTS.md.
Hide
Type "cd /tmp && rm -rf vhs-pi && mkdir vhs-pi && cd vhs-pi"
Enter
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Show

# Launch pi with the simocracy extension loaded.
Type "pi -e ~/.supacode/repos/pi-simocracy/src/index.ts -ne -ns"
Enter
Sleep 4s

# Run the slash command — fuzzy search for Mr Meow.
Type "/sim mr meow"
Sleep 800ms
Enter

# Indexer has Mr Meow + Mr. Hat — the picker pops up. Mr Meow is highlighted, Enter confirms.
Sleep 1500ms
Enter
Sleep 5s

# Now ask Mr Meow something — pi is now roleplaying as him.
Type "who are you and what do you fight for?"
Enter
Sleep 22s

# Quit pi.
Ctrl+c
Sleep 400ms
Ctrl+c
Sleep 400ms
