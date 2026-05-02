/**
 * Shared helpers for training LLM prompts.
 *
 * Mirror of `simocracy-v2/lib/training/prompt-helpers.ts` (subset that
 * the CLI actually uses). Keep clamps + wrappers in sync with the web
 * app so the same input produces the same prompt locally.
 */

import type { BaselineProposal, BaselineVote, InterviewTurn } from "./types.ts";

export const CONSTITUTION_MAX_CHARS = 6000;
export const TRANSCRIPT_MAX_TURNS = 16;

export function clampConstitution(text: string | undefined): string {
  if (!text) return "(No current constitution provided)";
  const trimmed = text.trim();
  if (trimmed.length <= CONSTITUTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, CONSTITUTION_MAX_CHARS)}\n\n[…truncated for prompt size; original is ${trimmed.length} chars]`;
}

export function clampTranscript(turns: InterviewTurn[]): InterviewTurn[] {
  if (turns.length <= TRANSCRIPT_MAX_TURNS) return turns;
  return turns.slice(-TRANSCRIPT_MAX_TURNS);
}

export function wrapAsData(label: string, content: string): string {
  return `<${label}>\n${content}\n</${label}>`;
}

export function renderBaselineForPrompt(
  baselineVotes: BaselineVote[],
  baselineProposals: BaselineProposal[],
): string {
  const enriched = baselineVotes
    .map((vote) => {
      const proposal = baselineProposals.find((item) => item.id === vote.proposalId);
      const reasoning = (vote.reasoning ?? "").trim();
      const isUntouched =
        vote.vote === "abstain" && Math.abs(vote.importance - 0.5) < 0.01 && !reasoning;
      if (isUntouched) return null;
      return { vote, proposal, reasoning };
    })
    .filter(
      (entry): entry is { vote: BaselineVote; proposal: BaselineProposal | undefined; reasoning: string } =>
        entry !== null,
    );

  if (enriched.length === 0) {
    return "(The user has not voted on any baseline proposals yet.)";
  }

  const ranked = enriched
    .map((entry) => {
      const cast = entry.vote.vote === "abstain" ? 0 : 1;
      return { ...entry, score: cast * 10 + entry.vote.importance };
    })
    .sort((a, b) => b.score - a.score);

  return ranked
    .map(({ vote, proposal, reasoning }, index) => {
      const title = proposal?.title ?? vote.proposalId;
      const topic = proposal?.topic ? ` (${proposal.topic})` : "";
      const verdict = vote.vote.toUpperCase();
      const importance = vote.importance.toFixed(2);
      const summary = proposal?.summary ? ` — proposal: "${proposal.summary}"` : "";
      const comment = reasoning ? `\n   Comment from user: "${reasoning}"` : "";
      return `${index + 1}. ${verdict} (importance ${importance}) on "${title}"${topic}${summary}${comment}`;
    })
    .join("\n\n");
}
