/**
 * Simocracy indexer + PDS client (read-only).
 *
 * - Searches sims by name on the Simocracy GraphQL indexer.
 * - Falls back to the user's PDS if a record isn't reachable through the indexer.
 * - Resolves blob URLs through the owning DID's PDS.
 */

const DEFAULT_INDEXER_URL = "https://simocracy-indexer-production.up.railway.app";
const COLLECTION_SIM = "org.simocracy.sim";
const COLLECTION_AGENTS = "org.simocracy.agents";
const COLLECTION_STYLE = "org.simocracy.style";

export interface SpriteSettings {
  selectedOptions: Record<string, string>;
  partColorSettings?: Record<string, { red: number; green: number; blue: number; alpha: number }>;
  currentAnimDirection?: number;
  characterSet?: string;
}

export interface BlobRef {
  ref: { $link: string } | unknown;
  mimeType: string;
  size: number;
}

export interface SimRecord {
  $type: "org.simocracy.sim";
  name: string;
  settings: SpriteSettings;
  image?: BlobRef;
  sprite?: BlobRef;
  createdAt: string;
}

export interface AgentsRecord {
  $type: "org.simocracy.agents";
  sim: { uri: string; cid: string };
  shortDescription: string;
  description?: string;
  createdAt: string;
}

export interface StyleRecord {
  $type?: "org.simocracy.style";
  sim: { uri: string; cid: string };
  description: string;
  createdAt: string;
}

export interface SimMatch {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  sim: SimRecord;
}

interface GraphQLNode {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  collection: string;
  value: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const RECORDS_QUERY = `
  query FetchRecords($collection: String!, $first: Int, $after: String) {
    records(collection: $collection, first: $first, after: $after) {
      edges {
        node { uri cid did rkey collection value }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchRecords(
  collection: string,
  first: number,
  cursor: string | null,
  indexerUrl: string,
): Promise<{ nodes: GraphQLNode[]; hasNextPage: boolean; endCursor?: string }> {
  const res = await fetch(`${indexerUrl.replace(/\/+$/, "")}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: RECORDS_QUERY,
      variables: { collection, first, after: cursor },
    }),
  });
  if (!res.ok) {
    throw new Error(`Indexer returned ${res.status} for ${collection}`);
  }
  const json = (await res.json()) as GraphQLResponse<{
    records: {
      edges: Array<{ node: GraphQLNode }>;
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>;
  if (json.errors?.length) {
    throw new Error(`Indexer GraphQL error: ${json.errors[0]?.message ?? "unknown"}`);
  }
  return {
    nodes: json.data?.records.edges.map((e) => e.node) ?? [],
    hasNextPage: json.data?.records.pageInfo.hasNextPage ?? false,
    endCursor: json.data?.records.pageInfo.endCursor,
  };
}

/** Score a sim against a query for ranking match quality. Lower = better match. */
function scoreSimAgainstQuery(simName: string, query: string): number {
  const a = simName.toLowerCase().trim();
  const b = query.toLowerCase().trim();
  if (a === b) return 0;
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 1; // ignore whitespace
  if (a.startsWith(b)) return 2;
  if (a.includes(b)) return 3 + (a.length - b.length); // shorter wraps win
  // Token overlap: each query token found inside sim name reduces score
  const queryTokens = b.split(/\s+/).filter(Boolean);
  const matched = queryTokens.filter((t) => a.includes(t)).length;
  if (matched > 0) return 100 - matched;
  return Number.POSITIVE_INFINITY;
}

/**
 * Search the indexer for sims whose name matches the query.
 * Returns up to `maxResults` matches sorted by match quality.
 */
export async function searchSimsByName(
  query: string,
  opts: { indexerUrl?: string; maxResults?: number; pageSize?: number } = {},
): Promise<SimMatch[]> {
  const indexerUrl = opts.indexerUrl ?? DEFAULT_INDEXER_URL;
  const maxResults = opts.maxResults ?? 10;
  const pageSize = opts.pageSize ?? 200;

  const matches: Array<SimMatch & { score: number }> = [];
  let cursor: string | null = null;
  // Cap pages — the indexer holds at most a few hundred sims today.
  for (let page = 0; page < 10; page++) {
    const { nodes, hasNextPage, endCursor } = await fetchRecords(
      COLLECTION_SIM,
      pageSize,
      cursor,
      indexerUrl,
    );
    for (const node of nodes) {
      const sim = node.value as unknown as SimRecord;
      if (!sim?.name) continue;
      const score = scoreSimAgainstQuery(sim.name, query);
      if (Number.isFinite(score)) {
        matches.push({
          uri: node.uri,
          cid: node.cid,
          did: node.did,
          rkey: node.rkey,
          sim,
          score,
        });
      }
    }
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, maxResults).map(({ score: _s, ...rest }) => rest);
}

interface ParsedAtUri {
  did: string;
  collection: string;
  rkey: string;
}

export function parseAtUri(uri: string): ParsedAtUri {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`Invalid AT-URI: ${uri}`);
  return { did: m[1], collection: m[2], rkey: m[3] };
}

