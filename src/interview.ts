/**
 * `/sim interview` — port of simocracy-v2's `interview-modal.tsx` to
 * the terminal. Runs the questionnaire (open + yes/no questions),
 * lets the user review answers, then derives a constitution + style
 * via OpenRouter. PR 2 prints the result and tells the user to
 * paste into simocracy.org. PR 3 will write to PDS via OAuth.
 *
 * Skips ElevenLabs (voice) entirely — terminal is text-only. Open
 * questions are answered as multi-line text via the editor primitive
 * when available, falling back to single-line input.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "./persona.ts";
import { openRouterComplete, TRAINING_CHAT_MODEL } from "./openrouter.ts";
import { DERIVE_FROM_INTERVIEW_SYSTEM_PROMPT } from "./training/prompts.ts";
import {
  pickInterviewTemplate,
  buildFallbackTemplate,
} from "./training/question-set.ts";
import {
  searchInterviewTemplates,
  fetchInterviewTemplateByUri,
  resolveHandle,
  type LoadedInterviewTemplate,
} from "./simocracy.ts";
import { readAuth } from "./auth/storage.ts";
import {
  createAgents,
  createInterview,
  createStyle,
  findRkeyForSim,
  getAuthenticatedAgent,
  NotSignedInError,
  updateAgents,
  updateStyle,
} from "./writes.ts";

interface OpenAnswer {
  question: string;
  answer: string;
}
interface YesNoAnswer {
  statement: string;
  answer: boolean;
}

export interface InterviewResult {
  openAnswers: OpenAnswer[];
  yesNoAnswers: YesNoAnswer[];
}

export interface DerivedSim {
  constitution: { shortDescription: string; description: string };
  style: { description: string };
}

export interface RunInterviewOptions {
  templateUri?: string;
  /** When true, skip the picker and just use the first matching template. */
  pickFirst?: boolean;
  /** When true, after deriving, write to the user's PDS via OAuth. */
  apply?: boolean;
}

/**
 * Drive the interactive interview flow. Returns null if the user
 * cancels at any point.
 */
export async function runInterviewFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
  opts: RunInterviewOptions = {},
): Promise<{ result: InterviewResult; derived: DerivedSim | null } | null> {
  void pi;
  // 1. Pick template (or use the prop).
  let template: LoadedInterviewTemplate | null = null;
  if (opts.templateUri) {
    template = await fetchInterviewTemplateByUri(opts.templateUri);
    if (!template) {
      ctx.ui.notify(
        `Couldn't load template ${opts.templateUri}, falling back to picker.`,
        "warning",
      );
    }
  }
  if (!template) {
    template = await pickInterviewTemplate(ctx);
  }
  if (!template) {
    ctx.ui.notify("Cancelled.", "info");
    return null;
  }

  ctx.ui.notify(
    `Interview: ${template.template.name} — ${template.template.questions.length} questions.`,
    "info",
  );

  // 2. Run the questionnaire.
  const result = await runQuestionnaire(ctx, template);
  if (!result) return null;

  // 3. Review.
  const reviewed = await reviewAnswers(ctx, template, result);
  if (!reviewed) return null;

  // 4. Derive (read-only — no PDS write in PR 2).
  ctx.ui.notify("Deriving constitution + style…", "info");
  let derived: DerivedSim | null = null;
  try {
    derived = await deriveFromInterview(loadedSim, reviewed);
  } catch (err) {
    ctx.ui.notify(`Derivation failed: ${(err as Error).message}`, "error");
  }

  if (derived) {
    printDerived(loadedSim, derived);
    if (opts.apply) {
      await applyDerivedToPds(ctx, loadedSim, template, reviewed, derived);
    } else {
      ctx.ui.notify(
        "To save: copy the output into the constitution + style editors at simocracy.org, or sign into ATProto via `/sim login <handle>` and re-run with --apply.",
        "info",
      );
    }
  }

  return { result: reviewed, derived };
}

