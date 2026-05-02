/**
 * `/sim train alignment` — score the sim against the user's hidden
 * baseline votes. Mirrors `/api/training/alignment-test` from
 * simocracy-v2.
 *
 * Calls the alignment prompt once per proposal with concurrency 4,
 * then prints a per-proposal table + overall match percentage and
 * weak-area summary.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "../persona.ts";
import { openRouterComplete, TRAINING_CHAT_MODEL } from "../openrouter.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./storage.ts";
import { clampConstitution, wrapAsData } from "./prompt-helpers.ts";
import { TRAINING_ALIGNMENT_TEST_SYSTEM_PROMPT } from "./prompts.ts";
import { bar } from "./profile.ts";
import type {
  AlignmentResult,
  BaselineProposal,
  TrainingProfile,
  Vote,
} from "./types.ts";

const MIN_VOTES = 5;
const CONCURRENCY = 4;

export async function runAlignment(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<AlignmentResult | null> {
  let state = loadTrainingLabState(loadedSim.rkey);
  if (!state.profile) {
    ctx.ui.notify("Need a profile first — run `/sim train profile`.", "warning");
    return null;
  }
  const proposals = state.questionSet?.proposals ?? [];
  const cast = state.baselineVotes.filter(
    (v) => !(v.vote === "abstain" && Math.abs(v.importance - 0.5) < 0.01 && !v.reasoning),
  );
  if (cast.length < MIN_VOTES) {
    ctx.ui.notify(
      `Need at least ${MIN_VOTES} cast baseline votes to run alignment (you have ${cast.length}).`,
      "warning",
    );
    return null;
  }

  const aligned = proposals
    .map((proposal) => {
      const userVote = state.baselineVotes.find((v) => v.proposalId === proposal.id);
      if (!userVote) return null;
      if (
        userVote.vote === "abstain" &&
        Math.abs(userVote.importance - 0.5) < 0.01 &&
        !userVote.reasoning
      ) {
        return null;
      }
      return { proposal, userVote: userVote.vote };
    })
    .filter((entry): entry is { proposal: BaselineProposal; userVote: Vote } => entry !== null);

  ctx.ui.notify(
    `Running alignment test on ${aligned.length} proposals (concurrency ${CONCURRENCY})…`,
    "info",
  );

  let alignment: AlignmentResult;
  try {
    alignment = await scoreAlignment(loadedSim, state.profile, aligned);
  } catch (err) {
    ctx.ui.notify(`Alignment failed: ${(err as Error).message}`, "error");
    return null;
  }

  state = { ...state, alignment };
  saveTrainingLabState(loadedSim.rkey, state);
  printAlignment(alignment, aligned);
  return alignment;
}

export async function scoreAlignment(
  loadedSim: LoadedSim,
  profile: TrainingProfile,
  aligned: Array<{ proposal: BaselineProposal; userVote: Vote }>,
): Promise<AlignmentResult> {
  const simVotes = await mapWithConcurrency(aligned, CONCURRENCY, async (entry) =>
    askSimVote(loadedSim, profile, entry.proposal),
  );

  const results = aligned.map((entry, index) => {
    const sv = simVotes[index];
    return {
      proposalId: entry.proposal.id,
      userVote: entry.userVote,
      simVote: sv?.simVote ?? "abstain",
      matched: entry.userVote === sv?.simVote,
      confidence: sv?.confidence ?? 0,
      explanation: sv?.explanation ?? "No explanation returned.",
    };
  });

  const matchedCount = results.filter((r) => r.matched).length;
  const weakAreas = Array.from(
    new Set(
      results
        .filter((r) => !r.matched)
        .map((r) => aligned.find((a) => a.proposal.id === r.proposalId)?.proposal.topic)
        .filter((topic): topic is string => typeof topic === "string"),
    ),
  ).slice(0, 4);

  return {
    matchedCount,
    totalCount: results.length,
    results,
    weakAreas,
  };
}

interface SimVote {
  simVote: Vote;
  confidence: number;
  explanation: string;
}

async function askSimVote(
  loadedSim: LoadedSim,
  profile: TrainingProfile,
  proposal: BaselineProposal,
): Promise<SimVote> {
  const userPrompt = [
    `simName: ${loadedSim.name}`,
    wrapAsData("existingConstitution", clampConstitution(loadedSim.description)),
    wrapAsData("trainingProfile", JSON.stringify(profile, null, 2)),
    wrapAsData(
      "proposal",
      JSON.stringify(
        { id: proposal.id, title: proposal.title, summary: proposal.summary, topic: proposal.topic },
        null,
        2,
      ),
    ),
    "Output shape: { vote: 'yes' | 'no' | 'abstain', confidence: 0-1, explanation: <280 chars }",
  ].join("\n\n");

  const content = await openRouterComplete(
    [
      { role: "system", content: TRAINING_ALIGNMENT_TEST_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { model: TRAINING_CHAT_MODEL, maxTokens: 350, temperature: 0.2 },
  );

  const parsed = parseJsonObject(content);
  const simVote = normalizeVote(parsed?.vote);
  const confidence = toUnit(parsed?.confidence);
  const explanation =
    typeof parsed?.explanation === "string" ? parsed.explanation.trim().slice(0, 280) : "";
  if (!simVote || confidence === null || !explanation) {
    throw new Error("Could not parse alignment vote from model output");
  }
  return { simVote, confidence, explanation };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      const item = items[i];
      if (item !== undefined) {
        results[i] = await mapper(item, i);
      }
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// -----------------------------------------------------------------
// JSON parsing — same shape as profile.ts
// -----------------------------------------------------------------

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function normalizeVote(value: unknown): Vote | null {
  if (value === "yes" || value === "no" || value === "abstain") return value;
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return normalized === "yes" || normalized === "no" || normalized === "abstain"
    ? (normalized as Vote)
    : null;
}

// -----------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------

export function printAlignment(
  alignment: AlignmentResult,
  aligned: Array<{ proposal: BaselineProposal; userVote: Vote }>,
): void {
  const lines: string[] = [""];
  for (const r of alignment.results) {
    const prop = aligned.find((a) => a.proposal.id === r.proposalId)?.proposal;
    const title = prop?.title ?? r.proposalId;
    const symbol = r.matched ? "✓" : "✗";
    const u = r.userVote.padEnd(7, " ");
    const s = r.simVote.padEnd(7, " ");
    lines.push(`${symbol}  user:${u} ↔ sim:${s} ${bar(r.confidence)}  ${title}`);
  }
  lines.push("");
  const pct =
    alignment.totalCount > 0
      ? Math.round((alignment.matchedCount / alignment.totalCount) * 100)
      : 0;
  lines.push(`Match: ${alignment.matchedCount}/${alignment.totalCount} (${pct}%)`);
  if (alignment.weakAreas.length) {
    lines.push(`Weak areas: ${alignment.weakAreas.join(", ")}`);
  }
  console.log(lines.join("\n"));
}
