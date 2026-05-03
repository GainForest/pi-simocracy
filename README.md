# pi-simocracy

Load a [Simocracy](https://simocracy.org) sim into your [`pi`](https://github.com/mariozechner/pi-coding-agent) chat — see its
pixel-art sprite render in the terminal and chat with the agent **as that sim**.

```
/sim mr meow
```

…fetches Mr Meow from Simocracy's ATProto indexer, renders his 32×32
sprite as colored ANSI half-blocks directly in the chat, and pushes
his constitution + speaking style into pi's system prompt so pi
roleplays as Mr Meow until you `/sim unload`.

![Mr Meow loaded inline in pi](demo/sim-load.gif)

---

## Install

```bash
pi install npm:pi-simocracy
```

That's it. Open `pi`, type `/sim mr meow`, and you're talking to the cat.

For the optional `simocracy_chat` tool (one-shot conversation through
OpenRouter without changing the active session persona), set
`OPENROUTER_API_KEY` in your environment. The slash-command flow
doesn't need it — it just rewrites pi's system prompt.

---

## Slash commands

| Command           | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `/sim <name>`     | Load a sim by name (fuzzy search). Multiple matches → picker. |
| `/sim <at-uri>`   | Load a sim by AT-URI directly (no search).                  |
| `/sim status`     | Show which sim is currently loaded.                         |
| `/sim unload`     | Drop the persona and break character cleanly.               |
| `/sim login [handle]` | Sign in to **ATProto / Bluesky** via loopback OAuth (NOT Anthropic — pi's built-in `/login` is what does that). Required before pi can update your sim. |
| `/sim logout`     | Clear the local ATProto OAuth session.                      |
| `/sim whoami`     | Show the signed-in handle / DID.                            |
| `/sim my [name]`  | List / pick / fuzzy-load sims you own on your PDS. Single match auto-loads; ambiguous matches open a picker. Requires `/sim login`. |
| `/sim help`       | Print usage.                                                |

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

There is no slash-command pipeline for this. Once you've signed in via
`/sim login` and loaded a sim you own (`/sim my`, then pick), just
**describe the change you want to pi**:

```
> add a red line about animal welfare to the constitution
> rewrite the speaking style to drop the lenny faces and be more concise
> shorten the constitution to ~300 words and emphasise renewable energy
```

Pi rewrites the constitution and/or speaking style itself, then calls
the `simocracy_update_sim` tool to persist the result. The tool refuses
to run if you're not signed in or you don't own the loaded sim. The
new persona takes effect on the next reply — no reload needed.

Writing goes directly to your PDS via
`com.atproto.repo.createRecord` / `putRecord` against the
`org.simocracy.agents` (constitution) and `org.simocracy.style`
(speaking style) collections — the same lexicons simocracy.org reads
back.

---

## LLM-callable tools

The same actions are exposed to pi as tools, so the model can drive them itself:

| Tool                    | Use when                                                        |
|-------------------------|-----------------------------------------------------------------|
| `simocracy_load_sim`    | Load a sim into the current session (sets the persona).         |
| `simocracy_unload_sim`  | Stop roleplaying.                                               |
| `simocracy_chat`        | Send one message to a sim and get a quoted reply, **without** changing the active session persona. Useful for "ask Mr Meow what he thinks of this PR." Requires `OPENROUTER_API_KEY`. |
| `simocracy_update_sim`  | Write a new constitution (`shortDescription` + `description`) and/or speaking `style` for the **loaded** sim to your PDS. Requires `/sim login` AND ownership of the loaded sim. |

---

## How it works

1. **Search.** GraphQL query against the public Simocracy indexer
   (`simocracy-indexer-production.up.railway.app`) for `org.simocracy.sim`
   records, then client-side fuzzy ranking by exact match → prefix → substring → token overlap.
2. **Resolve.** Parse the winning AT-URI, fetch the DID document from
   `plc.directory` (or the `did:web` well-known URL), follow the
   `#atproto_pds` service endpoint to find the owner's PDS.
3. **Hydrate.** Pull three records from the PDS via
   `com.atproto.repo.getRecord` / `listRecords`:
   - `org.simocracy.sim`     — display name + sprite + avatar blob refs
   - `org.simocracy.agents`  — short description + full constitution
   - `org.simocracy.style`   — speaking style / mannerisms
4. **Render.** Fetch the sprite blob via `com.atproto.sync.getBlob`,
   decode it, crop the front-facing idle frame, and emit as 24-bit ANSI
   using the upper-half-block character `▀` so each terminal cell paints
   two pixels. Two render paths depending on the sim's `spriteKind`:
   - **`pipoya`** (legacy + default): 128×128 PNG, 4×4 of 32×32 walking
     frames; decode with `pngjs`, take row 0 col 0 at native size.
   - **`codexPet`** (OpenAI hatch-pet output): 1536×1872 atlas, 8×9 of
     192×208 cells. PNG sheets decode through `pngjs`; WebP sheets
     decode through `@jsquash/webp` (wasm, lazy-init). The idle cell
     (row 0 col 0) is box-downscaled to ~32 wide so the inline render
     stays comparable in height to a pipoya sprite.
   Transparent regions show pi's background through.
5. **Inject.** A `before_agent_start` event handler appends the sim's
   identity + constitution + speaking style to pi's system prompt **every
   turn**. After `/sim unload`, a one-shot override fires on the next
   turn telling the model to break character so it doesn't keep imitating
   its own previous in-character replies.

No background processes, no extra terminal windows, no AppleScript — pi
keeps the terminal it's already running in.

---

## Files

```
src/
├── index.ts        # extension entry: slash command, tools, persona injection
├── persona.ts      # buildSimPrompt(sim) — the system-prompt fragment
├── simocracy.ts    # indexer + PDS client (read-only fetchers)
├── writes.ts       # PDS writers + ownership / sign-in preconditions
├── png-to-ansi.ts  # RGBA half-block ANSI renderer + downscalers
├── webp-to-rgba.ts # @jsquash/webp wrapper for codex pet WebP sheets
├── openrouter.ts   # minimal OpenRouter client (only used by simocracy_chat)
└── auth/           # ATProto OAuth loopback flow + session storage
demo/
└── sim-load.tape   # vhs tape — render with `vhs demo/sim-load.tape`
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

To rebuild the demo recording:

```bash
brew install vhs                   # one-time
vhs demo/sim-load.tape             # writes demo/sim-load.{webm,gif}
```

---

## Required peer dependencies

These come bundled with `pi` itself, so installing pi-simocracy via
`pi install npm:pi-simocracy` already gives you everything:

- `@mariozechner/pi-coding-agent` ≥ 0.58.0
- `@mariozechner/pi-tui` ≥ 0.58.0

Direct npm dependencies (auto-installed):

- `pngjs` — PNG decoder for pipoya sprite blobs and codex pet PNG sheets
- `@jsquash/webp` — wasm WebP decoder for codex pet WebP sheets
  (lazy-init, no native bindings)
- `@atproto/api` + `@atproto/oauth-client-node` — ATProto loopback OAuth
  for `/sim login` and PDS writes via `simocracy_update_sim`
- `typebox` — tool parameter schemas

---

## Related

- **Simocracy** — the governance simulation that mints these sims:
  [simocracy.org](https://simocracy.org)
- **pi** — Mario Zechner's terminal coding agent that hosts the
  extension: [`@mariozechner/pi-coding-agent`](https://github.com/mariozechner/pi-coding-agent)
- **OpenTUI experiments** — earlier prototype that spawned a separate
  Bun + OpenTUI window with an animated walking-cat scene. Removed in
  favour of the inline ANSI render. The git history still has it if
  you want the animated version back.

---

## License

MIT — see [LICENSE](./LICENSE).
