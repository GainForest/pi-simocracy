/**
 * PDS writes via the authenticated OAuth session.
 *
 * Two record types are written here, both 1:1 with a sim and either
 * created (first time) or put-overwritten (subsequent edits):
 *   - org.simocracy.agents  — short description + constitution body
 *   - org.simocracy.style   — speaking style description
 *
 * The questionnaire-driven `org.simocracy.interview` write path was
 * removed when the structured Training Lab + Interview flows were
 * dropped from this extension; constitution edits are now made
 * directly via `simocracy_update_sim` (an LLM-callable tool the
 * coding agent invokes after chatting with the user about how to
 * refine the loaded sim).
 *
 * `getAuthenticatedAgent()` restores the session via the OAuth
 * client's session store and returns an `Agent` from `@atproto/api`,
 * which exposes the same `com.atproto.repo.*` XRPC methods we'd use
 * with an app-password agent.
 */

import { Agent } from "@atproto/api";

import { getOAuthClient } from "./auth/oauth.ts";
import { readAuth, type AuthRecord } from "./auth/storage.ts";
import { resolveHandle } from "./simocracy.ts";

export class NotSignedInError extends Error {
  constructor(message = "Not signed into ATProto. Run `/sim login <handle>` first (e.g. `/sim login alice.bsky.social`). This is separate from pi's built-in `/login` (Anthropic).") {
    super(message);
    this.name = "NotSignedInError";
  }
}

/**
 * Thrown when the signed-in DID does not own the sim that's about to
 * be written to. The `simocracy.org` webapp owns the public lexicon
 * surface, but per-sim records (`org.simocracy.agents`,
 * `org.simocracy.style`) live in the *owner's* PDS — there's no
 * shared repo. Without this guard a signed-in user could only ever
 * write to their own repo anyway (the PDS rejects writes to other
 * DIDs), but the failure would surface as a confusing XRPC 401 from
 * the PDS at the moment of the call. This class lets the
 * `simocracy_update_sim` tool fail fast with a human-readable
 * message *before* it touches the network.
 */
export class NotSimOwnerError extends Error {
  readonly ownerDid: string;
  readonly ownerHandle: string | null;
  readonly signedInDid: string;
  readonly signedInHandle: string | null;
  constructor(opts: {
    ownerDid: string;
    ownerHandle: string | null;
    signedInDid: string;
    signedInHandle: string | null;
    action?: string;
  }) {
    const ownerLabel = opts.ownerHandle ? `@${opts.ownerHandle}` : opts.ownerDid;
    const meLabel = opts.signedInHandle ? `@${opts.signedInHandle}` : opts.signedInDid;
    const action = opts.action ?? "write to";
    super(
      `You can only ${action} sims you own. Loaded sim is owned by ${ownerLabel} — your signed-in DID is ${meLabel}.`,
    );
    this.name = "NotSimOwnerError";
    this.ownerDid = opts.ownerDid;
    this.ownerHandle = opts.ownerHandle;
    this.signedInDid = opts.signedInDid;
    this.signedInHandle = opts.signedInHandle;
  }
}

/**
 * Precondition for the write path: must be signed in *and* the
 * signed-in DID must match the loaded sim's owner DID. Resolves the
 * sim owner's handle on a best-effort basis so the error message is
 * legible. Throws `NotSignedInError` or `NotSimOwnerError` — never
 * returns falsy. Called by `simocracy_update_sim` (the tool entry
 * point) before any XRPC traffic, and again at each call site in
 * this module as defense-in-depth via `assertRepoOwnsSimUri`.
 */
export async function assertCanWriteToSim(loadedSim: {
  did: string;
  handle: string | null;
}, opts: { action?: string } = {}): Promise<AuthRecord> {
  const auth = readAuth();
  if (!auth) {
    const action = opts.action ?? "write to a sim";
    throw new NotSignedInError(
      `Not signed into ATProto — can't ${action}. Run \`/sim login <handle>\` first (e.g. \`/sim login alice.bsky.social\`). This is separate from pi's built-in \`/login\` (Anthropic).`,
    );
  }
  if (auth.did !== loadedSim.did) {
    const ownerHandle =
      loadedSim.handle ?? (await resolveHandle(loadedSim.did).catch(() => null));
    throw new NotSimOwnerError({
      ownerDid: loadedSim.did,
      ownerHandle,
      signedInDid: auth.did,
      signedInHandle: auth.handle,
      action: opts.action,
    });
  }
  return auth;
}

