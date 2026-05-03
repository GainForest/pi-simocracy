/**
 * Record lookup + comment-thread fetch with sim-attribution join.
 *
 * Powers the `simocracy_lookup_record` tool. One entry point
 * (`lookupRecord`) handles every kind the LLM might want to inspect:
 * sims, proposals, gatherings, decisions, and individual comments.
 *
 * Two indexers are queried (Simocracy + Hyperindexer) plus the
 * owner's PDS for direct AT-URI lookups. Sim-attribution for
 * comments is joined client-side from `org.simocracy.history`
 * records — same pattern simocracy-v2's notifications system uses.
 * See `docs/SIM_AUTHORED_COMMENTS.md` for the full design.
 */

import {
  fetchBlob,
  getRecordFromPds,
  parseAtUri,
  resolveHandle,
  searchSimsByName,
  SIMOCRACY_INDEXER_URL,
} from "./simocracy.ts";

/** Hyperindexer base URL — handles `org.hypercerts.*` and `org.impactindexer.*`. */
const HYPERINDEXER_URL = "https://api.hi.gainforest.app";

const COLLECTION_SIM = "org.simocracy.sim";
const COLLECTION_PROPOSAL = "org.hypercerts.claim.activity";
const COLLECTION_GATHERING = "org.simocracy.gathering";
const COLLECTION_DECISION = "org.simocracy.decision";
const COLLECTION_COMMENT = "org.impactindexer.review.comment";
const COLLECTION_HISTORY = "org.simocracy.history";

export type LookupKind =
  | "sim"
  | "proposal"
  | "gathering"
  | "decision"
  | "comment"
  | "auto";

const COLLECTION_BY_KIND: Record<Exclude<LookupKind, "auto">, string> = {
  sim: COLLECTION_SIM,
  proposal: COLLECTION_PROPOSAL,
  gathering: COLLECTION_GATHERING,
  decision: COLLECTION_DECISION,
  comment: COLLECTION_COMMENT,
};

const KIND_BY_COLLECTION: Record<string, Exclude<LookupKind, "auto">> = {
  [COLLECTION_SIM]: "sim",
  [COLLECTION_PROPOSAL]: "proposal",
  [COLLECTION_GATHERING]: "gathering",
  [COLLECTION_DECISION]: "decision",
  [COLLECTION_COMMENT]: "comment",
};

/** Which indexer hosts which collection. */
function indexerForCollection(collection: string): string {
  if (collection.startsWith("org.simocracy.")) return SIMOCRACY_INDEXER_URL;
  return HYPERINDEXER_URL;
}

interface GraphQLNode {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  collection: string;
  value: Record<string, unknown>;
}

const RECORDS_QUERY = `
  query FetchRecords($collection: String!, $first: Int) {
    records(collection: $collection, first: $first) {
      edges { node { uri cid did rkey collection value } }
    }
  }
`;

async function fetchRecordsFromIndexer(
  collection: string,
  first: number,
): Promise<GraphQLNode[]> {
  const url = `${indexerForCollection(collection).replace(/\/+$/, "")}/graphql`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: RECORDS_QUERY,
      variables: { collection, first },
    }),
  });
  if (!res.ok) throw new Error(`Indexer ${url} returned ${res.status}`);
  const json = (await res.json()) as {
    data?: { records?: { edges?: Array<{ node: GraphQLNode }> } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`Indexer GraphQL error: ${json.errors[0]?.message}`);
  }
  return json.data?.records?.edges?.map((e) => e.node) ?? [];
}

// ---------------------------------------------------------------------------
// Search (by name) — kind-specific entry points
// ---------------------------------------------------------------------------

interface SearchHit {
  kind: Exclude<LookupKind, "auto">;
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  /** Best display name we could pull out of the value blob (varies by kind). */
  name: string;
  shortDescription?: string;
  /** Lower = better match. */
  score: number;
  value: Record<string, unknown>;
}

function scoreNameAgainstQuery(name: string, query: string): number {
  const a = (name || "").toLowerCase().trim();
  const b = query.toLowerCase().trim();
  if (!a) return Number.POSITIVE_INFINITY;
  if (a === b) return 0;
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 1;
  if (a.startsWith(b)) return 2;
  if (a.includes(b)) return 3 + (a.length - b.length);
  const tokens = b.split(/\s+/).filter(Boolean);
  const matched = tokens.filter((t) => a.includes(t)).length;
  if (matched > 0) return 100 - matched;
  return Number.POSITIVE_INFINITY;
}

