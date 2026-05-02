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
import { readAuth } from "../auth/storage.ts";
import { resolveHandle } from "../simocracy.ts";
import {
  createAgents,
  findRkeyForSim,
  getAuthenticatedAgent,
  NotSignedInError,
  updateAgents,
} from "../writes.ts";
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
  opts: { apply?: boolean } = {},
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

  // Re-save state so the updatedAt bumps for /sim train status; the
  // canonical record still lives on the user's PDS.
  saveTrainingLabState(loadedSim.rkey, state);

  console.log("");
  console.log(`Short description:`);
  console.log(merged.shortDescription);
  console.log("");
  console.log(`Constitution (markdown):`);
  console.log(merged.description);
  console.log("");

  if (opts.apply) {
    const written = await writeAgentsToPds(ctx, loadedSim, merged);
    if (written) return merged;
    return null;
  }

  const clipboardPayload = formatClipboard(merged);
  const copied = await copyToClipboard(clipboardPayload);
  if (copied) {
    ctx.ui.notify(
      `Copied to clipboard. Paste into the constitution editor at https://simocracy.org/sims/${loadedSim.did}/${loadedSim.rkey}, or re-run with --apply once you've signed in via /login.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      "Could not copy to clipboard — copy the printed output manually, or sign in via /login and re-run with --apply.",
      "warning",
    );
  }
  return merged;
}

/**
 * Write the merged constitution to the user's PDS via OAuth. Enforces
 * the owner check (loaded sim's DID must match the signed-in DID).
 * Returns true on success.
 */
async function writeAgentsToPds(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
  merged: MergeOutput,
): Promise<boolean> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify("Not signed in. Run /login first.", "error");
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
    if (err instanceof NotSignedInError) {
      ctx.ui.notify(err.message, "error");
    } else {
      ctx.ui.notify(`Auth failed: ${(err as Error).message}`, "error");
    }
    return false;
  }

  const existingRkey = await findRkeyForSim(
    agent,
    auth.did,
    "org.simocracy.agents",
    loadedSim.uri,
  ).catch(() => null);

  ctx.ui.notify(
    existingRkey
      ? `Updating org.simocracy.agents (${existingRkey})…`
      : "Creating org.simocracy.agents…",
    "info",
  );
  try {
    if (existingRkey) {
      await updateAgents({
        agent,
        did: auth.did,
        rkey: existingRkey,
        simUri: loadedSim.uri,
        simCid: "", // CID required by lexicon validators is permissive — empty is acceptable for a fresh write here.
        shortDescription: merged.shortDescription,
        description: merged.description,
      });
    } else {
      await createAgents({
        agent,
        did: auth.did,
        simUri: loadedSim.uri,
        simCid: "",
        shortDescription: merged.shortDescription,
        description: merged.description,
      });
    }
  } catch (err) {
    ctx.ui.notify(`PDS write failed: ${(err as Error).message}`, "error");
    return false;
  }

  ctx.ui.notify(
    `Wrote constitution to ${auth.handle ? `@${auth.handle}` : auth.did}'s PDS. Refresh https://simocracy.org/sims/${loadedSim.did}/${loadedSim.rkey} to see it.`,
    "info",
  );
  return true;
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
