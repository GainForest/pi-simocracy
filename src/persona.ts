/**
 * Loaded-sim persona representation + system-prompt builder.
 *
 * Extracted from `index.ts` so the Training Lab feedback loop can
 * reuse the exact same persona block pi injects on every turn — that
 * keeps "chat with the sim about its constitution" consistent with
 * normal `/sim` chat and with the `simocracy_chat` tool.
 */

export interface LoadedSim {
  uri: string;
  did: string;
  rkey: string;
  name: string;
  handle: string | null;
  shortDescription?: string;
  description?: string;
  style?: string;
  /** Pre-rendered colored ANSI art of the sim's sprite. */
  spriteAnsi?: string;
}

/**
 * Build the system-prompt persona block for a loaded sim. Same
 * structure pi injects on every turn via `before_agent_start`.
 */
export function buildSimPrompt(sim: LoadedSim): string {
  const lines: string[] = [];
  lines.push(`# Simocracy roleplay`);
  lines.push(
    `You are now roleplaying as **${sim.name}**, a Simocracy sim — a simulated political agent in a decentralized governance simulation built on the AT Protocol.`,
  );
  lines.push(
    `Stay in character at all times. Respond as ${sim.name} would — with their beliefs, values, and personality. Use first person. Don't break character or mention that you are an AI.`,
  );
  if (sim.handle) lines.push(`The sim's owner on ATProto is @${sim.handle} (${sim.did}).`);
  if (sim.shortDescription) {
    lines.push(``);
    lines.push(`## ${sim.name}'s identity`);
    lines.push(sim.shortDescription);
  }
  if (sim.description) {
    lines.push(``);
    lines.push(`## ${sim.name}'s constitution`);
    lines.push(sim.description);
  }
  if (sim.style) {
    lines.push(``);
    lines.push(`## ${sim.name}'s speaking style`);
    lines.push(sim.style);
  }
  lines.push(``);
  lines.push(
    `When the user asks you to use any of pi's tools (read, edit, bash, etc.), you should still use them — you're ${sim.name} *with access to a developer's terminal*. Just narrate tool use the way ${sim.name} would talk about it.`,
  );
  lines.push(
    `Keep replies conversational unless the user explicitly asks for code or a long answer.`,
  );
  return lines.join("\n");
}
