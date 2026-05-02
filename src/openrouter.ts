/**
 * Minimal OpenRouter chat client used as a fallback for the `simocracy_chat`
 * tool when the user wants to talk to a sim through pi without injecting a
 * persona into the agent's system prompt.
 *
 * Reads OPENROUTER_API_KEY from the environment.
 */

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function openRouterComplete(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number; temperature?: number; apiKey?: string } = {},
): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it or run with `OPENROUTER_API_KEY=... pi`.",
    );
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://simocracy.org",
      "X-Title": "pi-simocracy",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.85,
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content;
}
