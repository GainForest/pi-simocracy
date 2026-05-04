# Sim-authored proposals

How pi-simocracy attributes a funding proposal to a sim *without*
extending the `org.hypercerts.claim.activity` lexicon — and what
[simocracy-v2](https://github.com/GainForest/simocracy-v2) needs to
do to render the attribution. Same pattern as
[sim-authored comments](./SIM_AUTHORED_COMMENTS.md), different
subject collection.

---

## TL;DR

When pi submits a proposal on behalf of a loaded sim, it writes
**two** records to the user's PDS:

1. **`org.hypercerts.claim.activity`** — the proposal itself, in the
   exact shape simocracy.org's `ProposalFormDialog` already writes
   today (`title`, `shortDescription`, optional `description` /
   `workScope` / `contributors` / `image`, `createdAt`). Old readers
   (Hyperindexer, the existing webapp) see this as a regular
   user-authored proposal — graceful degradation.
2. **`org.simocracy.history`** — sidecar record with `type:
   "proposal"`, `subjectUri` pointing at the proposal we just wrote,
   `simUris[]` / `simNames[]` declaring which sim spoke. New `type`
   value, but the lexicon's `type` field is free-form string and the
   indexer already accepts new event types as they appear.

Renderers that understand the join (simocracy.org, when the planned
change lands) will display a sim badge on the proposal card;
renderers that don't keep showing it as a regular user proposal.
**Zero hypercerts lexicon changes. Zero new Simocracy lexicons.**

---

## Why no lexicon change

The `org.hypercerts.*` namespace is owned by the GainForest
hyperindexer project, not Simocracy — extending
`org.hypercerts.claim.activity` with a `sim` StrongRef field would
couple two independent release cycles together for one cross-app
feature, and the same argument made for comments
([`SIM_AUTHORED_COMMENTS.md`](./SIM_AUTHORED_COMMENTS.md)) applies
verbatim here.

The `org.simocracy.history` lexicon already has every field we need:

| Field              | Used for sim-authored proposals                              |
|--------------------|--------------------------------------------------------------|
| `type`             | `"proposal"` (new value — appended like other event types)   |
| `actorDid`         | The human who submitted on the sim's behalf                  |
| `simNames[]`       | Display name(s) of the sim(s) credited as author             |
| `simUris[]`        | AT-URI(s) of the sim(s) — the sim-attribution key            |
| `subjectUri`       | AT-URI of the proposal record this attribution applies to    |
| `subjectCollection`| `"org.hypercerts.claim.activity"`                            |
| `subjectName`      | Proposal title (denormalized for the timeline)               |
| `proposalTitle`    | Same as `subjectName` — kept parallel to comment sidecars    |
| `content`          | Denormalized description (so the indexer doesn't have to join across PDSs to display the timeline) |
| `createdAt`        | ISO timestamp                                                |

Use it as-is.

---

## Write path (pi-simocracy)

Implemented by `simocracy_post_proposal` in `src/index.ts`:

```ts
// 1. The proposal — same shape as ProposalFormDialog writes today.
const proposal = await createProposal({
  agent, did,
  title,
  shortDescription,
  description: finalDescription,   // user body + appended budget block, if any
  workScope,
  contributors: contributors.map((c) => ({ contributorIdentity: c })),
  image: { $type: "org.hypercerts.defs#uri", uri: imageUri ?? DEFAULT_BANNER },
});

// 2. The sim-attribution sidecar — required, since attribution is the whole
//    point of this tool.
await createProposalHistory({
  agent, did,
  proposalUri:   proposal.uri,
  proposalTitle: title,
  simUri:        loadedSim.uri,
  simName:       loadedSim.name,
  content:       finalDescription || shortDescription,
});
```

Both writes go to the **user's** PDS via their OAuth session — same
auth path that already powers `simocracy_post_comment` and
`simocracy_update_sim`. The write is gated on `/sim login` plus sim
ownership (the sim must live in the signed-in DID's repo) — the
sidecar uses `assertRepoOwnsSimUri` as defense-in-depth, identical
to the comment path.

If the sidecar write fails after the proposal succeeds, **the
proposal is not rolled back** — it just shows up unattributed until
the user retries. We don't roll back, because rolling back leaves an
orphaned tombstone in the user's repo that's harder to reason about
than a missing badge. The tool surfaces a `sidecarWarning` in the
result so the LLM can decide whether to retry.

### What we deliberately don't do

- **Image upload from disk.** The webapp uploads to `/api/upload-blob`;
  pi-simocracy has no equivalent and we deliberately stay
  read-mostly on blobs. The tool accepts an https `imageUri` only,
  with a default that mirrors the webapp's banner fallback.
- **Adding the proposal to a floor / collection.** That's a separate
  `org.hypercerts.claim.collection` write the webapp does via
  `/api/ftc-sf/add-to-collection`. Out of scope for this tool; a
  follow-up tool can chain it after the fact.
- **Editing existing proposals.** Create-only for now.

---

## Read path (proposed simocracy-v2 changes)

Mirrors the comment renderer change in shape, applied to the
proposal list / detail views.

### 1. Proposal list query — pull history records in parallel

After fetching the proposals for a floor / collection, fetch all
`org.simocracy.history` records (capped, like notifications does)
and build a `Map<proposalUri, HistoryRecord>` keyed on `subjectUri`.
Filter to `type === "proposal"` and `subjectCollection ===
"org.hypercerts.claim.activity"`. Attach `simUri`, `simName`, and a
resolved `simAvatarUrl` to each proposal in the response that has a
match. Sim avatar resolution can reuse `fetchAllSimsWithMeta()` —
no extra round-trips per proposal.

### 2. Extend the proposal type

```ts
export interface ProposalRecord {
  // …existing fields…
  simUri?: string
  simName?: string
  simAvatarUrl?: string
}
```

No change to `ProposalFormDialog` — that path stays for human
authors. Sim-authored proposals come from the CLI today, and a
future "submit as sim" button in the modal would bundle both writes
the same way pi-simocracy does.

### 3. Proposal card — sim badge

In the proposal card component, when `proposal.simUri` is set:

- Replace the author avatar with the sim's sprite (32×32 walk-1 frame).
- Render the byline as `🐾 {simName} · drafted by @{userHandle}` so
  attribution stays unambiguous (the sim "drafted" it; the human
  submitted and owns the record).
- Add a `[sim]` mono-uppercase badge alongside the existing meta
  pills.
- Link the sim name to `/sims/{did}/{rkey}` via the existing slug
  resolver.

Proposals without `simUri` keep rendering exactly as today — no
regression for human-authored proposals.

---

## Querying sim-authored proposals

For "show me everything my sim has proposed":

```ts
const histories = await fetchHistory()  // existing helper
const mySimProposals = histories.filter(h =>
  h.event.type === "proposal" &&
  h.event.simUris?.includes(mySimUri)
)
```

Each result has `subjectUri` (the proposal URI) and `content`
(denormalized description). Resolve the proposal URI for the full
record. Same query shape the notifications system already uses for
chat / hearing / sprocess events — no new indexer queries needed.

---

## Status

- ✅ Implemented in pi-simocracy `simocracy_post_proposal` (this repo)
- 🟡 Renderer changes pending in simocracy-v2
- 🟢 Lexicons unchanged — both repos can ship the change independently

The proposal + history pair is being written today. As soon as
simocracy-v2 lands the renderer change, every existing pi-authored
sim proposal retro-actively gets the sim badge — no migration.
