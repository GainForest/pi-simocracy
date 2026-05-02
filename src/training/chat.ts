/**
 * `/sim train chat` — adaptive interview turn loop.
 *
 * Mirrors `/api/training/next-question` from simocracy-v2 but calls
 * OpenRouter directly (no pi loop / persona injection). End the chat
 * by typing `/done` (or cancelling the prompt).
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
import { buildNextQuestionSystemPrompt } from "./prompts.ts";
import type { InterviewTurn } from "./types.ts";

export async function runChat(
  ctx: ExtensionCommandContext,
  loadedSim: LoadedSim,
): Promise<void> {
  let state = loadTrainingLabState(loadedSim.rkey);
  const proposals = state.questionSet?.proposals ?? [];

  if (proposals.length === 0) {
    ctx.ui.notify(
      "Run `/sim train baseline` first — chat needs a baseline questionnaire to ground its questions.",
      "warning",
    );
    return;
  }

  ctx.ui.notify(
    `Chatting with ${loadedSim.name}. Type /done to end the conversation.`,
    "info",
  );

  // Always print the existing transcript so the user has context.
  if (state.interviewTurns.length > 0) {
    ctx.ui.notify(
      `Loaded ${state.interviewTurns.length} prior turns from disk.`,
      "info",
    );
  }

  // Prime the assistant with the first question if the transcript is empty.
  if (state.interviewTurns.length === 0) {
    const reply = await callNextQuestion(loadedSim, state.interviewTurns, state, proposals);
    if (reply) {
      console.log(`\n${loadedSim.name}: ${reply}\n`);
      state = appendTurn(state, { role: "assistant", content: reply });
      saveTrainingLabState(loadedSim.rkey, state);
    }
  }

  for (;;) {
    const userMessage = await ctx.ui.input(
      `Reply to ${loadedSim.name} (or /done to finish)`,
      "Your reply",
    );
    if (userMessage === undefined) break;
    const trimmed = userMessage.trim();
    if (!trimmed) continue;
    if (trimmed === "/done" || trimmed === "/exit" || trimmed === "/quit") break;

    state = appendTurn(state, { role: "user", content: trimmed });
    saveTrainingLabState(loadedSim.rkey, state);

    let reply: string;
    try {
      reply = await callNextQuestion(loadedSim, state.interviewTurns, state, proposals);
    } catch (err) {
      ctx.ui.notify(`OpenRouter error: ${(err as Error).message}`, "error");
      break;
    }
    if (!reply) {
      ctx.ui.notify("Empty model response. Try again or /done.", "warning");
      continue;
    }
    console.log(`\n${loadedSim.name}: ${reply}\n`);
    state = appendTurn(state, { role: "assistant", content: reply });
    saveTrainingLabState(loadedSim.rkey, state);
  }

  ctx.ui.notify(
    `Saved ${state.interviewTurns.length} turns. Run \`/sim train profile\` to distill.`,
    "info",
  );
}

async function callNextQuestion(
  loadedSim: LoadedSim,
  transcript: InterviewTurn[],
  state: ReturnType<typeof loadTrainingLabState>,
  proposals: { id: string; title: string; summary: string; topic: string }[],
): Promise<string> {
  const system = buildNextQuestionSystemPrompt(loadedSim.name, loadedSim.style);
  const constitution = clampConstitution(loadedSim.description);
  const baseline = renderBaselineForPrompt(state.baselineVotes, proposals);
  const clamped = clampTranscript(transcript);

  const userPrompt = [
    `simName: ${loadedSim.name}`,
    wrapAsData("existingConstitution", constitution),
    wrapAsData("baselineQuestionnaire", baseline),
    wrapAsData("transcript", JSON.stringify(clamped, null, 2)),
  ].join("\n\n");

  return openRouterComplete(
    [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    { model: TRAINING_CHAT_MODEL, maxTokens: 600, temperature: 0.6 },
  );
}

function appendTurn<T extends { interviewTurns: InterviewTurn[] }>(
  state: T,
  turn: InterviewTurn,
): T {
  return { ...state, interviewTurns: [...state.interviewTurns, turn] };
}
