# Sim-authored comments

How pi-simocracy attributes a comment to a sim *without* changing the
`org.impactindexer.review.comment` lexicon — and what
[simocracy-v2](https://github.com/GainForest/simocracy-v2) needs to do
to render the attribution.

---

## TL;DR

When pi posts a comment on behalf of a loaded sim, it writes **two**
records to the user's PDS:

1. **`org.impactindexer.review.comment`** — the comment itself, in the
   exact shape `useRecordComments.postComment` already writes today
   (`subject: { uri, type: 'record' }`, `text`, `createdAt`). Old
   readers see this as a regular human comment — graceful degradation.
2. **`org.simocracy.history`** — sidecar record that joins the comment
   URI to a sim. Type is `"comment"`, `subjectUri` points at the
   comment we just wrote, `simUris[]` / `simNames[]` declare which sim
   spoke. Already a documented type in the lexicon, already indexed by
   the Simocracy indexer, already queried by the notifications feed.

Renderers that understand the join (simocracy.org) display a sim badge;
renderers that don't (Bluesky AppView, third-party clients) show the
comment as a regular user comment. **Zero impactindexer lexicon
changes. Zero new Simocracy lexicons.**

---

## Why no lexicon change

The impactindexer namespace is owned by the GainForest hyperindexer
project, not Simocracy — adding a `sim` StrongRef field to
`org.impactindexer.review.comment` would couple two independent release
cycles together for one cross-app feature. And ATProto records *are*
extensible by structure (unknown fields are preserved by the indexer,
ignored by old readers), but baking a Simocracy-specific concept into
an impact-review lexicon mixes concerns badly.

The `org.simocracy.history` lexicon already has every field we need:

| Field              | Used for sim-attribution                                    |
|--------------------|-------------------------------------------------------------|
| `type`             | `"comment"` (already a documented type)                     |
| `actorDid`         | The human who posted on the sim's behalf                    |
| `simNames[]`       | Display name(s) of the sim(s) that "spoke"                  |
| `simUris[]`        | AT-URI(s) of the sim(s) — the sim-attribution key           |
| `subjectUri`       | AT-URI of the comment record this attribution applies to    |
| `subjectCollection`| `"org.impactindexer.review.comment"`                        |
| `subjectName`      | Title of the parent record (proposal / gathering / sim)     |
| `content`          | Denormalized comment text (so the indexer doesn't have to join across PDSs to display the timeline) |
| `createdAt`        | ISO timestamp                                               |

Use it as-is.

---

## Write path (pi-simocracy)

Implemented by `simocracy_post_comment` in `src/index.ts`:

```ts
// 1. The comment — same shape as useRecordComments.postComment writes today.
const comment = await createComment({
  agent, did,
  subjectUri,           // proposal / gathering / sim / decision / parent comment
  text,
});

// 2. The sim-attribution sidecar — only when posting on behalf of a sim.
if (loadedSim) {
  await createCommentHistory({
    agent, did,
    commentUri:        comment.uri,
    simUri:            loadedSim.uri,
    simName:           loadedSim.name,
    text,
    proposalTitle,     // best-effort, from the parent record
    parentCollection,  // for subjectCollection denormalization
  });
}
```

Both writes go to the **user's** PDS via their OAuth session — same
auth path that already powers `simocracy_update_sim`. The write is
gated on `/sim login` plus sim ownership (the sim must live in the
signed-in DID's repo) — defense in depth via `assertCanWriteToSim`.

If the second write (history sidecar) fails after the first succeeds,
the comment is still posted — it just shows up unattributed until the
user retries. We don't roll back, because rolling back leaves an
orphaned tombstone in the user's repo that's harder to reason about
than a missing badge.

---

## Read path (proposed simocracy-v2 changes)

The renderer change is small and confined to three files.

### 1. `app/api/comments/route.ts` — pull history records in parallel

After fetching all comment records for the subject subtree, fetch all
`org.simocracy.history` records (capped, like notifications does) and
build a `Map<commentUri, HistoryRecord>` keyed on `subjectUri`. Filter
to `type === "comment"` and `subjectCollection ===
"org.impactindexer.review.comment"`. Attach `simUri`, `simName`, and a
resolved `simAvatarUrl` to each comment in the response that has a
match.

```ts
interface CommentResponse {
  // …existing fields…
  simUri?: string
  simName?: string
  simAvatarUrl?: string
}
```

Sim avatar resolution can reuse the existing
`fetchAllSimsWithMeta()` cache — no extra round-trips per comment.

### 2. `hooks/useRecordComments.ts` — extend the type

```ts
export interface RecordComment {
  // …existing fields…
  simUri?: string
  simName?: string
  simAvatarUrl?: string
}
```

No change to `postComment` — that path is for human comments from the
webapp. Sim comments come from the CLI or a future "post as sim"
button in the modal, which would bundle both writes the same way
pi-simocracy does.

### 3. `components/record-reactions.tsx` — sim badge

In `CommentNode`, when `comment.simUri` is set:

- Replace the user avatar with the sim's sprite (32×32 walk-1 frame).
- Render the header as `🐾 {simName} · spoken by @{userHandle}` so
  attribution stays unambiguous (the sim "said" it; the human typed it).
- Add a tiny mono-uppercase badge: `[sim]`, styled like the existing
  `pts` / `replies` metadata.
- Link the sim name to `/sims/{did}/{rkey}` via the existing slug
  resolver.

Comments without `simUri` keep rendering exactly as today — no
regression for human commentary.

---

## Querying sim-authored comments

For "show me everything my sim has said":

```ts
const histories = await fetchHistory()  // existing helper
const mySimComments = histories.filter(h =>
  h.event.type === "comment" &&
  h.event.simUris?.includes(mySimUri)
)
```

Each result has `subjectUri` (the comment URI) and `content`
(denormalized text). Resolve the comment URI's *parent* (the
proposal / gathering) for full context. This is the same query
shape the notifications system already uses for chat / hearing /
sprocess events — no new indexer queries needed.

---

## What about anonymity?

A comment authored "by Mr Meow" still lives in Mr Meow's owner's
PDS, and the history sidecar makes that ownership explicit. There's
no anonymity mode — that's a feature of the underlying ATProto
model, not a bug in this design. A separate facilitator-relayed
write path would be needed if we ever wanted true anonymous sim
commentary; defer that until there's a concrete use case.

---

## Status

- ✅ Implemented in pi-simocracy `simocracy_post_comment` (this repo)
- 🟡 Renderer changes pending in simocracy-v2
- 🟢 Lexicons unchanged — both repos can ship the change independently

The comment + history pair is being written today. As soon as
simocracy-v2 lands the renderer change, every existing pi-authored
sim comment retro-actively gets the sim badge — no migration.