export async function getAuthenticatedAgent(): Promise<{ agent: Agent; did: string }> {
  const auth = readAuth();
  if (!auth) throw new NotSignedInError();
  const client = getOAuthClient();
  // refresh="auto" — the OAuth client refreshes the access token if
  // it's about to expire and persists the new tokens via the session
  // store. If refresh fails (e.g. revoked, expired refresh token),
  // restore() throws; we surface it as a NotSignedInError so callers
  // get a consistent shape.
  let oauthSession;
  try {
    oauthSession = await client.restore(auth.did);
  } catch (err) {
    throw new NotSignedInError(
      `Stored ATProto session for ${auth.did} could not be restored — please run /sim login again. (${(err as Error).message})`,
    );
  }
  const agent = new Agent(oauthSession);
  return { agent, did: auth.did };
}

const COLLECTION_AGENTS = "org.simocracy.agents";
const COLLECTION_STYLE = "org.simocracy.style";
const COLLECTION_COMMENT = "org.impactindexer.review.comment";
const COLLECTION_HISTORY = "org.simocracy.history";
const COLLECTION_PROPOSAL = "org.hypercerts.claim.activity";
const COLLECTION_PROPOSAL_CONTEXT = "org.simocracy.proposalContext";
const COLLECTION_SKILL = "org.simocracy.skill";

/**
 * Defense-in-depth: every write helper below verifies the target
 * `repo` (which we always set to the signed-in DID) matches the
 * sim's owner DID parsed out of the AT-URI. This prevents a future
 * caller from accidentally passing the wrong `did` and writing
 * orphaned per-sim records into the user's own repo that point at a
 * sim they don't own. Throws `NotSimOwnerError` synchronously — the
 * tool entry-point already checks up-front via
 * `assertCanWriteToSim`, this is the belt-and-braces version that
 * runs at the actual XRPC call site.
 */
function assertRepoOwnsSimUri(did: string, simUri: string): void {
  // simUri is at://<owner-did>/org.simocracy.sim/<rkey>; if the
  // string didn't come from parseAtUri we still fall back to a string
  // prefix check so this stays a pure precondition without re-fetching.
  const owner = simUri.startsWith("at://")
    ? simUri.slice("at://".length).split("/")[0]
    : "";
  if (!owner) {
    throw new Error(
      `Refusing to write: sim AT-URI "${simUri}" is not in at://<did>/<collection>/<rkey> form.`,
    );
  }
  if (owner !== did) {
    throw new NotSimOwnerError({
      ownerDid: owner,
      ownerHandle: null,
      signedInDid: did,
      signedInHandle: null,
    });
  }
}

/**
 * POST `org.simocracy.agents` (constitution + short description).
 * Plain text only — no facets in PR 3 to keep dep count down. The web
 * app keeps the markdown variant as a follow-up; readers handle a
 * facet-less record fine since the lexicon's `descriptionFacets` is
 * optional.
 */
