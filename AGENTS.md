# Agent Instructions

This file is for AI coding agents (pi, Claude Code, Cursor, Aider, …)
working on **pi-simocracy**. Read it before making changes.

---

## What this repo is

A `pi` extension. Single deliverable: an npm package called
`pi-simocracy` that, once installed via `pi install npm:pi-simocracy`,
adds:

1. The `/sim <name>` slash command (and `/sim status`, `/sim unload`).
2. Four LLM-callable tools: `simocracy_load_sim`,
   `simocracy_unload_sim`, `simocracy_chat`, `simocracy_update_sim`.
   The first three are read-only / session-local; `simocracy_update_sim`
   is the **only** PDS write surface this extension exposes — it
   writes a new constitution and/or speaking style for the loaded sim
   to the user's repo, gated on `/sim login` + ownership.
3. A `before_agent_start` event handler that injects the loaded sim's
   constitution and speaking style into pi's system prompt every turn.
4. A custom message renderer (`simocracy_sim_loaded`) that prints the
   sim's sprite as colored ANSI half-block art inline in pi's chat.

That's the whole feature surface. Don't bolt on unrelated pi features
here — push back to a separate extension.

---

## Project layout

```
.
├── AGENTS.md           # ← you are here
├── README.md           # user-facing install + usage docs
├── LICENSE             # MIT
├── package.json        # name: pi-simocracy, ships src/ + README + LICENSE
├── tsconfig.json       # strict TS, bundler resolution, allowImportingTsExtensions
├── .npmrc              # legacy-peer-deps=true (peer deps are pi internals)
├── src/
│   ├── index.ts        # extension entry — registers slash cmd + 4 tools + handlers
│   ├── persona.ts      # buildSimPrompt(sim) — the system-prompt fragment
│   ├── simocracy.ts    # GraphQL indexer client + PDS client (read-only)
│   ├── writes.ts       # PDS writers (agents + style) + auth / ownership preconditions
│   ├── png-to-ansi.ts  # RGBA half-block ANSI renderer (pngjs-backed) + downscalers
│   ├── webp-to-rgba.ts # @jsquash/webp wrapper for codex pet WebP sheets (lazy wasm init)
│   ├── openrouter.ts   # minimal OpenRouter client (only simocracy_chat uses it)
│   └── auth/           # ATProto loopback OAuth flow + session storage
└── demo/
    ├── sim-load.tape       # vhs tape — Mr Meow (pipoya) load → chat → unload
    └── codex-pet-load.tape # vhs tape — Einstein (codex pet) load → chat → unload
```

`demo/*.webm` is git-ignored. The `*.gif` outputs **are** committed —
they're the README hero images on github.com and pi.dev (which renders
from the npm tarball, where `demo/` is excluded, so the README
references them via absolute `raw.githubusercontent.com` URLs).
Regenerate both with `vhs demo/<name>.tape`.

---

## How pi extensions work (the relevant subset)

- `package.json` has a `pi.extensions` field listing entry-point files.
  We list `./src/index.ts`. Pi's loader handles TypeScript directly via
  jiti, so **you do not compile or bundle**.
- `src/index.ts` `export default async function (pi: ExtensionAPI) {…}`.
  Use `pi.registerCommand`, `pi.registerTool`, `pi.on(event, …)`,
  `pi.registerMessageRenderer`, etc.
- The two peer deps (`@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-tui`) are provided by `pi` itself. Mark them
  `peerDependencies`, not `dependencies`. `.npmrc` sets
  `legacy-peer-deps=true` so npm doesn't try to drag them in during
  local installs.
- Real npm dependencies should stay tiny. Today: `pngjs` (PNG decode),
  `@jsquash/webp` (WebP decode for codex pet sheets, wasm — no native
  bindings), `typebox` (tool parameter schemas), and the two `@atproto`
  packages used by the OAuth + write flows. Don't add more without a
  strong reason.

---

## Architecture

### Data flow on `/sim <name>`

```
user types /sim mr meow
  │
  ▼
runLoadFlow()                                   src/index.ts
  ├── searchSimsByName()                        src/simocracy.ts
  │     POST simocracy-indexer/graphql {records(collection: "org.simocracy.sim")}
  │     fuzzy-rank client-side, return up to 8 matches
  │
  ├── ctx.ui.select() if multiple matches
  │
  └── hydrateLoadedSim()                        src/index.ts
        ├── fetchAgentsForSim()                 src/simocracy.ts
        │     PDS listRecords org.simocracy.agents, find the one whose
        │     sim.uri matches
        ├── fetchStyleForSim()                  src/simocracy.ts
        │     PDS listRecords org.simocracy.style, same pattern
        ├── renderSpriteAnsi()                  src/index.ts
        │     fetchBlob(sprite) → decodePng → cropRgba(0,0,32,32)
        │     → renderRgbaToAnsi(half-blocks)
        └── resolveHandle()                     src/simocracy.ts
              public.api.bsky.app/getProfile → handle string

→ loadedSim = { uri, did, rkey, name, handle, spriteAnsi, … }
→ postSimToChat() emits a custom message that the renderer turns into
  Sprite + name + handle + AT-URI + shortDescription
→ ctx.ui.setStatus() shows 🐾 Mr Meow in the footer
→ ctx.ui.setWidget() pins "Simocracy: Mr Meow" above the editor
```