async function applyDerivedToPds(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
  template: LoadedInterviewTemplate,
  result: InterviewResult,
  derived: DerivedSim,
): Promise<boolean> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify("Not signed into ATProto. Run `/sim login <handle>` first (e.g. `/sim login alice.bsky.social`).", "error");
    return false;
  }
  if (auth.did !== loadedSim.did) {
    const ownerHandle =
      loadedSim.handle ?? (await resolveHandle(loadedSim.did).catch(() => null));
    ctx.ui.notify(
      `You can only apply to sims you own. Loaded sim is owned by ${
        ownerHandle ? `@${ownerHandle}` : loadedSim.did
      } — your signed-in DID is ${auth.did}.`,
      "error",
    );
    return false;
  }

  let agent;
  try {
    ({ agent } = await getAuthenticatedAgent());
  } catch (err) {
    if (err instanceof NotSignedInError) ctx.ui.notify(err.message, "error");
    else ctx.ui.notify(`Auth failed: ${(err as Error).message}`, "error");
    return false;
  }

  ctx.ui.notify("Writing interview record…", "info");
  try {
    await createInterview({
      agent,
      did: auth.did,
      simUri: loadedSim.uri,
      simCid: "",
      openAnswers: result.openAnswers.map((a) => ({
        question: a.question,
        answer: a.answer,
      })),
      yesNoAnswers: result.yesNoAnswers.map((a) => ({
        statement: a.statement,
        answer: a.answer,
      })),
      templateUri: template.uri || undefined,
      templateCid: template.cid || undefined,
    });
  } catch (err) {
    ctx.ui.notify(`Interview write failed: ${(err as Error).message}`, "error");
    return false;
  }

  // Now create-or-update the agents + style records to match the
  // derived constitution. Mirrors `derive-from-interview/route.ts`'s
  // flow on simocracy-v2.
  const existingAgents = await findRkeyForSim(
    agent,
    auth.did,
    "org.simocracy.agents",
    loadedSim.uri,
  ).catch(() => null);
  ctx.ui.notify(
    existingAgents
      ? `Updating org.simocracy.agents (${existingAgents})…`
      : "Creating org.simocracy.agents…",
    "info",
  );
  try {
    if (existingAgents) {
      await updateAgents({
        agent,
        did: auth.did,
        rkey: existingAgents,
        simUri: loadedSim.uri,
        simCid: "",
        shortDescription: derived.constitution.shortDescription,
        description: derived.constitution.description,
      });
    } else {
      await createAgents({
        agent,
        did: auth.did,
        simUri: loadedSim.uri,
        simCid: "",
        shortDescription: derived.constitution.shortDescription,
        description: derived.constitution.description,
      });
    }
  } catch (err) {
    ctx.ui.notify(`Agents write failed: ${(err as Error).message}`, "error");
    return false;
  }

  const existingStyle = await findRkeyForSim(
    agent,
    auth.did,
    "org.simocracy.style",
    loadedSim.uri,
  ).catch(() => null);
  ctx.ui.notify(
    existingStyle ? `Updating org.simocracy.style (${existingStyle})…` : "Creating org.simocracy.style…",
    "info",
  );
  try {
    if (existingStyle) {
      await updateStyle({
        agent,
        did: auth.did,
        rkey: existingStyle,
        simUri: loadedSim.uri,
        simCid: "",
        description: derived.style.description,
      });
    } else {
      await createStyle({
        agent,
        did: auth.did,
        simUri: loadedSim.uri,
        simCid: "",
        description: derived.style.description,
      });
    }
  } catch (err) {
    ctx.ui.notify(`Style write failed: ${(err as Error).message}`, "error");
    return false;
  }

  ctx.ui.notify(
    `Saved interview, constitution, and speaking style to ${
      auth.handle ? `@${auth.handle}` : auth.did
    }'s PDS.`,
    "info",
  );
  return true;
}