/** Resolve a DID's PDS service endpoint via PLC directory or did:web well-known. */
export async function resolvePds(did: string): Promise<string> {
  let url: string;
  if (did.startsWith("did:plc:")) {
    url = `https://plc.directory/${encodeURIComponent(did)}`;
  } else if (did.startsWith("did:web:")) {
    url = `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Resolve PDS for ${did} failed: ${res.status}`);
  const doc = (await res.json()) as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }> };
  const service = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!service?.serviceEndpoint) throw new Error(`No PDS endpoint for ${did}`);
  return service.serviceEndpoint;
}

/** Fetch a blob (e.g. avatar PNG) by following PDS redirects. */
export async function fetchBlob(did: string, cidLink: string): Promise<Buffer> {
  const pds = await resolvePds(did);
  const url = `${pds.replace(/\/+$/, "")}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cidLink)}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** Read a record directly from the owner's PDS. */
export async function getRecordFromPds<T>(did: string, collection: string, rkey: string): Promise<T> {
  const pds = await resolvePds(did);
  const url =
    `${pds.replace(/\/+$/, "")}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}` +
    `&collection=${encodeURIComponent(collection)}` +
    `&rkey=${encodeURIComponent(rkey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDS getRecord failed: ${res.status}`);
  const json = (await res.json()) as { value?: unknown };
  if (!json.value) throw new Error(`Record not found: ${url}`);
  return json.value as T;
}

/** List records by paging com.atproto.repo.listRecords on a PDS. */
export async function listRecordsFromPds<T>(did: string, collection: string): Promise<Array<{ uri: string; cid: string; value: T }>> {
  const pds = await resolvePds(did);
  const out: Array<{ uri: string; cid: string; value: T }> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ repo: did, collection, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${pds.replace(/\/+$/, "")}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) throw new Error(`PDS listRecords failed: ${res.status}`);
    const json = (await res.json()) as {
      records?: Array<{ uri: string; cid: string; value: unknown }>;
      cursor?: string;
    };
    for (const r of json.records ?? []) out.push({ uri: r.uri, cid: r.cid, value: r.value as T });
    cursor = json.cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * List every `org.simocracy.sim` record owned by `did`, mapped onto the
 * same `SimMatch` shape that `searchSimsByName` produces so the rest of
 * the extension's load/hydrate pipeline accepts these without a second
 * code path. Sorted by `createdAt` descending (most recently created
 * first), since that's how simocracy.org's My Sims carousel surfaces
 * them and it's the most useful ordering when the user types `/sim my 1`.
 */
export async function fetchSimsForDid(did: string): Promise<SimMatch[]> {
  const records = await listRecordsFromPds<SimRecord>(did, COLLECTION_SIM);
  return records
    .filter((r) => r.value && typeof r.value.name === "string")
    .map((r) => {
      const rkey = r.uri.split("/").pop() ?? "";
      return {
        uri: r.uri,
        cid: r.cid,
        did,
        rkey,
        sim: r.value,
      } satisfies SimMatch;
    })
    .sort((a, b) => {
      // Most recent first; fall back to rkey (TIDs are roughly monotonic).
      const ta = a.sim.createdAt || "";
      const tb = b.sim.createdAt || "";
      if (ta && tb) return tb.localeCompare(ta);
      return b.rkey.localeCompare(a.rkey);
    });
}

/** Find the agents record for a sim by scanning the owner's PDS (sim-1:1-agents). */
export async function fetchAgentsForSim(simUri: string): Promise<AgentsRecord | null> {
  const { did } = parseAtUri(simUri);
  try {
    const records = await listRecordsFromPds<AgentsRecord>(did, COLLECTION_AGENTS);
    return records.find((r) => r.value.sim?.uri === simUri)?.value ?? null;
  } catch {
    return null;
  }
}

/** Find the style record for a sim by scanning the owner's PDS. */
export async function fetchStyleForSim(simUri: string): Promise<StyleRecord | null> {
  const { did } = parseAtUri(simUri);
  try {
    const records = await listRecordsFromPds<StyleRecord>(did, COLLECTION_STYLE);
    return records.find((r) => r.value.sim?.uri === simUri)?.value ?? null;
  } catch {
    return null;
  }
}

// (Interview-template fetchers were removed alongside the Training Lab /
// Interview Modal pipelines. The only remaining persona-edit path is the
// `simocracy_update_sim` LLM tool, which doesn't consume templates.)

/** Resolve handle of a DID via Bluesky AppView (best-effort). */
export async function resolveHandle(did: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { handle?: string };
    return json.handle ?? null;
  } catch {
    return null;
  }
}

export const SIMOCRACY_INDEXER_URL = DEFAULT_INDEXER_URL;
