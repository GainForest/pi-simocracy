/**
 * `/sim train baseline` — vote yes/no/abstain on the loaded sim's
 * baseline proposals, with importance + optional reasoning.
 *
 * Web parity: `simocracy-v2/components/sim/training-lab/baseline-tab.tsx`.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "../persona.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./storage.ts";
import {
  pickInterviewTemplate,
  questionSetFromTemplate,
} from "./question-set.ts";
import type { BaselineProposal, BaselineVote, Vote } from "./types.ts";

const IMPORTANCE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "Negligible (0.1)", value: 0.1 },
  { label: "Low (0.3)", value: 0.3 },
  { label: "Medium (0.5)", value: 0.5 },
  { label: "High (0.7)", value: 0.7 },
  { label: "Critical (0.9)", value: 0.9 },
];

const VOTE_OPTIONS: Array<{ label: string; value: Vote | "skip" }> = [
  { label: "Yes — agree", value: "yes" },
  { label: "No — disagree", value: "no" },
  { label: "Abstain — uncertain", value: "abstain" },
  { label: "Skip — don't vote on this one", value: "skip" },
];

export async function runBaseline(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<void> {
  let state = loadTrainingLabState(loadedSim.rkey);

  // Bootstrap or refresh the question set if missing.
  if (!state.questionSet || state.questionSet.proposals.length === 0) {
    const picked = await pickInterviewTemplate(ctx);
    if (!picked) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    state = {
      ...state,
      questionSet: questionSetFromTemplate(picked.template, picked.uri),
      profile: null,
      alignment: null,
    };
    saveTrainingLabState(loadedSim.rkey, state);
  }

  const proposals = state.questionSet?.proposals ?? [];
  if (proposals.length === 0) {
    ctx.ui.notify("Picked template has no yes/no questions — nothing to vote on.", "warning");
    return;
  }

  ctx.ui.notify(
    `Voting on ${proposals.length} baseline proposals for ${loadedSim.name}. Cancel any prompt to stop early.`,
    "info",
  );

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const existing = state.baselineVotes.find((v) => v.proposalId === proposal.id);
    const answer = await askVote(ctx, proposal, i, proposals.length, existing);
    if (answer === null) {
      ctx.ui.notify("Stopped — votes saved up to this point.", "info");
      break;
    }
    state = {
      ...state,
      baselineVotes: recordBaselineVote(state.baselineVotes, proposal.id, answer),
      // Re-distilling and alignment depend on the votes — clear when votes change.
      profile: null,
      alignment: null,
    };
    saveTrainingLabState(loadedSim.rkey, state);
  }

  const cast = state.baselineVotes.filter(
    (v) => !(v.vote === "abstain" && Math.abs(v.importance - 0.5) < 0.01 && !v.reasoning),
  ).length;
  ctx.ui.notify(
    `Saved ${cast} baseline votes. Run \`/sim train chat\` next, then \`/sim train profile\`.`,
    "info",
  );
}

interface AnsweredVote {
  vote: Vote;
  importance: number;
  reasoning: string;
}

async function askVote(
  ctx: ExtensionCommandContext,
  proposal: BaselineProposal,
  index: number,
  total: number,
  existing: BaselineVote | undefined,
): Promise<AnsweredVote | null> {
  const header = existing
    ? `[${index + 1}/${total}] ${proposal.title} (current: ${existing.vote.toUpperCase()})`
    : `[${index + 1}/${total}] ${proposal.title}`;

  const voteLabel = await ctx.ui.select(header, VOTE_OPTIONS.map((o) => o.label));
  if (!voteLabel) return null;
  const voteEntry = VOTE_OPTIONS.find((o) => o.label === voteLabel);
  if (!voteEntry) return null;

  // Skip leaves the abstain default at importance 0.5 with no reasoning,
  // which the prompt-helpers' renderer treats as untouched.
  if (voteEntry.value === "skip") {
    return { vote: "abstain", importance: 0.5, reasoning: "" };
  }

  const importanceLabel = await ctx.ui.select(
    "How important is this to you?",
    IMPORTANCE_OPTIONS.map((o) => o.label),
  );
  if (!importanceLabel) return null;
  const importance =
    IMPORTANCE_OPTIONS.find((o) => o.label === importanceLabel)?.value ?? 0.5;

  const reasoning = await ctx.ui.input(
    "Optional reasoning (Enter to skip)",
    `Why did you vote ${voteEntry.value}?`,
  );

  return {
    vote: voteEntry.value,
    importance,
    reasoning: (reasoning ?? "").trim(),
  };
}

function recordBaselineVote(
  votes: BaselineVote[],
  proposalId: string,
  next: AnsweredVote,
): BaselineVote[] {
  const without = votes.filter((v) => v.proposalId !== proposalId);
  return [
    ...without,
    {
      proposalId,
      vote: next.vote,
      importance: next.importance,
      reasoning: next.reasoning,
    },
  ];
}
