# pi-simocracy

Load a [Simocracy](https://simocracy.org) sim into your
[`pi`](https://github.com/mariozechner/pi-coding-agent) chat — see its
sprite render in the terminal and chat with the agent **as that sim**.

```
/sim mr meow
```

…fetches Mr Meow from Simocracy's ATProto indexer, renders his sprite
inline, and pushes his constitution + speaking style into pi's system
prompt so pi roleplays as Mr Meow until you `/sim unload`.

<p align="center">
  <img src="https://raw.githubusercontent.com/GainForest/pi-simocracy/main/demo/sim-hero.gif" alt="Loading Duo (an animated codex-pet owl) and Mr Meow (a pipoya pixel-art cat) into pi's chat" width="900">
</p>

Two sprite kinds are supported:

- **Pipoya pixel-art sims** — 32×32 walking-frame sheets (e.g. Mr Meow).
- **Codex pet sims** — 192×208 atlases produced by OpenAI's hatch-pet
  skill (e.g. Duo, Einstein). The 6-frame idle loop animates in place
  in graphics-capable terminals.

In Kitty, Ghostty, WezTerm, Konsole, and iTerm2 the sprite renders as
a true-color inline image. Everywhere else it falls back to a 24-bit
ANSI half-block render that works in any modern terminal.

---

## Install

```bash
pi install npm:pi-simocracy
```

That's it. Open `pi`, type `/sim mr meow`, and you're talking to the cat.

The optional `simocracy_chat` tool (one-shot conversation through
OpenRouter without changing the active session persona) needs
`OPENROUTER_API_KEY` in your environment. The slash-command flow
doesn't — it just rewrites pi's system prompt.

---

## Slash commands

| Command               | What it does                                                                                                                          |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `/sim <name>`         | Load a sim by name (fuzzy search). Multiple matches → picker.                                                                         |
| `/sim <at-uri>`       | Load a sim by AT-URI directly (no search).                                                                                            |
| `/sim status`         | Show which sim is currently loaded.                                                                                                   |
| `/sim unload`         | Drop the persona and break character cleanly.                                                                                         |
| `/sim login [handle]` | Sign in to ATProto / Bluesky via loopback OAuth. Required before pi can update your sim. (This is unrelated to pi's built-in `/login`, which signs you in to your model provider.) |
| `/sim logout`         | Clear the local ATProto OAuth session.                                                                                                |
| `/sim whoami`         | Show the signed-in handle / DID.                                                                                                      |
| `/sim my [name]`      | List or fuzzy-load sims you own on your PDS. Single match auto-loads; ambiguous matches open a picker. Requires `/sim login`.         |
| `/sim help`           | Print usage.                                                                                                                          |

Examples:

```
/sim mr meow
/sim Marie Curie
/sim at://did:plc:qc42fmqqlsmdq7jiypiiigww/org.simocracy.sim/3mfo6vwfaka24
/sim login alice.bsky.social
/sim my
/sim unload
```

---

## Editing a sim's constitution / speaking style

Once you've signed in via `/sim login` and loaded a sim you own
(`/sim my`, then pick), just **describe the change you want to pi**:

```
> add a red line about animal welfare to the constitution
> rewrite the speaking style to drop the lenny faces and be more concise
> shorten the constitution to ~300 words and emphasise renewable energy
```

Pi rewrites the constitution and/or speaking style itself, then calls
the `simocracy_update_sim` tool to persist the result. The tool refuses
to run if you're not signed in or you don't own the loaded sim. The
new persona takes effect on the next reply — no reload needed.

Writes go directly to your PDS via `com.atproto.repo.createRecord` /
`putRecord` against the `org.simocracy.agents` (constitution) and
`org.simocracy.style` (speaking style) collections — the same lexicons
simocracy.org reads back.

---

## LLM-callable tools

The same actions are exposed to pi as tools, so the model can drive them itself:

| Tool                    | Use when                                                        |
|-------------------------|-----------------------------------------------------------------|
| `simocracy_load_sim`    | Load a sim into the current session (sets the persona).         |
| `simocracy_unload_sim`  | Stop roleplaying.                                               |
| `simocracy_chat`        | Send one message to a sim and get a quoted reply, **without** changing the active session persona. Useful for "ask Mr Meow what he thinks of this PR." Requires `OPENROUTER_API_KEY`. |
| `simocracy_update_sim`  | Write a new constitution (`shortDescription` + `description`) and/or speaking `style` for the loaded sim to your PDS. Requires `/sim login` AND ownership of the loaded sim. |

---

## How it works

1. **Search.** GraphQL query against the public Simocracy indexer
   for `org.simocracy.sim` records, then client-side fuzzy ranking by
   exact match → prefix → substring → token overlap.
2. **Resolve.** Parse the winning AT-URI, fetch the DID document from
   `plc.directory` (or the `did:web` well-known URL), follow the
   `#atproto_pds` service endpoint to find the owner's PDS.
3. **Hydrate.** Pull three records from the PDS via
   `com.atproto.repo.getRecord` / `listRecords`:
   - `org.simocracy.sim` — display name + sprite + avatar blob refs
   - `org.simocracy.agents` — short description + full constitution
   - `org.simocracy.style` — speaking style / mannerisms
4. **Render.** Fetch the sprite blob via `com.atproto.sync.getBlob`,
   decode it, and crop the front-facing idle frame. Two source paths
   depending on the sim's `spriteKind`:
   - **`pipoya`** — 128×128 PNG, 4×4 of 32×32 walking frames; decoded
     with `pngjs`, row 0 col 0 at native size.
   - **`codexPet`** — 1536×1872 atlas, 8×9 of 192×208 cells. PNG
     sheets decode through `pngjs`, WebP sheets through `@jsquash/webp`.
     The idle row supplies six frames for the animated loop.

   The cropped RGBA is then emitted through one of two output paths,
   picked automatically per terminal:
   - **Inline graphics** (Kitty graphics protocol or iTerm2 inline
     images). Re-encoded to PNG and transmitted as a true-color
     bitmap, sized so the terminal scales it cleanly. Codex pets
     animate in place by retransmitting each idle frame against a
     stable image ID at 5 fps.
   - **24-bit ANSI half-blocks.** `▀` / `▄` characters with
     `\x1b[38;2;…m` true-color escapes paint two pixels per cell.
     Universal fallback; works in Apple Terminal, plain SSH, tmux
     without passthrough, and anywhere that doesn't advertise inline
     image support.

   To force the half-block path even on a graphics-capable terminal
   (handy for screenshots or recording vhs tapes), set
   `SIMOCRACY_INLINE_GRAPHICS=ansi`.
5. **Inject.** A `before_agent_start` event handler appends the sim's
   identity + constitution + speaking style to pi's system prompt every
   turn. After `/sim unload`, a one-shot override fires on the next
   turn telling the model to break character so it doesn't keep
   imitating its own previous in-character replies.

No background processes, no extra terminal windows, no AppleScript —
pi keeps the terminal it's already running in.

---

## Files

```
src/
├── index.ts          # extension entry: slash command, tools, persona injection
├── persona.ts        # buildSimPrompt(sim) — the system-prompt fragment
├── simocracy.ts      # indexer + PDS client (read-only fetchers)
├── writes.ts         # PDS writers + ownership / sign-in preconditions
├── animated-image.ts # Kitty/iTerm2 inline-image component with frame timer
├── png-to-ansi.ts    # RGBA half-block ANSI renderer + downscalers
├── png-encode.ts     # RGBA → PNG encoder for inline-graphics protocols
├── webp-to-rgba.ts   # @jsquash/webp wrapper for codex pet WebP sheets
├── openrouter.ts     # minimal OpenRouter client (used by simocracy_chat)
└── auth/             # ATProto OAuth loopback flow + session storage
demo/
├── sim-hero.tape     # vhs tape — combined Duo + Mr Meow demo
├── sim-load.tape     # vhs tape — Mr Meow only (pipoya)
└── codex-pet-load.tape # vhs tape — Einstein only (codex pet)
```

---

## Local development

```bash
git clone https://github.com/GainForest/pi-simocracy
cd pi-simocracy
npm install                        # uses legacy-peer-deps (see .npmrc)
pi -e $(pwd)/src/index.ts -ne -ns  # load the extension directly
```

Then in `pi`: `/sim mr meow`.

To rebuild the demo recordings:

```bash
brew install vhs                   # one-time
vhs demo/sim-hero.tape             # combined hero — demo/sim-hero.{webm,gif}
vhs demo/sim-load.tape             # Mr Meow only
vhs demo/codex-pet-load.tape       # Einstein only
```

---

## Required peer dependencies

These come bundled with `pi` itself, so installing pi-simocracy via
`pi install npm:pi-simocracy` already gives you everything:

- `@mariozechner/pi-coding-agent` ≥ 0.58.0
- `@mariozechner/pi-tui` ≥ 0.58.0

Direct npm dependencies (auto-installed):

- `pngjs` — PNG decoder for pipoya sprite blobs and codex pet PNG sheets
- `@jsquash/webp` — wasm WebP decoder for codex pet WebP sheets (no native bindings)
- `@atproto/api` + `@atproto/oauth-client-node` — ATProto loopback OAuth
  for `/sim login` and PDS writes via `simocracy_update_sim`
- `typebox` — tool parameter schemas

---

## Related

- **Simocracy** — the governance simulation that mints these sims:
  [simocracy.org](https://simocracy.org)
- **pi** — Mario Zechner's terminal coding agent that hosts the
  extension: [`@mariozechner/pi-coding-agent`](https://github.com/mariozechner/pi-coding-agent)

---

## License

MIT — see [LICENSE](https://github.com/GainForest/pi-simocracy/blob/main/LICENSE).
