/**
 * `/sim train apply` — merge the distilled profile into the sim's
 * existing constitution + short description. PR 2 prints the result
 * and copies it to the system clipboard so the user can paste it
 * into simocracy.org. PR 3 will write to the user's PDS when
 * `--apply` is passed and the user is signed in.
 *
 * Mirrors `/api/training/merge-constitution` from simocracy-v2.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { LoadedSim } from "../persona.ts";
import { openRouterComplete, TRAINING_REASONING_MODEL } from "../openrouter.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./storage.ts";
import { clampConstitution, wrapAsData } from "./prompt-helpers.ts";
import { TRAINING_MERGE_CONSTITUTION_SYSTEM_PROMPT } from "./prompts.ts";
import type { TrainingProfile } from "./types.ts";

export interface MergeOutput {
  shortDescription: string;
  description: string;
}

export async function runApply(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<MergeOutput | null> {
  const state = loadTrainingLabState(loadedSim.rkey);
  if (!state.profile) {
    ctx.ui.notify("Need a profile first — run `/sim train profile`.", "warning");
    return null;
  }

  ctx.ui.notify("Merging profile into constitution (this may take a few seconds)…", "info");
  let merged: MergeOutput;
  try {
    merged = await mergeConstitution(loadedSim, state.profile);
  } catch (err) {
    ctx.ui.notify(`Merge failed: ${(err as Error).message}`, "error");
    return null;
  }

  // No state mutation here — the canonical record lives on the user's
  // PDS, and PR 3 wires up the actual write. We re-save state so the
  // updatedAt bumps for /sim train status.
  saveTrainingLabState(loadedSim.rkey, state);

  console.log("");
  console.log(`Short description:`);
  console.log(merged.shortDescription);
  console.log("");
  console.log(`Constitution (markdown):`);
  console.log(merged.description);
  console.log("");

  const clipboardPayload = formatClipboard(merged);
  const copied = await copyToClipboard(clipboardPayload);
  if (copied) {
    ctx.ui.notify(
      `Copied to clipboard. Paste into the constitution editor at https://simocracy.org/sims/${loadedSim.did}/${loadedSim.rkey}.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      "Could not copy to clipboard — copy the printed output manually.",
      "warning",
    );
  }
  return merged;
}

export async function mergeConstitution(
  loadedSim: LoadedSim,
  profile: TrainingProfile,
): Promise<MergeOutput> {
  const userPrompt = [
    `simName: ${loadedSim.name}`,
    wrapAsData(
      "existingConstitution",
      loadedSim.description?.trim()
        ? clampConstitution(loadedSim.description)
        : "(empty — write one from scratch using the profile)",
    ),
    wrapAsData(
      "existingShortDescription",
      loadedSim.shortDescription?.trim() || "(none)",
    ),
    wrapAsData("speakingStyle", loadedSim.style?.trim() || "(none)"),
    wrapAsData("trainingProfile", JSON.stringify(profile, null, 2)),
  ].join("\n\n");

  const content = await openRouterComplete(
    [
      { role: "system", content: TRAINING_MERGE_CONSTITUTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { model: TRAINING_REASONING_MODEL, maxTokens: 4000, temperature: 0.4 },
  );

  return parseMergeOutput(content, profile);
}

/**
 * Mirrors `parseMergeOutput` in
 * `simocracy-v2/app/api/training/merge-constitution/route.ts`. Tolerates
 * a missing separator (uses profile.summary as the short description).
 */
export function parseMergeOutput(
  content: string,
  profile: TrainingProfile,
): MergeOutput {
  const lines = content.split("\n");
  const separatorIdx = lines.findIndex((line) => line.trim() === "---");

  let shortDescription: string;
  let description: string;
  if (separatorIdx > 0) {
    shortDescription = lines.slice(0, separatorIdx).join("\n").trim();
    description = lines.slice(separatorIdx + 1).join("\n").trim();
  } else {
    description = content.trim();
    shortDescription = profile.summary?.trim() || "";
  }

  if (shortDescription.length > 300) {
    shortDescription = `${shortDescription.slice(0, 297).trimEnd()}…`;
  }
  return { shortDescription, description };
}

function formatClipboard(merged: MergeOutput): string {
  return [
    "## Short description",
    merged.shortDescription,
    "",
    "## Constitution",
    merged.description,
  ].join("\n");
}

/** Best-effort clipboard copy. No new npm deps — shells out per-OS. */
async function copyToClipboard(text: string): Promise<boolean> {
  const cmd = clipboardCommand();
  if (!cmd) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin?.end(text);
    } catch {
      resolve(false);
    }
  });
}

function clipboardCommand(): { command: string; args: string[] } | null {
  const os = platform();
  if (os === "darwin") return { command: "pbcopy", args: [] };
  if (os === "win32") return { command: "clip", args: [] };
  // Linux — try xclip, then xsel, then wl-copy. We only return one;
  // callers fall back to "couldn't copy" if it fails to run.
  return { command: "xclip", args: ["-selection", "clipboard"] };
}
