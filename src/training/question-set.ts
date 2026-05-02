/**
 * Question-set bootstrapping for the CLI Training Lab.
 *
 * Web parity: `simocracy-v2/lib/training/question-sets.ts`. The web
 * Lab's BaselineTab auto-picks the facilitator-starred default
 * template via the indexer; the CLI does the same by listing
 * `org.simocracy.interviewTemplate` records and asking the user to
 * pick one (single template = pick automatically; none = built-in
 * fallback that mirrors `interview-modal.tsx`'s
 * `buildFallbackTemplate`).
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { searchInterviewTemplates, type LoadedInterviewTemplate } from "../simocracy.ts";
import type { BaselineProposal, BaselineQuestionSet, InterviewTemplateRecord } from "./types.ts";

const FALLBACK_OPEN_QUESTIONS = [
  "What's your personal definition of a \"high-impact project\"?",
  "When you review a proposal, what are the top 3 things you look for?",
  "What red flags make you skeptical about a proposal's credibility?",
  "How do you balance measurable outcomes vs. long-term systemic change?",
  "If you had limited resources, how would you decide which project to support?",
  "Which values guide your evaluations the most (e.g., equity, scale, innovation, sustainability)?",
  "Can you give an example of a project you'd enthusiastically fund, and why?",
  "Can you give an example of a project you'd likely reject, and why?",
];

const FALLBACK_YESNO_STATEMENTS = [
  "Projects with strong community governance should receive preference in funding.",
  "Public goods that effectively demonstrate the benefit of public goods should receive more funding.",
  "Environmental sustainability should be a key factor in funding decisions.",
  "Innovation and experimental approaches should be prioritized over proven solutions.",
  "Projects with measurable outcomes should be favored over those with difficult-to-quantify benefits.",
  "Funders should be accountable for the funding they provide to the selected projects.",
  "Humans are accountable for decisions made by an AI.",
  "Public goods should prioritize immediate community needs over long-term systemic change.",
  "Projects that already have a lot of support shouldn't receive additional donations for new small projects.",
  "Cost effectiveness should be the primary criterion for funding allocation.",
  "Funding decisions should consider geographic equity and underserved populations.",
  "Projects that benefit the greatest number of people should be prioritized.",
  "Funding should support projects with sustainable revenue models.",
  "Open source software should be allocated the most funding compared to other categories.",
];

export function buildFallbackTemplate(): InterviewTemplateRecord {
  return {
    $type: "org.simocracy.interviewTemplate",
    name: "Default Constitution",
    description: "Built-in fallback when the indexer returns no curated templates.",
    questions: [
      ...FALLBACK_OPEN_QUESTIONS.map((prompt, i) => ({
        id: `open-${i + 1}`,
        type: "open" as const,
        prompt,
      })),
      ...FALLBACK_YESNO_STATEMENTS.map((prompt, i) => ({
        id: `yesno-${i + 1}`,
        type: "yesNo" as const,
        prompt,
      })),
    ],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Convert the yes/no questions of a template into a BaselineQuestionSet.
 * Mirrors `questionSetFromTemplate` in
 * `simocracy-v2/lib/training/question-sets.ts`.
 */
export function questionSetFromTemplate(
  template: InterviewTemplateRecord,
  templateUri: string,
): BaselineQuestionSet {
  const rkey = templateUri.split("/").pop() ?? "template";
  const proposals: BaselineProposal[] = template.questions
    .filter((q) => q.type === "yesNo")
    .map((question, index) => ({
      id: `template:${rkey}:${question.id || `q${index}`}`,
      title: question.prompt,
      summary: question.prompt,
      topic: template.name,
    }));
  return {
    source: "template",
    templateUri,
    templateName: template.name,
    proposals,
  };
}

/**
 * Pick an interview template via `ctx.ui.select`. Returns null if the
 * user cancels. Falls back to the built-in template when the indexer
 * returns nothing.
 */
export async function pickInterviewTemplate(
  ctx: ExtensionCommandContext,
): Promise<LoadedInterviewTemplate | null> {
  ctx.ui.notify("Loading interview templates…", "info");
  let templates: LoadedInterviewTemplate[] = [];
  try {
    templates = await searchInterviewTemplates(100);
  } catch (err) {
    ctx.ui.notify(
      `Indexer template fetch failed: ${(err as Error).message}. Using built-in fallback.`,
      "warning",
    );
  }

  if (templates.length === 0) {
    ctx.ui.notify(
      "No curated templates available — using built-in fallback questionnaire.",
      "info",
    );
    return {
      uri: "",
      cid: "",
      did: "",
      rkey: "",
      template: buildFallbackTemplate(),
    };
  }

  const labels = templates.map((t) => {
    const yesNoCount = t.template.questions.filter((q) => q.type === "yesNo").length;
    return `${t.template.name}  —  ${yesNoCount} yes/no, ${t.template.questions.length} total`;
  });
  const picked = await ctx.ui.select("Choose an interview template", labels);
  if (!picked) return null;
  const idx = labels.indexOf(picked);
  return templates[idx] ?? null;
}
