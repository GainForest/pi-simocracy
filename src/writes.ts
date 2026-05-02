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
