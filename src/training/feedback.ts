/**
 * `/sim train feedback` — free-form chat with the loaded sim about
 * its constitution. Same pattern as `/sim train chat` but uses the
 * regular sim persona prompt (`buildSimPrompt`) — i.e., the sim
 * speaks in character — so the user gets real feedback on how the
 * sim sounds, then can use the transcript to inform an Apply step.
 *
 * Web parity: `simocracy-v2/components/sim/training-lab/feedback-tab.tsx`.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { buildSimPrompt, type LoadedSim } from "../persona.ts";
import { openRouterComplete, TRAINING_CHAT_MODEL } from "../openrouter.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./storage.ts";
import type { FeedbackTurn } from "./types.ts";

export async function runFeedback(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<void> {
  let state = loadTrainingLabState(loadedSim.rkey);
  let turns: FeedbackTurn[] = state.feedbackTurns ?? [];

  ctx.ui.notify(
    `Free-form chat with ${loadedSim.name}. Type /done to end. Transcript persists for the Apply step.`,
    "info",
  );
  if (turns.length > 0) {
    ctx.ui.notify(`Loaded ${turns.length} prior feedback turns from disk.`, "info");
  }

  for (;;) {
    const userMessage = await ctx.ui.input(
      `Ask ${loadedSim.name} (or /done to finish)`,
      "Your message",
    );
    if (userMessage === undefined) break;
    const trimmed = userMessage.trim();
    if (!trimmed) continue;
    if (trimmed === "/done" || trimmed === "/exit" || trimmed === "/quit") break;

    turns = [...turns, { role: "user", content: trimmed }];
    state = { ...state, feedbackTurns: turns };
    saveTrainingLabState(loadedSim.rkey, state);

    let reply: string;
    try {
      reply = await callSimChat(loadedSim, turns);
    } catch (err) {
      ctx.ui.notify(`OpenRouter error: ${(err as Error).message}`, "error");
      break;
    }
    if (!reply) {
      ctx.ui.notify("Empty model response. Try again or /done.", "warning");
      continue;
    }
    console.log(`\n${loadedSim.name}: ${reply}\n`);
    turns = [...turns, { role: "assistant", content: reply }];
    state = { ...state, feedbackTurns: turns };
    saveTrainingLabState(loadedSim.rkey, state);
  }

  ctx.ui.notify(`Saved ${turns.length} feedback turns.`, "info");
}

async function callSimChat(loadedSim: LoadedSim, turns: FeedbackTurn[]): Promise<string> {
  const systemPrompt = buildSimPrompt(loadedSim);
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...turns.map((t) => ({ role: t.role, content: t.content })),
  ];
  return openRouterComplete(messages, {
    model: TRAINING_CHAT_MODEL,
    maxTokens: 600,
    temperature: 0.7,
  });
}