/**
 * Headless variant for the LLM-callable tool: returns the template
 * structure as a planning aid when there's no UI to drive it.
 */
export async function snapshotInterviewTemplate(
  templateUri?: string,
): Promise<{ name: string; questions: { id: string; type: string; prompt: string }[] }> {
  let tpl: LoadedInterviewTemplate | null = null;
  if (templateUri) {
    tpl = await fetchInterviewTemplateByUri(templateUri);
  }
  if (!tpl) {
    const list = await searchInterviewTemplates(10).catch(() => []);
    tpl = list[0] ?? {
      uri: "",
      cid: "",
      did: "",
      rkey: "",
      template: buildFallbackTemplate(),
    };
  }
  return {
    name: tpl.template.name,
    questions: tpl.template.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
    })),
  };
}

async function runQuestionnaire(
  ctx: ExtensionCommandContext,
  template: LoadedInterviewTemplate,
): Promise<InterviewResult | null> {
  const open: OpenAnswer[] = [];
  const yesNo: YesNoAnswer[] = [];

  for (let i = 0; i < template.template.questions.length; i++) {
    const q = template.template.questions[i];
    const header = `[${i + 1}/${template.template.questions.length}]`;

    if (q.type === "open" || q.type === "text") {
      const answer = await askOpen(ctx, header, q.prompt);
      if (answer === null) return null;
      if (answer.trim()) open.push({ question: q.prompt, answer: answer.trim() });
    } else if (q.type === "yesNo") {
      const choice = await ctx.ui.select(`${header} ${q.prompt}`, [
        "Agree",
        "Disagree",
        "Skip",
      ]);
      if (choice === undefined) return null;
      if (choice === "Skip") continue;
      yesNo.push({ statement: q.prompt, answer: choice === "Agree" });
    }
  }

  return { openAnswers: open, yesNoAnswers: yesNo };
}

async function askOpen(
  ctx: ExtensionCommandContext,
  header: string,
  prompt: string,
): Promise<string | null> {
  // Prefer the multi-line editor when available — open questions
  // expect 2-4 sentences of prose.
  try {
    const text = await ctx.ui.editor(`${header} ${prompt}`);
    if (text === undefined) return null;
    return text;
  } catch {
    const text = await ctx.ui.input(`${header} ${prompt}`, "Your answer (Enter to skip)");
    if (text === undefined) return null;
    return text;
  }
}

async function reviewAnswers(
  ctx: ExtensionCommandContext,
  template: LoadedInterviewTemplate,
  result: InterviewResult,
): Promise<InterviewResult | null> {
  const summarise = (r: InterviewResult) => {
    const lines = [`\nReview (${template.template.name}):\n`];
    if (r.openAnswers.length) {
      lines.push("Open answers:");
      for (const a of r.openAnswers) {
        lines.push(`  • ${a.question}`);
        lines.push(`    ${a.answer.replace(/\n/g, "\n    ")}`);
      }
      lines.push("");
    }
    if (r.yesNoAnswers.length) {
      lines.push("Value positions:");
      for (const a of r.yesNoAnswers) {
        const verdict = a.answer ? "Agree   " : "Disagree";
        lines.push(`  ${verdict}  ${a.statement}`);
      }
      lines.push("");
    }
    console.log(lines.join("\n"));
  };

  let current = result;
  for (;;) {
    summarise(current);
    const next = await ctx.ui.select("Review your interview", [
      "Continue — derive constitution + style",
      "Edit an answer",
      "Cancel",
    ]);
    if (next === undefined || next === "Cancel") return null;
    if (next.startsWith("Continue")) return current;

    const labels = current.openAnswers.map((a, i) => `${i + 1}. ${a.question}`);
    if (labels.length === 0) {
      ctx.ui.notify("No open answers to edit.", "info");
      continue;
    }
    const picked = await ctx.ui.select("Edit which answer?", labels);
    if (!picked) continue;
    const idx = labels.indexOf(picked);
    const old = current.openAnswers[idx];
    let updated: string | undefined;
    try {
      updated = await ctx.ui.editor(`Edit: ${old.question}`, old.answer);
    } catch {
      updated = await ctx.ui.input(`Edit: ${old.question}`, old.answer);
    }
    if (updated === undefined) continue;
    const trimmed = updated.trim();
    if (!trimmed) {
      current = {
        ...current,
        openAnswers: current.openAnswers.filter((_, i) => i !== idx),
      };
    } else {
      const nextOpen = [...current.openAnswers];
      nextOpen[idx] = { ...old, answer: trimmed };
      current = { ...current, openAnswers: nextOpen };
    }
  }
}