export async function createAgents(opts: {
  agent: Agent;
  did: string;
  simUri: string;
  simCid: string;
  shortDescription: string;
  description: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const record = {
    $type: COLLECTION_AGENTS,
    sim: { uri: opts.simUri, cid: opts.simCid },
    shortDescription: opts.shortDescription.slice(0, 300),
    description: opts.description,
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_AGENTS,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * PUT `org.simocracy.agents` at a known rkey. Used when the sim
 * already has an agents record we want to overwrite.
 */
export async function updateAgents(opts: {
  agent: Agent;
  did: string;
  rkey: string;
  simUri: string;
  simCid: string;
  shortDescription: string;
  description: string;
}): Promise<{ uri: string; cid: string }> {
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const record = {
    $type: COLLECTION_AGENTS,
    sim: { uri: opts.simUri, cid: opts.simCid },
    shortDescription: opts.shortDescription.slice(0, 300),
    description: opts.description,
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.putRecord({
    repo: opts.did,
    collection: COLLECTION_AGENTS,
    rkey: opts.rkey,
    record,
  });
  return { uri: res.data.uri, cid: res.data.cid };
}

export async function createStyle(opts: {
  agent: Agent;
  did: string;
  simUri: string;
  simCid: string;
  description: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const record = {
    $type: COLLECTION_STYLE,
    sim: { uri: opts.simUri, cid: opts.simCid },
    description: opts.description,
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_STYLE,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

export async function updateStyle(opts: {
  agent: Agent;
  did: string;
  rkey: string;
  simUri: string;
  simCid: string;
  description: string;
}): Promise<{ uri: string; cid: string }> {
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const record = {
    $type: COLLECTION_STYLE,
    sim: { uri: opts.simUri, cid: opts.simCid },
    description: opts.description,
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.putRecord({
    repo: opts.did,
    collection: COLLECTION_STYLE,
    rkey: opts.rkey,
    record,
  });
  return { uri: res.data.uri, cid: res.data.cid };
}

/**
 * POST `org.impactindexer.review.comment`.
 *
 * Matches the wire shape simocracy.org's `useRecordComments.postComment`
 * already writes today (`subject = { uri, type: 'record' }`, no CID), so
 * comments authored from pi render identically in the webapp and thread
 * correctly under the same parent. The `subject.uri` is the parent
 * record — proposal, gathering, sim, decision, or another comment for
 * a nested reply.
 *
 * No sim-attribution lives in this record. Sim attribution is a
 * sidecar `org.simocracy.history` written by `createCommentHistory`
 * below — see `docs/SIM_AUTHORED_COMMENTS.md` for the full design.
 */
export async function createComment(opts: {
  agent: Agent;
  did: string;
  subjectUri: string;
  text: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  const trimmed = opts.text.trim();
  if (!trimmed) {
    throw new Error("Cannot post an empty comment.");
  }
  const record = {
    $type: COLLECTION_COMMENT,
    subject: { uri: opts.subjectUri, type: "record" },
    text: trimmed.slice(0, 5000),
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_COMMENT,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * Sim-attribution sidecar for a comment.
 *
 * The `org.impactindexer.review.comment` lexicon has no field for
 * "this comment is the voice of sim X" — and we don't want to extend
 * an impactindexer-owned lexicon for a Simocracy-specific concept.
 * Instead we use Simocracy's existing `org.simocracy.history`
 * lexicon as a join table:
 *
 *   commentUri  ←—  history.subjectUri
 *   loaded sim  ←—  history.simUris[0] / simNames[0]
 *
 * Renderers that understand this pattern (simocracy.org) join the two
 * sets at display time and show the comment with a sim badge;
 * renderers that don't (Bluesky AppView, third-party clients) fall
 * back to displaying the comment as a regular user comment — graceful
 * degradation, zero lexicon changes anywhere.
 *
 * Writes to the *user's* own PDS (the comment author), not a shared
 * facilitator repo, because the attribution is an event the user
 * triggered and naturally belongs in their history.
 */
export async function createCommentHistory(opts: {
  agent: Agent;
  did: string;
  commentUri: string;
  simUri: string;
  simName: string;
  text: string;
  /** Title of the parent record (proposal / gathering / sim) — best-effort. */
  proposalTitle?: string;
  /** Collection of the parent record — best-effort. */
  parentCollection?: string;
  /** Human-readable name of the parent — best-effort, denormalized for the timeline. */
  parentName?: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  // Defense-in-depth: the sim must live in the same repo we're writing to.
  // (If it doesn't, the indexer ingests a history record claiming attribution
  // for a sim the actor doesn't own — confusing rather than dangerous, but
  // worth catching here.)
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const record: Record<string, unknown> = {
    $type: COLLECTION_HISTORY,
    type: "comment",
    actorDid: opts.did,
    simNames: [opts.simName].slice(0, 10),
    simUris: [opts.simUri].slice(0, 10),
    subjectUri: opts.commentUri,
    subjectCollection: COLLECTION_COMMENT,
    content: opts.text.slice(0, 5000),
    createdAt: new Date().toISOString(),
  };
  if (opts.proposalTitle) {
    record.proposalTitle = opts.proposalTitle.slice(0, 500);
  }
  if (opts.parentName) {
    record.subjectName = opts.parentName.slice(0, 500);
  }
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_HISTORY,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * POST `org.hypercerts.claim.activity` (a funding proposal).
 *
 * Matches the wire shape simocracy.org's `ProposalFormDialog` writes
 * today (`title`, `shortDescription`, optional `description` /
 * `workScope` / `contributors` / `image`, `createdAt`), so proposals
 * authored from pi render identically in the webapp.
 *
 * No sim-attribution lives in this record. Sim attribution is a
 * sidecar `org.simocracy.history` written by `createProposalHistory`
 * below — same pattern as comments, see
 * `docs/SIM_AUTHORED_PROPOSALS.md` for the design rationale.
 *
 * The proposal itself is the *user's*, not the sim's, so this writer
 * does NOT call `assertRepoOwnsSimUri` — the only precondition is
 * that the user is signed in (enforced at the tool entry point via
 * `assertCanWriteToSim`, which also requires a loaded sim because
 * attribution requires one).
 */
export async function createProposal(opts: {
  agent: Agent;
  did: string;
  title: string;
  shortDescription: string;
  description?: string;
  workScope?: string;
  contributors?: Array<{ contributorIdentity: string }>;
  image?: { $type: "org.hypercerts.defs#uri"; uri: string };
}): Promise<{ uri: string; cid: string; rkey: string }> {
  const title = opts.title.trim();
  if (!title) throw new Error("Proposal title is required.");
  const shortDescription = opts.shortDescription.trim();
  if (!shortDescription)
    throw new Error("Proposal shortDescription is required.");
  const record: Record<string, unknown> = {
    $type: COLLECTION_PROPOSAL,
    title: title.slice(0, 256),
    shortDescription: shortDescription.slice(0, 300),
    createdAt: new Date().toISOString(),
  };
  // `description` and `workScope` are UNION types in the
  // org.hypercerts.claim.activity lexicon — they MUST be wrapped objects
  // with a `$type` discriminator. Plain strings are rejected by lex-gql
  // (silently drops the record from the indexer). Same applies to each
  // `contributorIdentity` (also a union).
  if (opts.description !== undefined) {
    const body = opts.description.trim();
    if (body) {
      record.description = {
        $type: "org.hypercerts.defs#descriptionString",
        value: body,
      };
    }
  }
  if (opts.workScope !== undefined) {
    const ws = opts.workScope.trim();
    if (ws) {
      record.workScope = {
        $type: "org.hypercerts.claim.activity#workScopeString",
        scope: ws,
      };
    }
  }
  if (opts.contributors && opts.contributors.length > 0) {
    record.contributors = opts.contributors.map((c) => ({
      contributorIdentity: {
        $type: "org.hypercerts.claim.activity#contributorIdentity",
        identity: c.contributorIdentity,
      },
    }));
  }
  if (opts.image) record.image = opts.image;
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_PROPOSAL,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * Discriminated parent target for an `org.simocracy.proposalContext`
 * sidecar. Mirrors the lexicon's `context` union (#gatheringContext
 * vs #ftcSfContext); see `simocracy-v2/lexicons/org/simocracy/proposalContext.json`.
 */
export type ProposalContextTarget =
  | { kind: "gathering"; uri: string; cid: string }
  | { kind: "ftc-sf"; floorNumber: number };

/**
 * POST `org.simocracy.proposalContext` (parent-context sidecar).
 *
 * Binds a proposal to its parent container — either an
 * `org.simocracy.gathering` record (via StrongRef) or a static FtC SF
 * floor number. Without this sidecar, simocracy.org's read paths
 * (post-Phase-5) won't surface the proposal on `/proposals` or under
 * the gathering / floor it belongs to. The sidecar is therefore
 * effectively required for any proposal submitted via this tool.
 *
 * Same trust model as `org.simocracy.history` — lives in the
 * proposer's own PDS so the resolver's tier-1 (proposer-PDS) >
 * tier-2 (facilitator-PDS) precedence rule lets a backfill record
 * be silently superseded if the proposer ever re-saves.
 *
 * No sim-ownership precondition: a proposal isn't sim-owned, and
 * the sidecar references the proposal + parent gathering, not the
 * sim. The OAuth precondition ($DID matches signed-in DID and the
 * agent is authenticated) is enforced upstream by
 * `assertCanWriteToSim` at the tool entry point.
 */
export async function createProposalContext(opts: {
  agent: Agent;
  did: string;
  proposalUri: string;
  proposalCid: string;
  context: ProposalContextTarget;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  let context: Record<string, unknown>;
  if (opts.context.kind === "gathering") {
    if (!opts.context.uri || !opts.context.cid) {
      throw new Error(
        "Gathering parent context requires both uri and cid (a full StrongRef).",
      );
    }
    context = {
      $type: `${COLLECTION_PROPOSAL_CONTEXT}#gatheringContext`,
      gathering: { uri: opts.context.uri, cid: opts.context.cid },
    };
  } else {
    if (
      !Number.isInteger(opts.context.floorNumber) ||
      opts.context.floorNumber < 1
    ) {
      throw new Error(
        `FtC SF floor number must be a positive integer (got ${opts.context.floorNumber}).`,
      );
    }
    context = {
      $type: `${COLLECTION_PROPOSAL_CONTEXT}#ftcSfContext`,
      floorNumber: opts.context.floorNumber,
    };
  }
  const record = {
    $type: COLLECTION_PROPOSAL_CONTEXT,
    subject: { uri: opts.proposalUri, cid: opts.proposalCid },
    context,
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_PROPOSAL_CONTEXT,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * Sim-attribution sidecar for a proposal.
 *
 * Mirrors `createCommentHistory` exactly — same `org.simocracy.history`
 * lexicon, same join key shape, just `type: "proposal"` and
 * `subjectCollection: "org.hypercerts.claim.activity"`. The lexicon's
 * `type` field is free-form string; the webapp doesn't filter
 * histories by `type === "proposal"` today, but adding a new value is
 * fine (history.json already documents that new event types are
 * appended over time).
 *
 * Writes to the *user's* own PDS, not a shared facilitator repo —
 * the attribution is an event the user triggered and naturally
 * belongs in their history.
 */
export async function createProposalHistory(opts: {
  agent: Agent;
  did: string;
  proposalUri: string;
  proposalTitle: string;
  simUri: string;
  simName: string;
  /** Plain-text description, denormalized for the timeline (truncated to ~5000 chars). */
  content?: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  // Defense-in-depth: the sim must live in the same repo we're writing to.
  // The proposal record itself isn't sim-owned, but the history sidecar
  // *claims attribution to* a sim — only the sim's owner can make that claim.
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const title = opts.proposalTitle.trim();
  const record: Record<string, unknown> = {
    $type: COLLECTION_HISTORY,
    type: "proposal",
    actorDid: opts.did,
    simNames: [opts.simName].slice(0, 10),
    simUris: [opts.simUri].slice(0, 10),
    subjectUri: opts.proposalUri,
    subjectCollection: COLLECTION_PROPOSAL,
    subjectName: title.slice(0, 500),
    proposalTitle: title.slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  if (opts.content) {
    const trimmed = opts.content.trim();
    if (trimmed) record.content = trimmed.slice(0, 5000);
  }
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_HISTORY,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * POST `org.simocracy.skill` (an Anthropic-style agent skill).
 *
 * The lexicon stores the SKILL.md frontmatter (`name`, `description`)
 * as separate fields and the markdown body in `body`, so the indexer
 * can filter on metadata cheaply without parsing markdown. The full
 * SKILL.md is reconstructed at serve time by simocracy.org's
 * `/skills/[did]/[rkey]/skill.md` route.
 *
 * Skills are NOT 1:1 with sims — the lexicon has no `sim` ref. They
 * live in the *user's* own PDS exactly the way simocracy.org's
 * `SkillFormDialog` writes them today, so a sim-authored skill
 * renders identically to a human-authored skill on the gallery.
 * Sim attribution is a sidecar `org.simocracy.history` record
 * written by `createSkillHistory` below — same pattern as comments
 * and proposals. See `docs/SIM_AUTHORED_SKILLS.md` for the design.
 */
export async function createSkill(opts: {
  agent: Agent;
  did: string;
  name: string;
  description: string;
  body: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  const name = opts.name.trim();
  if (!name) throw new Error("Skill name is required.");
  const description = opts.description.trim();
  if (!description) throw new Error("Skill description is required.");
  const body = opts.body.trim();
  if (!body) throw new Error("Skill body is required.");
  // Lexicon caps (mirrored from lexicons/org/simocracy/skill.json):
  //   name        ≤ 100 graphemes (maxLength 1000)
  //   description ≤ 1024 graphemes (maxLength 10000)
  //   body        ≤ 50000 graphemes (maxLength 500000)
  // Slice on JS string length is a conservative approximation of grapheme
  // count — it never exceeds the limit, occasionally trims early on rare
  // multi-codepoint clusters. Same approach used elsewhere in this module.
  const record = {
    $type: COLLECTION_SKILL,
    name: name.slice(0, 1000),
    description: description.slice(0, 10000),
    body: body.slice(0, 500000),
    createdAt: new Date().toISOString(),
  };
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_SKILL,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * Sim-attribution sidecar for a skill.
 *
 * Mirrors `createCommentHistory` and `createProposalHistory` exactly —
 * same `org.simocracy.history` lexicon, same join-key shape, just
 * `type: "skill"` and `subjectCollection: "org.simocracy.skill"`.
 * The lexicon's `type` field is free-form string and the indexer
 * already accepts new event types as they appear (history.json
 * documents this explicitly).
 *
 * Writes to the *user's* own PDS — the attribution is an event the
 * user triggered and naturally belongs in their history.
 */
export async function createSkillHistory(opts: {
  agent: Agent;
  did: string;
  skillUri: string;
  skillName: string;
  skillDescription: string;
  simUri: string;
  simName: string;
}): Promise<{ uri: string; cid: string; rkey: string }> {
  // Defense-in-depth: the sim must live in the same repo we're writing
  // to. The skill record itself isn't sim-owned, but the history
  // sidecar *claims attribution to* a sim — only the sim's owner can
  // make that claim.
  assertRepoOwnsSimUri(opts.did, opts.simUri);
  const skillName = opts.skillName.trim();
  const description = opts.skillDescription.trim();
  const record: Record<string, unknown> = {
    $type: COLLECTION_HISTORY,
    type: "skill",
    actorDid: opts.did,
    simNames: [opts.simName].slice(0, 10),
    simUris: [opts.simUri].slice(0, 10),
    subjectUri: opts.skillUri,
    subjectCollection: COLLECTION_SKILL,
    subjectName: skillName.slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  if (description) {
    record.content = description.slice(0, 5000);
  }
  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_HISTORY,
    record,
  });
  return {
    uri: res.data.uri,
    cid: res.data.cid,
    rkey: res.data.uri.split("/").pop() ?? "",
  };
}

/**
 * Best-effort lookup of an existing rkey by listing the collection
 * and finding the record whose `sim.uri` matches. Used by the Apply
 * paths to decide between create vs update.
 */
export async function findRkeyForSim(
  agent: Agent,
  did: string,
  collection: string,
  simUri: string,
): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection,
      limit: 100,
      cursor,
    });
    for (const rec of res.data.records) {
      const value = rec.value as { sim?: { uri?: string } };
      if (value?.sim?.uri === simUri) {
        const rkey = rec.uri.split("/").pop();
        if (rkey) return rkey;
      }
    }
    cursor = res.data.cursor;
    if (!cursor) break;
  }
  return null;
}