/** Best-effort display-name extractor across the supported record kinds. */
function nameFromValue(value: Record<string, unknown>): string {
  return (
    (value.name as string) ||
    (value.title as string) ||
    (value.proposalTitle as string) ||
    (value.shortDescription as string) ||
    ""
  );
}

async function searchKind(
  kind: Exclude<LookupKind, "auto">,
  query: string,
  maxResults: number,
): Promise<SearchHit[]> {
  // Sims have a richer search path already (paginated, indexer-aware).
  if (kind === "sim") {
    const matches = await searchSimsByName(query, { maxResults });
    return matches.map((m, i) => ({
      kind: "sim",
      uri: m.uri,
      cid: m.cid,
      did: m.did,
      rkey: m.rkey,
      name: m.sim.name,
      shortDescription:
        ((m.sim as unknown) as { shortDescription?: string }).shortDescription ??
        undefined,
      score: i, // already sorted best-first
      value: m.sim as unknown as Record<string, unknown>,
    }));
  }

  const collection = COLLECTION_BY_KIND[kind];
  const nodes = await fetchRecordsFromIndexer(collection, 500);
  const scored: SearchHit[] = [];
  for (const node of nodes) {
    const name = nameFromValue(node.value);
    const score = scoreNameAgainstQuery(name, query);
    if (!Number.isFinite(score)) continue;
    scored.push({
      kind,
      uri: node.uri,
      cid: node.cid,
      did: node.did,
      rkey: node.rkey,
      name,
      shortDescription: node.value.shortDescription as string | undefined,
      score,
      value: node.value,
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, maxResults);
}

/**
 * Search every supported record kind in parallel. Results are pooled
 * and re-ranked by score across kinds, so the LLM gets the single
 * best match regardless of whether the query hit a sim, a proposal,
 * or a gathering. Used when `kind = "auto"`.
 */
export async function searchAllKinds(
  query: string,
  maxResults: number,
): Promise<SearchHit[]> {
  const kinds: Exclude<LookupKind, "auto">[] = [
    "sim",
    "proposal",
    "gathering",
    "decision",
  ];
  // Comments are intentionally excluded from auto-search — searching by
  // text would need full-text scanning of every comment in the indexer
  // and the LLM should reach for an AT-URI when it already has one.
  const results = await Promise.all(
    kinds.map((k) =>
      searchKind(k, query, maxResults).catch((): SearchHit[] => []),
    ),
  );
  const pooled = results.flat();
  pooled.sort((a, b) => a.score - b.score);
  return pooled.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Comment thread fetch + sim-attribution join
// ---------------------------------------------------------------------------

export interface ResolvedComment {
  uri: string;
  did: string;
  rkey: string;
  text: string;
  createdAt: string;
  /** AT-URI of the parent — the subject this comment was posted under. */
  parentUri: string;
  authorHandle: string | null;
  /** Set when an `org.simocracy.history` sidecar attributes this comment to a sim. */
  simUri?: string;
  simName?: string;
}

interface RawCommentNode {
  uri: string;
  did: string;
  rkey: string;
  value: Record<string, unknown>;
}

interface RawHistoryNode {
  uri: string;
  did: string;
  value: Record<string, unknown>;
}

function extractCommentText(value: Record<string, unknown>): string {
  for (const k of ["text", "body", "content", "message", "comment"] as const) {
    const v = value[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function extractSubjectUri(value: Record<string, unknown>): string | null {
  const subject = value.subject as Record<string, unknown> | string | undefined;
  if (!subject) return null;
  if (typeof subject === "string") return subject;
  const uri = (subject as Record<string, unknown>).uri;
  return typeof uri === "string" ? uri : null;
}

/**
 * Fetch every comment in the subtree rooted at `subjectUri`, then
 * join `org.simocracy.history` sidecar records (type=`comment`,
 * subjectCollection=`org.impactindexer.review.comment`) so each
 * resolved comment carries its sim attribution when one exists.
 *
 * Both queries are capped at the indexer-default page size — the
 * indexer compat layer doesn't filter server-side, so all subject /
 * subtree / sim filtering happens here. This matches the pattern
 * simocracy-v2's notifications code uses (see the
 * `// TODO(scale)` comments there).
 */
export async function fetchCommentSubtree(
  subjectUri: string,
  opts: { maxComments?: number; resolveAuthors?: boolean } = {},
): Promise<ResolvedComment[]> {
  const maxComments = opts.maxComments ?? 1000;
  const resolveAuthors = opts.resolveAuthors ?? true;

  const [allComments, allHistories] = await Promise.all([
    fetchRecordsFromIndexer(COLLECTION_COMMENT, maxComments).catch(
      (): GraphQLNode[] => [],
    ),
    fetchRecordsFromIndexer(COLLECTION_HISTORY, maxComments).catch(
      (): GraphQLNode[] => [],
    ),
  ]);

  // Index comments by parent URI for BFS traversal of the subtree.
  const byParent = new Map<string, RawCommentNode[]>();
  for (const r of allComments) {
    const parent = extractSubjectUri(r.value);
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push(r);
    byParent.set(parent, list);
  }

  // BFS — collect every descendant comment of `subjectUri`.
  const matched: { node: RawCommentNode; parentUri: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [subjectUri];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.uri)) continue;
      seen.add(child.uri);
      matched.push({ node: child, parentUri: parent });
      queue.push(child.uri);
    }
  }

  // Build the comment-URI → sim-attribution index from history records.
  const simByCommentUri = new Map<string, { simUri: string; simName: string }>();
  for (const h of allHistories) {
    const v = h.value as RawHistoryNode["value"];
    if (v.type !== "comment") continue;
    if (v.subjectCollection !== COLLECTION_COMMENT) continue;
    const cu = v.subjectUri;
    if (typeof cu !== "string") continue;
    const simUris = Array.isArray(v.simUris) ? (v.simUris as string[]) : [];
    const simNames = Array.isArray(v.simNames) ? (v.simNames as string[]) : [];
    if (!simUris[0]) continue;
    simByCommentUri.set(cu, {
      simUri: simUris[0],
      simName: simNames[0] || "(unnamed sim)",
    });
  }

  // Resolve author handles in parallel (best-effort, deduped by DID).
  const handleByDid = new Map<string, string | null>();
  if (resolveAuthors) {
    const dids = Array.from(new Set(matched.map((m) => m.node.did)));
    await Promise.all(
      dids.map(async (did) => {
        const h = await resolveHandle(did).catch(() => null);
        handleByDid.set(did, h);
      }),
    );
  }

  return matched
    .map(({ node, parentUri }) => {
      const sim = simByCommentUri.get(node.uri);
      const text = extractCommentText(node.value);
      const out: ResolvedComment = {
        uri: node.uri,
        did: node.did,
        rkey: node.rkey,
        text,
        createdAt: (node.value.createdAt as string) || "",
        parentUri,
        authorHandle: handleByDid.get(node.did) ?? null,
      };
      if (sim) {
        out.simUri = sim.simUri;
        out.simName = sim.simName;
      }
      return out;
    })
    .filter((c) => c.text.length > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------
// Single-record lookup (AT-URI or name)
// ---------------------------------------------------------------------------

export interface LookupResult {
  kind: Exclude<LookupKind, "auto"> | "unknown";
  uri: string;
  did: string;
  rkey: string;
  collection: string;
  /** Best display name we could pull out of the value blob. */
  name: string;
  /** Raw record value as returned by the PDS / indexer. */
  value: Record<string, unknown>;
  /** Resolved owner handle (best-effort). */
  ownerHandle: string | null;
  /** Comment subtree for proposals / gatherings / sims / decisions / comments. */
  comments?: ResolvedComment[];
  /** When the result *is* a comment, the parent record (best-effort fetch). */
  parent?: {
    uri: string;
    collection: string;
    name: string;
    value?: Record<string, unknown>;
  };
  /** When the result *is* a comment with a sim-attribution sidecar. */
  attribution?: { simUri: string; simName: string };
}

/**
 * Best-effort title for a record value, varying by kind. Used both for
 * the human-readable `name` field on `LookupResult` and for the
 * `proposalTitle` / `subjectName` fields of any sim-attribution
 * sidecars we end up writing.
 */
export function bestNameForRecord(
  collection: string,
  value: Record<string, unknown>,
): string {
  if (collection === COLLECTION_COMMENT) {
    const text = extractCommentText(value);
    return text.length > 80 ? text.slice(0, 77) + "…" : text;
  }
  return nameFromValue(value);
}

/** Direct AT-URI lookup against the owner's PDS (no indexer round-trip). */
async function lookupByUri(
  uri: string,
  opts: { withComments?: boolean },
): Promise<LookupResult> {
  const { did, collection, rkey } = parseAtUri(uri);
  const value = await getRecordFromPds<Record<string, unknown>>(
    did,
    collection,
    rkey,
  );
  const ownerHandle = await resolveHandle(did).catch(() => null);
  const kind = KIND_BY_COLLECTION[collection] ?? "unknown";

  const result: LookupResult = {
    kind,
    uri,
    did,
    rkey,
    collection,
    name: bestNameForRecord(collection, value),
    value,
    ownerHandle,
  };

  // For everything that isn't a comment, fetch the subtree of replies.
  if (opts.withComments && collection !== COLLECTION_COMMENT) {
    result.comments = await fetchCommentSubtree(uri, { maxComments: 1000 }).catch(
      (): ResolvedComment[] => [],
    );
  }

  // For a comment, fetch the parent (the record being commented on) and any
  // sim-attribution sidecar pointing at this comment.
  if (collection === COLLECTION_COMMENT) {
    const parentUri = extractSubjectUri(value);
    if (parentUri) {
      try {
        const parsed = parseAtUri(parentUri);
        const parentValue = await getRecordFromPds<Record<string, unknown>>(
          parsed.did,
          parsed.collection,
          parsed.rkey,
        ).catch(() => undefined);
        result.parent = {
          uri: parentUri,
          collection: parsed.collection,
          name: parentValue
            ? bestNameForRecord(parsed.collection, parentValue)
            : "",
          value: parentValue,
        };
      } catch {
        // Parent URI didn't parse — leave parent unset.
      }
    }
    // Best-effort sim-attribution lookup. Pull all history records and find
    // the one whose subjectUri matches this comment.
    const histories = await fetchRecordsFromIndexer(
      COLLECTION_HISTORY,
      1000,
    ).catch((): GraphQLNode[] => []);
    for (const h of histories) {
      const v = h.value;
      if (v.type !== "comment") continue;
      if (v.subjectCollection !== COLLECTION_COMMENT) continue;
      if (v.subjectUri !== uri) continue;
      const simUris = Array.isArray(v.simUris) ? (v.simUris as string[]) : [];
      const simNames = Array.isArray(v.simNames) ? (v.simNames as string[]) : [];
      if (!simUris[0]) continue;
      result.attribution = {
        simUri: simUris[0],
        simName: simNames[0] || "(unnamed sim)",
      };
      break;
    }
  }
  return result;
}

/**
 * Look up a record by AT-URI or by fuzzy name. The `kind` filter
 * narrows which collection(s) the indexer searches; `auto` searches
 * sims + proposals + gatherings + decisions in parallel and returns
 * the highest-scoring match across all kinds.
 *
 * Always fetches the comment subtree (capped) and joins
 * `org.simocracy.history` sidecars so each comment carries its sim
 * attribution. See `docs/SIM_AUTHORED_COMMENTS.md` for the design.
 */
export async function lookupRecord(
  query: string,
  opts: { kind?: LookupKind; withComments?: boolean } = {},
): Promise<{ result: LookupResult | null; alternatives: SearchHit[] }> {
  const kind = opts.kind ?? "auto";
  const withComments = opts.withComments ?? true;
  const trimmed = query.trim();
  if (!trimmed) return { result: null, alternatives: [] };

  if (trimmed.startsWith("at://")) {
    const result = await lookupByUri(trimmed, { withComments });
    return { result, alternatives: [] };
  }

  const hits =
    kind === "auto"
      ? await searchAllKinds(trimmed, 8)
      : await searchKind(kind, trimmed, 8);

  if (hits.length === 0) return { result: null, alternatives: [] };
  const top = hits[0];
  const result = await lookupByUri(top.uri, { withComments });
  return { result, alternatives: hits.slice(1) };
}

// Re-export types other modules need.
export type { GraphQLNode };
export { fetchBlob };