export async function deriveFromInterview(
  loadedSim: LoadedSim,
  result: InterviewResult,
): Promise<DerivedSim | null> {
  void loadedSim; // Reserved for future per-sim variations.
  const openSection =
    result.openAnswers.length > 0
      ? result.openAnswers
          .map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`)
          .join("\n\n")
      : "(No open-ended responses provided)";

  const yesNoSection =
    result.yesNoAnswers.length > 0
      ? result.yesNoAnswers
          .map((a) => `- "${a.statement}" → ${a.answer ? "Agree" : "Disagree"}`)
          .join("\n")
      : "(No value positions provided)";

  const userMessage = `Here is the interview transcript for a sim:

## Open-Ended Responses

${openSection}

## Value Positions

${yesNoSection}`;

  const content = await openRouterComplete(
    [
      { role: "system", content: DERIVE_FROM_INTERVIEW_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { model: TRAINING_CHAT_MODEL, maxTokens: 3000, temperature: 0.8 },
  );

  return parseDerivedOutput(content);
}

/**
 * Parse the `=== CONSTITUTION === / === STYLE ===` delimited output
 * the same way `app/api/derive-from-interview/route.ts` does.
 */
export function parseDerivedOutput(content: string): DerivedSim | null {
  const generated = content.trim();
  const constitutionMarker = "=== CONSTITUTION ===";
  const styleMarker = "=== STYLE ===";
  const cIdx = generated.indexOf(constitutionMarker);
  const sIdx = generated.indexOf(styleMarker);
  if (cIdx === -1 || sIdx === -1) return null;

  const constitutionSection = generated.slice(cIdx + constitutionMarker.length, sIdx).trim();
  const styleSection = generated.slice(sIdx + styleMarker.length).trim();

  let shortDescription = "";
  let constitutionMarkdown = constitutionSection;
  const delimiter = constitutionSection.indexOf("\n---\n");
  if (delimiter !== -1) {
    const header = constitutionSection.slice(0, delimiter).trim();
    constitutionMarkdown = constitutionSection.slice(delimiter + 5).trim();
    if (header.startsWith("SHORT:")) {
      shortDescription = header.slice(6).trim().slice(0, 300);
    } else {
      shortDescription = header.slice(0, 300);
    }
  } else {
    const firstSentenceEnd = constitutionSection.search(/[.!?]\s/);
    if (firstSentenceEnd > 0 && firstSentenceEnd < 300) {
      shortDescription = constitutionSection.slice(0, firstSentenceEnd + 1).trim();
      constitutionMarkdown = constitutionSection.slice(firstSentenceEnd + 1).trim();
    } else {
      shortDescription = constitutionSection.slice(0, 200).trim();
    }
  }

  return {
    constitution: { shortDescription, description: constitutionMarkdown },
    style: { description: styleSection },
  };
}

function printDerived(loadedSim: LoadedSim, derived: DerivedSim): void {
  console.log("");
  console.log(`Short description for ${loadedSim.name}:`);
  console.log(derived.constitution.shortDescription);
  console.log("");
  console.log(`Constitution (markdown):`);
  console.log(derived.constitution.description);
  console.log("");
  console.log(`Speaking style (markdown):`);
  console.log(derived.style.description);
  console.log("");
}