### Persona injection

Every turn, the `before_agent_start` handler runs *before* pi calls the
LLM. If `loadedSim` is set, the handler returns a `systemPrompt` that
appends `buildSimPrompt(loadedSim)` to whatever pi was about to send.

`buildSimPrompt` produces a markdown block with the sim's identity,
constitution, speaking style, and a closing instruction telling the
model to stay in character but still use pi's tools when asked.

### Unload — the subtle bit

`/sim unload` does **two** things, not one:

1. Sets `loadedSim = null` so persona injection stops.
2. Sets `justUnloaded = "<name>"` so the very next
   `before_agent_start` appends a one-shot **break-character override**
   to the system prompt and then clears `justUnloaded`.

The override is needed because the conversation history still contains
the in-character replies the model just produced. Without an explicit
override, the model imitates its own previous style and stays in
character even though the persona prompt is gone. Don't remove this
mechanism if you refactor; verify it still works with the smoke test
in **Verifying changes** below.

---

## Lexicons used (read-only)

ATProto records are fetched via standard XRPC. The only write surface
is `simocracy_update_sim` (constitution + style only); the `sim`,
`petSheet`, and `image` blobs are owned by simocracy.org's create flow.
The Simocracy lexicons we read:

| NSID                           | Records pulled                                                            |
|--------------------------------|---------------------------------------------------------------------------|
| `org.simocracy.sim`            | name, `spriteKind`, sprite/image blob refs, codex pet `petSheet` + `petManifest` |
| `org.simocracy.agents`         | shortDescription + full constitution                                      |
| `org.simocracy.style`          | speaking style / mannerisms                                               |

Plus blobs via `com.atproto.sync.getBlob` (with redirect-follow because
bsky.social returns 302 to its CDN).

