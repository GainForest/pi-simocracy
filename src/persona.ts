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
  /**
   * Pre-encoded PNG of the sim's sprite (idle frame), for inline
   * terminal graphics protocols (Kitty, iTerm2). Present when sprite
   * rendering succeeded and the source could be encoded; the renderer
   * uses this when the host terminal advertises image support and
   * falls back to `spriteAnsi` otherwise.
   */
  spritePng?: {
    /** base64-encoded PNG bytes (no `data:` prefix). */
    base64: string;
    /** Native PNG width in pixels (used for aspect ratio). */
    widthPx: number;
    /** Native PNG height in pixels. */
    heightPx: number;
  };
  /**
   * Pre-encoded PNG frames of the sim's idle animation, for terminals
   * that support inline graphics. When present **and** the renderer's
   * animation timer is active for this sim, the message renderer
   * cycles through these instead of repeating `spritePng` — producing
   * a gentle in-chat idle loop using the same Kitty-protocol
   * in-place image swap that pi-tui's spinner uses to animate.
   *
   * Currently populated only for `codexPet` sims (their atlas defines
   * an explicit 6-frame idle row); pipoya and image-fallback sims
   * stay static.
   */
  spriteFrames?: {
    /** base64-encoded PNG bytes per frame, in display order. */
    pngBase64: string[];
    /** Display rate in frames-per-second. */
    fps: number;
    /** Native PNG width in pixels (uniform across all frames). */
    widthPx: number;
    /** Native PNG height in pixels. */
    heightPx: number;
  };
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
