/**
 * PDS writes via the authenticated OAuth session.
 *
 * Three record types are written here:
 *   - org.simocracy.interview  (one per Apply, append-only)
 *   - org.simocracy.agents     (1:1 with sim — create or update)
 *   - org.simocracy.style      (1:1 with sim — create or update)
 *
 * `getAuthenticatedAgent()` restores the session via the OAuth
 * client's session store and returns an `Agent` from `@atproto/api`,
 * which exposes the same `com.atproto.repo.*` XRPC methods we'd use
 * with an app-password agent.
 */

import { Agent } from "@atproto/api";

import { getOAuthClient } from "./auth/oauth.ts";
import { readAuth } from "./auth/storage.ts";

export class NotSignedInError extends Error {
  constructor(message = "Not signed into ATProto. Run `/sim login <handle>` first (e.g. `/sim login alice.bsky.social`). This is separate from pi's built-in `/login` (Anthropic).") {
    super(message);
    this.name = "NotSignedInError";
  }
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

const COLLECTION_INTERVIEW = "org.simocracy.interview";
const COLLECTION_AGENTS = "org.simocracy.agents";
const COLLECTION_STYLE = "org.simocracy.style";

interface OpenAnswer {
  questionId?: string;
  question: string;
  answer: string;
}
interface YesNoAnswer {
  questionId?: string;
  statement: string;
  answer: boolean;
}

/**
 * POST `org.simocracy.interview`. Mirrors `interview-modal.tsx`'s
 * save payload — with optional template StrongRef.
 */
export async function createInterview(opts: {
  agent: Agent;
  did: string;
  simUri: string;
  simCid: string;
  openAnswers: OpenAnswer[];
  yesNoAnswers: YesNoAnswer[];
  templateUri?: string;
  templateCid?: string;
}): Promise<{ uri: string; cid: string }> {
  const record: Record<string, unknown> = {
    $type: COLLECTION_INTERVIEW,
    sim: { uri: opts.simUri, cid: opts.simCid },
    openAnswers: opts.openAnswers.map((a) => ({
      questionId: a.questionId,
      question: a.question,
      answer: a.answer,
    })),
    yesNoAnswers: opts.yesNoAnswers.map((a) => ({
      questionId: a.questionId,
      statement: a.statement,
      answer: a.answer,
    })),
    createdAt: new Date().toISOString(),
  };
  if (opts.templateUri && opts.templateCid) {
    record.template = { uri: opts.templateUri, cid: opts.templateCid };
  }

  const res = await opts.agent.com.atproto.repo.createRecord({
    repo: opts.did,
    collection: COLLECTION_INTERVIEW,
    record,
  });
  return { uri: res.data.uri, cid: res.data.cid };
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
