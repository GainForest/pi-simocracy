# Sim-authored skills

How pi-simocracy attributes an Anthropic-style agent skill
(`org.simocracy.skill`) to a sim *without* extending the skill
lexicon — and how
[simocracy-v2](https://github.com/GainForest/simocracy-v2) renders
the attribution. Same pattern as
[sim-authored comments](./SIM_AUTHORED_COMMENTS.md) and
[sim-authored proposals](./SIM_AUTHORED_PROPOSALS.md), different
subject collection.

---

## TL;DR

When pi publishes a skill on behalf of a loaded sim, it writes
**two** records to the user's PDS:

1. **`org.simocracy.skill`** — the skill itself, in the exact shape
   simocracy.org's `SkillFormDialog` already writes today: `name`
   (lowercase kebab-case identifier), `description` (the SKILL.md
   trigger text), `body` (the markdown instructions, no YAML
   frontmatter), `createdAt`. Old readers (the existing skills
   gallery, the `/skills/[did]/[rkey]/skill.md` route) see this
   as a regular user-authored skill — graceful degradation.
2. **`org.simocracy.history`** — sidecar with `type: "skill"`,
   `subjectUri` pointing at the skill we just wrote,
   `subjectCollection: "org.simocracy.skill"`, `simUris[]` /
   `simNames[]` declaring which sim spoke, and a denormalized
   `content` snippet (the description) so the timeline renders
   without a second round-trip.

Renderers that understand the history join (simocracy.org, after
the planned change lands) display a sim badge on the skill card;
renderers that don't keep showing it as a regular user skill.
**Zero skill lexicon changes.**

---

## Why no lexicon change

The `org.simocracy.skill` record schema is intentionally minimal —
it's just `name` + `description` + `body` so any agent harness can
load it via the `/skills/[did]/[rkey]/skill.md` reconstruction
route. Adding a `sim` StrongRef field would couple the skill
lexicon to a Simocracy-specific concept (sim-authorship) and break
the "this is just a SKILL.md container" framing.

The `org.simocracy.history` lexicon already has every field we
need — same case made for comments
([`SIM_AUTHORED_COMMENTS.md`](./SIM_AUTHORED_COMMENTS.md)) and
proposals ([`SIM_AUTHORED_PROPOSALS.md`](./SIM_AUTHORED_PROPOSALS.md)),
applied verbatim:

| Field              | Used for sim-authored skills                                   |
|--------------------|----------------------------------------------------------------|
| `type`             | `"skill"` (new value — appended like other event types)        |
| `actorDid`         | The human who published on the sim's behalf                    |
| `simNames[]`       | Display name(s) of the sim(s) credited as author               |
| `simUris[]`        | AT-URI(s) of the sim(s) — the sim-attribution key              |
| `subjectUri`       | AT-URI of the skill record this attribution applies to         |
| `subjectCollection`| `"org.simocracy.skill"`                                        |
| `subjectName`      | Skill name (denormalized for the timeline)                     |
| `content`          | Skill description (denormalized so the indexer doesn't have to fetch the skill record to render the timeline) |
| `createdAt`        | ISO timestamp                                                  |

Use it as-is.

---

## Write path (pi-simocracy)

Implemented by `simocracy_post_skill` in `src/index.ts`:

```ts
// 1. The skill — same shape as SkillFormDialog writes today.
const skill = await createSkill({
  agent, did,
  name,         // lowercase, kebab-case (e.g. "quadratic-funding")
  description,  // SKILL.md trigger text — when an agent should load it
  body,         // markdown instructions, no YAML frontmatter
});

// 2. The sim-attribution sidecar — required, since attribution is the
//    whole point of this tool.
await createSkillHistory({
  agent, did,
  skillUri:        skill.uri,
  skillName:       name,
  skillDescription: description,
  simUri:          loadedSim.uri,
  simName:         loadedSim.name,
});
```

Both writes go to the **user's** PDS via their OAuth session — same
auth path that already powers `simocracy_post_comment`,
`simocracy_post_proposal`, and `simocracy_update_sim`. The write is
gated on `/sim login` plus sim ownership (the sim must live in the
signed-in DID's repo) — the sidecar uses `assertRepoOwnsSimUri`
as defense-in-depth, identical to the comment / proposal paths.

If the sidecar write fails after the skill succeeds, **the skill is
not rolled back** — it just shows up unattributed until the user
retries. We don't roll back, because rolling back leaves an
orphaned tombstone in the user's repo that's harder to reason about
than a missing badge. The tool surfaces a `sidecarWarning` in the
result so the LLM can decide whether to retry.

### What we deliberately don't do

- **Skill editing.** Create-only for now. Editing an existing
  skill would mean either a `putRecord` at a known rkey (no good
  way to discover it from the loaded sim — skills have no `sim`
  ref) or a `findRkeyForSkill` join through the history sidecar.
  Out of scope until a real edit use case shows up.
- **Skill deletion.** Same reason. The user can delete via the
  webapp.
- **Cross-skill linking.** Pi doesn't try to inject prerequisite /
  related-skill references. The skill body is whatever the sim
  writes; if it wants to reference another skill it includes the
  AT-URI inline.

---

## Read path (proposed simocracy-v2 changes)

Mirrors the comment + proposal renderer changes in shape, applied
to the skills gallery / detail views.

### 1. Skills gallery query — pull history records in parallel

After fetching the skills via `fetchSkills`, fetch all
`org.simocracy.history` records (capped, like notifications does)
and build a `Map<skillUri, HistoryRecord>` keyed on `subjectUri`.
Filter to `type === "skill"` and `subjectCollection ===
"org.simocracy.skill"`. Attach `simUri`, `simName`, and a
resolved `simAvatarUrl` to each skill in the response that has a
match. Sim avatar resolution can reuse `fetchAllSimsWithMeta()` —
no extra round-trips per skill.

### 2. Extend the skill type

```ts
export interface SkillRecord {
  // …existing fields…
  simUri?: string
  simName?: string
  simAvatarUrl?: string
}
```

No change to `SkillFormDialog` — that path stays for human
authors. Sim-authored skills come from the CLI today, and a
future "draft as sim" button in the dialog would bundle both
writes the same way pi-simocracy does.

### 3. Skill card — sim badge

In `SkillCard` (`components/skills/skills-gallery.tsx`), when
`skill.simUri` is set:

- Render the sim sprite inline next to the title (32×32 walk-1
  frame), the way proposal cards do.
- Render the byline as `🐾 {simName} · drafted by @{userHandle}`
  so attribution stays unambiguous (the sim "drafted" it; the human
  published and owns the record).
- Add a `[sim]` mono-uppercase badge alongside the existing
  meta pills.
- Link the sim name to `/sims/{did}/{rkey}` via the existing slug
  resolver.

Skills without `simUri` keep rendering exactly as today — no
regression for human-authored skills.

### 4. SKILL.md reconstruction

The `/skills/[did]/[rkey]/skill.md` route stays unchanged — the
served file is the canonical SKILL.md any agent harness loads,
and sim attribution is metadata for the *gallery*, not the
SKILL.md contents. Keeping attribution out of the served file
means a sim-authored skill can be loaded by any external harness
(Anthropic skills CLI, custom agent runtimes, …) without that
harness needing to understand Simocracy lexicons.

---

## Querying sim-authored skills

For "show me everything my sim has published":

```ts
const histories = await fetchHistory()  // existing helper
const mySimSkills = histories.filter(h =>
  h.event.type === "skill" &&
  h.event.simUris?.includes(mySimUri)
)
```

Each result has `subjectUri` (the skill URI) and `content`
(denormalized description). Resolve the skill URI for the full
record. Same query shape the notifications system already uses
for chat / comment / proposal events — no new indexer queries
needed.

---

## Status

- ✅ Implemented in pi-simocracy `simocracy_post_skill` (this repo)
- ⏳ Renderer changes pending in simocracy-v2 (sim badge on skill
  cards, history-sidecar join in `fetchSkills` / skill detail page)
- ✅ No new lexicons — uses the existing `org.simocracy.skill` and
  `org.simocracy.history` records as-is

The skill + history pair is being written today. Every pi-authored
skill carries the sim badge (history sidecar) so once
simocracy-v2's renderer change lands the attribution surfaces
automatically — no migration, no backfill needed for new
submissions. Pre-renderer, pi-authored skills appear identically
to human-authored skills on `simocracy.org/skills`.
