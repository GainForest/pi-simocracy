/**
 * `/sim train …` command dispatcher.
 *
 * Sub-commands mirror the five tabs of the Training Lab in
 * simocracy-v2 plus `status` / `reset`. Run `/sim train` (no arg) for
 * usage. All flows operate on the currently-loaded sim and persist
 * state to `~/.local/share/pi-simocracy/training/<rkey>.json`.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "../persona.ts";
import { runBaseline } from "./baseline.ts";
import { runChat } from "./chat.ts";
import { runProfile } from "./profile.ts";
import { runFeedback } from "./feedback.ts";
import { runAlignment } from "./alignment.ts";
import { runApply } from "./apply.ts";
import {
  clearTrainingLabState,
  loadTrainingLabState,
  trainingFilePath,
} from "./storage.ts";

const HELP = [
  "Usage: /sim train <subcommand>",
  "",
  "  baseline   Vote yes/no/abstain on the loaded sim's baseline proposals.",
  "  chat       Adaptive interview with the sim — fill gaps in your stance.",
  "  profile    Distill baseline + transcript into a TrainingProfile.",
  "  feedback   Free-form chat with the sim about its constitution.",
  "  alignment  Score the sim against your hidden baseline votes.",
  "  apply      Merge the profile into the constitution (clipboard copy in PR 2).",
  "  status     Print local state path + counts.",
  "  reset      Delete local training data for this sim.",
].join("\n");

export async function runTrainCommand(
  ctx: ExtensionCommandContext,
  arg: string,
  loadedSim: LoadedSim | null,
): Promise<void> {
  const sub = arg.trim().split(/\s+/)[0] ?? "";

  if (!sub || sub === "help" || sub === "--help") {
    ctx.ui.notify(HELP, "info");
    return;
  }

  if (sub === "status") {
    await runStatus(ctx, loadedSim);
    return;
  }
  if (sub === "reset") {
    await runReset(ctx, loadedSim);
    return;
  }

  if (!loadedSim) {
    ctx.ui.notify(
      "No sim loaded. Run `/sim <name>` first, then `/sim train …`.",
      "error",
    );
    return;
  }

  switch (sub) {
    case "baseline":
      await runBaseline(ctx, loadedSim);
      return;
    case "chat":
      await runChat(ctx, loadedSim);
      return;
    case "profile":
      await runProfile(ctx, loadedSim);
      return;
    case "feedback":
      await runFeedback(ctx, loadedSim);
      return;
    case "alignment":
      await runAlignment(ctx, loadedSim);
      return;
    case "apply":
      await runApply(ctx, loadedSim);
      return;
    default:
      ctx.ui.notify(`Unknown subcommand: ${sub}\n\n${HELP}`, "error");
      return;
  }
}

async function runStatus(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim | null,
): Promise<void> {
  if (!loadedSim) {
    ctx.ui.notify("No sim loaded.", "info");
    return;
  }
  const path = trainingFilePath(loadedSim.rkey);
  const state = loadTrainingLabState(loadedSim.rkey);
  const cast = state.baselineVotes.filter(
    (v) => !(v.vote === "abstain" && Math.abs(v.importance - 0.5) < 0.01 && !v.reasoning),
  ).length;
  const lines = [
    `Sim:        ${loadedSim.name} (${loadedSim.uri})`,
    `State file: ${path}`,
    `Updated:    ${state.updatedAt}`,
    `Baseline:   ${cast}/${state.baselineVotes.length} cast votes`,
    `Interview:  ${state.interviewTurns.length} turns`,
    `Feedback:   ${(state.feedbackTurns ?? []).length} turns`,
    `Profile:    ${state.profile ? "yes" : "no"}`,
    `Alignment:  ${state.alignment ? `${state.alignment.matchedCount}/${state.alignment.totalCount}` : "no"}`,
    `Question set: ${state.questionSet?.source === "template" ? state.questionSet.templateName : "(none)"}`,
  ];
  console.log("\n" + lines.join("\n") + "\n");
}

async function runReset(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim | null,
): Promise<void> {
  if (!loadedSim) {
    ctx.ui.notify("No sim loaded.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Reset training data?",
    `Delete all local training data for ${loadedSim.name}?`,
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }
  const removed = clearTrainingLabState(loadedSim.rkey);
  ctx.ui.notify(
    removed ? `Training data reset for ${loadedSim.name}.` : "No training data on disk.",
    "info",
  );
}