If you need a record we don't currently fetch, add a function in
`src/simocracy.ts` (don't sprinkle XRPC calls across `index.ts`) and
a corresponding field on `LoadedSim`. Keep the indexer-first +
PDS-fallback pattern for anything user-facing.

---

## Sprite rendering

`src/png-to-ansi.ts` is a small standalone module:

- `decodePng(buf)` — pngjs wrapper, always returns 8-bit RGBA.
- `cropRgba(data, w, h, x, y, cw, ch)` — copies a sub-rectangle into a
  fresh buffer.
- `renderRgbaToAnsi(data, w, h, opts)` — emits ANSI with one terminal
  cell per **two vertical pixels** using `▀` (top half = fg, bottom half
  = bg). Falls back to `▄` when only the lower pixel is opaque.
  Respects an `alphaThreshold` so transparent regions don't print a
  background colour.

Default render path (`renderSpriteAnsi` in `index.ts`) branches on
`org.simocracy.sim.spriteKind`:

1. **`pipoya`** (legacy + default when the field is absent). Crop the
   top-left 32×32 frame from the 128×128 sprite-sheet PNG — that's the
   front-facing walk-1 pose. Native size, ~13 lines tall. The full
   sprite sheet is 4 columns × 4 rows of 32×32 frames, in row order
   front / left / right / back.
2. **`codexPet`** (OpenAI hatch-pet output). Crop the top-left 192×208
   cell from the 1536×1872 atlas — that's the idle frame. Atlases come
   in PNG (decoded by pngjs) or WebP (decoded by `decodeWebp` in
   `webp-to-rgba.ts`, which lazy-inits the @jsquash/webp wasm module on
   first use). Box-downscaled to ~32 wide so the inline render is
   roughly the same height (~17 lines) as a pipoya sprite. Full atlas
   layout is 8 columns × 9 rows; rows are named animation states (idle,
   running-right, …) — see `lib/sprites/codex-pet-rows.ts` in the
   simocracy-v2 repo for the contract.
3. **Fallback for either kind**: the static `image` blob, a
   client-rendered thumbnail PNG. Pi-pixel-art-upscaled images get
   nearest-neighbour downsampled to native res; non-pixel-art images
   (codex pet thumbnails, photos) get box-downscaled to a 40-pixel
   long edge so the inline render stays bounded. This path is *only*
   a fallback — it's lossier than reading the original sheet.

---

## Coding rules

- TypeScript strict mode, ES2022, ESM (`"type": "module"`). `.ts`
  imports use the `.ts` extension explicitly because pi's loader needs
  it (`allowImportingTsExtensions: true` in `tsconfig.json`).
- No build step. Pi loads `src/*.ts` directly. Don't add `dist/` or
  bundlers. Don't generate `.js` files.
- No new npm dependencies without explicit approval. Vet anything you
  add for size, native-build requirements, and ESM compatibility.
- No `console.log` in shipping code. Errors must be returned via tool
  results (`throw new Error(…)` or an isError-style content block) or
  via `ctx.ui.notify(…, "error")` for slash-command UX.
- All state is module-level (`loadedSim`, `justUnloaded`). The
  extension is a singleton — pi loads it once per session.
- Don't hardcode DIDs, handles, AT-URIs, or PDS hosts. The only
  hardcoded constant is the indexer URL
  (`simocracy-indexer-production.up.railway.app`), which is exposed as
  `SIMOCRACY_INDEXER_URL` for callers to override.

---

## Tool / command contracts

When you change a tool's parameters, description, or behaviour:

- Update `src/index.ts` (the source of truth).
- Update README.md's "Slash commands" / "LLM-callable tools" tables.
- Update this file's "What this repo is" section if the surface area
  changed.
- Re-record the vhs tape if user-visible output changed.

Tool descriptions are surfaced to the LLM verbatim — write them like
prompts, not API docs. They should answer "when should the model call
this?" in one sentence.

---

## Verifying changes

There's no test runner. Verify by hand. The minimum smoke tests:

```bash
# 1. Type-check
npx tsc --noEmit

# 2. Pack what npm would publish
npm pack --dry-run                     # confirm contents are sane

# 3. Round-trip the load → chat → unload flow
pi -e $(pwd)/src/index.ts --print --no-session --no-context-files \
   --no-skills -t "simocracy_load_sim,simocracy_unload_sim" \
   "Step 1: simocracy_load_sim query='Mr Meow'. \
    Step 2: reply to 'one-line greeting?'. \
    Step 3: simocracy_unload_sim. \
    Step 4: reply to 'one-line greeting?' speaking normally. Stop."
```

Step 2's reply should sound like Mr Meow (lenny faces, *meow*, snarky
about surveillance). Step 4 should sound like default pi/Claude
("Hello! How can I help you today?" or similar). If step 4 still
sounds like Mr Meow, the unload override is broken — see
**Unload — the subtle bit** above.

If you change the rendering, also re-record the demo and eyeball the
result:

```bash
brew install vhs                       # one-time
vhs demo/sim-load.tape
ffmpeg -i demo/sim-load.webm -vf "select='eq(n\,400)'" -vsync vfr /tmp/loaded.png
open /tmp/loaded.png
```

Mr Meow should fit comfortably alongside the loaded-sim message in a
typical 30-row terminal — currently ~13 lines tall.

---

## Releasing

Bump version, push, publish:

```bash
npm version patch                      # 0.1.x → 0.1.(x+1) for bugfixes
# or  npm version minor                # 0.x.0 → 0.(x+1).0 for features
# or  npm version major                # 0.x.x → 1.0.0     for breaking changes
git push --follow-tags

npm publish                            # public access, no scope
```

Vercel doesn't matter here — this repo isn't deployed anywhere. The
only artifact is the npm package.

After publishing, users update with `pi update pi-simocracy`.

---

## Don'ts

- ❌ Don't add a build step, bundler, or `dist/` directory.
- ❌ Don't add npm dependencies (especially native ones) without
  approval. `pngjs` and `typebox` are the budget.
- ❌ Don't write to user PDSs from this extension. It's read-only by
  design — the simocracy.org webapp owns the write paths.
- ❌ Don't spawn subprocesses or open extra terminal windows. The
  earlier OpenTUI prototype did that and we deliberately removed it.
- ❌ Don't rely on `OPENROUTER_API_KEY` for the slash-command flow.
  Loading a sim should work even without internet access to OpenRouter
  — the persona is injected via pi's existing model API, not a
  side-channel.
- ❌ Don't hardcode personalities or fall back to "fake" sims when the
  indexer is unreachable. Surface the error to the user via
  `ctx.ui.notify(…, "error")`.
- ❌ Don't introduce a separate constitution or style record schema.
  The existing `org.simocracy.agents` and `org.simocracy.style`
  collections are the contract.

---

## Where to ask

- This extension's issues:
  https://github.com/GainForest/pi-simocracy/issues
- Pi itself: https://github.com/mariozechner/pi-coding-agent
- Simocracy webapp + lexicons:
  https://github.com/GainForest/simocracy-v2
