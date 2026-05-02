/**
 * `/sim train profile` — distill baseline + transcript into a
 * `TrainingProfile`. Mirrors `/api/training/extract-profile` from
 * simocracy-v2.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "../persona.ts";
import { openRouterComplete, TRAINING_CHAT_MODEL } from "../openrouter.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./storage.ts";
import {
  clampConstitution,
  clampTranscript,
  renderBaselineForPrompt,
  wrapAsData,
} from "./prompt-helpers.ts";
import { TRAINING_EXTRACT_PROFILE_SYSTEM_PROMPT } from "./prompts.ts";
import type { IssuePriority, TrainingProfile } from "./types.ts";

export async function runProfile(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<TrainingProfile | null> {
  let state = loadTrainingLabState(loadedSim.rkey);
  const proposals = state.questionSet?.proposals ?? [];
  if (state.baselineVotes.length === 0 && state.interviewTurns.length === 0) {
    ctx.ui.notify(
      "Need at least some baseline votes or interview turns before distilling. Run `/sim train baseline` first.",
      "warning",
    );
    return null;
  }

  ctx.ui.notify("Distilling profile…", "info");
  let profile: TrainingProfile | null;
  try {
    profile = await deriveProfile(loadedSim, state, proposals);
  } catch (err) {
    ctx.ui.notify(`OpenRouter error: ${(err as Error).message}`, "error");
    return null;
  }

  if (!profile) {
    ctx.ui.notify("Could not parse profile from model response.", "error");
    return null;
  }

  state = { ...state, profile, alignment: null };
  saveTrainingLabState(loadedSim.rkey, state);
  printProfile(profile);
  ctx.ui.notify(
    "Profile saved. Run `/sim train alignment` next, or `/sim train apply` to merge it into the constitution.",
    "info",
  );
  return profile;
}

export async function deriveProfile(
  loadedSim: LoadedSim,
  state: ReturnType<typeof loadTrainingLabState>,
  proposals: { id: string; title: string; summary: string; topic: string }[],
): Promise<TrainingProfile | null> {
  const constitution = clampConstitution(loadedSim.description);
  const baseline = renderBaselineForPrompt(state.baselineVotes, proposals);
  const transcript = clampTranscript(state.interviewTurns);

  const userPrompt = [
    `simName: ${loadedSim.name}`,
    wrapAsData("existingConstitution", constitution),
    wrapAsData("baselineQuestionnaire", baseline),
    wrapAsData("transcript", JSON.stringify(transcript, null, 2)),
  ].join("\n\n");

  const content = await openRouterComplete(
    [
      { role: "system", content: TRAINING_EXTRACT_PROFILE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { model: TRAINING_CHAT_MODEL, maxTokens: 1800, temperature: 0.3 },
  );

  return parseProfile(content);
}

// -----------------------------------------------------------------
// Parsing — mirrors `normalizeProfile` in
// `simocracy-v2/app/api/training/extract-profile/route.ts`.
// -----------------------------------------------------------------

function parseProfile(content: string): TrainingProfile | null {
  const parsed = parseJsonObject(content);
  if (!parsed) return null;

  const coreValues = normalizeStringArray(parsed.coreValues, 7);
  const issuePriorities = normalizeIssuePriorities(parsed.issuePriorities);
  const redLines = normalizeStringArray(parsed.redLines, 6);
  const acceptableTradeoffs = normalizeStringArray(parsed.acceptableTradeoffs, 6);
  const uncertaintyAreas = normalizeStringArray(parsed.uncertaintyAreas, 6);
  const representationRules = normalizeStringArray(parsed.representationRules, 5);

  if (
    typeof parsed.summary !== "string" ||
    coreValues.length < 3 ||
    issuePriorities.length < 4
  ) {
    return null;
  }

  return {
    summary: parsed.summary.trim(),
    coreValues,
    issuePriorities,
    redLines,
    acceptableTradeoffs,
    uncertaintyAreas,
    representationRules,
  };
}

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

function normalizeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeIssuePriorities(value: unknown): IssuePriority[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      if (typeof item.issue !== "string" || typeof item.stance !== "string") return null;
      const importance = toUnit(item.importance);
      const negotiability = toUnit(item.negotiability);
      const confidence = toUnit(item.confidence);
      if (importance === null || negotiability === null || confidence === null) return null;
      return {
        issue: item.issue.trim(),
        stance: item.stance.trim(),
        importance,
        negotiability,
        confidence,
      };
    })
    .filter((item): item is IssuePriority => item !== null)
    .slice(0, 10);
}

function toUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// -----------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------

const BAR_WIDTH = 10;

export function bar(value: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(value * BAR_WIDTH)));
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

export function printProfile(profile: TrainingProfile): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Summary: ${profile.summary}`);
  lines.push("");
  lines.push(`Core Values:`);
  for (const v of profile.coreValues) lines.push(`  - ${v}`);
  lines.push("");
  lines.push(`Issue Priorities:`);
  for (const p of profile.issuePriorities) {
    lines.push(
      `  ${bar(p.importance)} importance | ${bar(p.negotiability)} negotiability | ${bar(p.confidence)} confidence`,
    );
    lines.push(`  ${p.issue} — ${p.stance}`);
    lines.push("");
  }
  if (profile.redLines.length) {
    lines.push(`Red Lines:`);
    for (const r of profile.redLines) lines.push(`  - ${r}`);
    lines.push("");
  }
  if (profile.acceptableTradeoffs.length) {
    lines.push(`Acceptable Tradeoffs:`);
    for (const t of profile.acceptableTradeoffs) lines.push(`  - ${t}`);
    lines.push("");
  }
  if (profile.uncertaintyAreas.length) {
    lines.push(`Uncertainty Areas:`);
    for (const u of profile.uncertaintyAreas) lines.push(`  - ${u}`);
    lines.push("");
  }
  if (profile.representationRules.length) {
    lines.push(`Representation Rules:`);
    for (const r of profile.representationRules) lines.push(`  - ${r}`);
  }
  console.log(lines.join("\n"));
}
