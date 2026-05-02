/**
 * pi-simocracy — load a Simocracy sim into your pi chat, train its
 * constitution, and write it back to your ATProto PDS.
 *
 * Sim commands:
 *  - `/sim <name>`        Load a sim by name (fuzzy search on the indexer).
 *                         Renders the sprite inline as colored ANSI art and
 *                         pushes the sim's constitution + style into the
 *                         system prompt so pi roleplays as the sim.
 *  - `/sim unload`        Drop the loaded sim and stop roleplaying.
 *  - `/sim status`        Show the currently loaded sim, if any.
 *
 * Constitution training (works on the loaded sim):
 *  - `/sim interview [name] [--apply]`
 *        Adaptive AI interview that derives a sim's constitution +
 *        speaking style from your answers. With `--apply` writes them
 *        back to your PDS (requires `/sim login`).
 *  - `/sim train baseline`
 *        Vote yes/no/abstain on sample proposals (5+ recommended).
 *  - `/sim train chat`
 *        Conversational training round — the sim asks targeted
 *        questions about gaps it sees in the baseline votes.
 *  - `/sim train profile`
 *        Distill the baseline + chat transcript into a structured
 *        TrainingProfile (priorities, red lines, tradeoffs).
 *  - `/sim train alignment`
 *        Score the sim against your hidden baseline and report match%.
 *  - `/sim train apply [--apply]`
 *        Merge the profile into the constitution. Without `--apply`
 *        copies the merged markdown to clipboard. With `--apply`
 *        writes to your PDS (requires `/sim login`).
 *  - `/sim train feedback`, `status`, `reset`
 *        Free-form feedback chat, status, and clear local state.
 *
 * ATProto sign-in ("sign in with Bluesky / ATProto", NOT Anthropic):
 *  - `/sim login [handle]`
 *        Loopback OAuth flow — opens your PDS's authorize page in the
 *        browser, grants this CLI a DPoP-bound session, persists it to
 *        ~/.config/pi-simocracy/auth.json. Required before `--apply`
 *        writes records to your repo.
 *  - `/sim logout`        Clear the local OAuth session.
 *  - `/sim whoami`        Show the currently signed-in ATProto handle/DID.
 *
 * Tools (LLM-callable):
 *  - `simocracy_load_sim`           Same as /sim <name>.
 *  - `simocracy_unload_sim`         Same as /sim unload.
 *  - `simocracy_chat`               One-shot chat with a sim via
 *                                   OpenRouter (does not change the
 *                                   active session persona).
 *  - `simocracy_run_interview`      Run /sim interview programmatically.
 *  - `simocracy_derive_constitution`
 *                                   Given interview answers, return the
 *                                   derived constitution + style.
 *  - `simocracy_training_profile`   Distill baseline + transcript into
 *                                   a TrainingProfile.
 *  - `simocracy_alignment_test`     Score a profile against a baseline.
 *
 * Note on /login: pi itself ships a built-in `/login` for Anthropic OAuth.
 * To avoid the collision (and to make it explicit you're signing into
 * ATProto, not Anthropic), all auth commands here are namespaced under
 * `/sim`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  searchSimsByName,
  fetchAgentsForSim,
  fetchStyleForSim,
  fetchBlob,
  resolveHandle,
  parseAtUri,
  type AgentsRecord,
  type SimMatch,
  type StyleRecord,
} from "./simocracy.ts";
import {
  decodePng,
  renderRgbaToAnsi,
  cropRgba,
  detectPixelArtScale,
  downscaleRgbaNearest,
} from "./png-to-ansi.ts";
import { openRouterComplete, type ChatMessage } from "./openrouter.ts";
import { buildSimPrompt, type LoadedSim } from "./persona.ts";
import { runTrainCommand } from "./training/index.ts";
import {
  runInterviewFlow,
  snapshotInterviewTemplate,
  deriveFromInterview,
} from "./interview.ts";
import { deriveProfile, printProfile } from "./training/profile.ts";
import {
  loadTrainingLabState,
  saveTrainingLabState,
} from "./training/storage.ts";
import { scoreAlignment, printAlignment } from "./training/alignment.ts";
import type {
  AlignmentResult,
  BaselineProposal,
  BaselineVote,
  InterviewTurn,
  TrainingProfile,
  Vote,
} from "./training/types.ts";
import { runLogin, runLogout, runWhoami } from "./auth/commands.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let loadedSim: LoadedSim | null = null;
/**
 * Name of the most recently unloaded sim, if any. Cleared after the next
 * agent turn fires — used to inject a one-shot “stop roleplaying” override
 * into the system prompt so the model breaks character even though its
 * previous in-character replies are still in the conversation history.
 */
let justUnloaded: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blobLink(ref: unknown): string | null {
  if (ref && typeof ref === "object" && "$link" in (ref as Record<string, unknown>)) {
    const l = (ref as { $link?: unknown }).$link;
    if (typeof l === "string") return l;
  }
  return null;
}

/**
 * Render a sim's sprite at its native 32×32 size as colored ANSI
 * half-block art — 16 cells tall, 32 cells wide. Compact enough to fit
 * comfortably in a terminal alongside the loaded-sim message.
 *
 * Pulls the front-facing walk1 frame (row 0, col 0) from the 128×128
 * sprite-sheet blob. Falls back to the static avatar PNG if no sheet
 * is published for this sim.
 */
async function renderSpriteAnsi(sim: SimMatch): Promise<string | null> {
  const spriteLink = blobLink(sim.sim.sprite?.ref);
  const imageLink = blobLink(sim.sim.image?.ref);

  if (spriteLink) {
    try {
      const buf = await fetchBlob(sim.did, spriteLink);
      const { width, height, data } = decodePng(buf);
      const FRAME = 32;
      if (width >= FRAME && height >= FRAME) {
        // Sheets are 4×4 of 32×32 frames — row 0 col 0 = front-facing walk1.
        const frame = cropRgba(data, width, height, 0, 0, FRAME, FRAME);
        return renderRgbaToAnsi(frame, FRAME, FRAME, {
          cropToContent: true,
          cropPad: 1,
          indent: 2,
          alphaThreshold: 16,
        });
      }
      return renderRgbaToAnsi(data, width, height, {
        cropToContent: true,
        cropPad: 1,
        indent: 2,
        alphaThreshold: 16,
      });
    } catch {
      /* fall through to avatar */
    }
  }

  if (imageLink) {
    try {
      const buf = await fetchBlob(sim.did, imageLink);
      const { width, height, data } = decodePng(buf);
      // Old sims (pre-sprite-sheet) only have the avatar PNG, which
      // simocracy.org renders by 4×-upscaling a native 32×32 sprite into
      // a 128×128 image with nearest-neighbour. Detect that and downsample
      // back to the original size so the inline render is the same
      // ~13-line height as a sprite-sheet-equipped sim instead of
      // ballooning to ~22 lines and pushing chat off-screen.
      const scale = detectPixelArtScale(data, width, height, 8);
      const native =
        scale > 1 ? downscaleRgbaNearest(data, width, height, scale) : { data, width, height };
      return renderRgbaToAnsi(native.data, native.width, native.height, {
        cropToContent: true,
        cropPad: 1,
        indent: 2,
        alphaThreshold: 16,
      });
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function loadSimByName(query: string): Promise<{
  matches: SimMatch[];
  loaded?: LoadedSim;
  error?: string;
}> {
  let matches: SimMatch[];
  try {
    matches = await searchSimsByName(query, { maxResults: 8 });
  } catch (err) {
    return { matches: [], error: `Indexer search failed: ${(err as Error).message}` };
  }
  if (matches.length === 0) {
    return { matches: [], error: `No sim found matching "${query}".` };
  }
  return { matches };
}

async function hydrateLoadedSim(match: SimMatch): Promise<LoadedSim> {
  // Fetch agents (constitution), style, sprite ANSI + handle in parallel.
  const [agents, style, spriteAnsi, handle] = await Promise.all([
    fetchAgentsForSim(match.uri).catch(() => null) as Promise<AgentsRecord | null>,
    fetchStyleForSim(match.uri).catch(() => null) as Promise<StyleRecord | null>,
    renderSpriteAnsi(match).catch(() => null),
    resolveHandle(match.did).catch(() => null),
  ]);

  return {
    uri: match.uri,
    did: match.did,
    rkey: match.rkey,
    name: match.sim.name,
    handle,
    spriteAnsi: spriteAnsi ?? undefined,
    shortDescription: agents?.shortDescription,
    description: agents?.description,
    style: style?.description,
  };
}

function formatSimSummary(
  sim: LoadedSim,
  theme?: ExtensionContext["ui"]["theme"],
): string {
  const dim = theme?.fg("dim", "") ? (s: string) => theme.fg("dim", s) : (s: string) => s;
  const accent = theme?.fg("accent", "")
    ? (s: string) => theme.fg("accent", s)
    : (s: string) => s;
  const lines: string[] = [];
  if (sim.spriteAnsi) {
    lines.push(sim.spriteAnsi);
    lines.push("");
  }
  lines.push(`  🐾 ${accent(sim.name)}${sim.handle ? dim(`  @${sim.handle}`) : ""} loaded—pi is now in character.`);
  lines.push(dim(`  ${sim.uri}`));
  if (sim.shortDescription) {
    lines.push("");
    lines.push("  " + sim.shortDescription.split("\n").join("\n  "));
  }
  return lines.join("\n");
}

// The OpenTUI standalone animated viewer used to live here. It now ships
// alongside this file as `viewer.ts` for anyone who wants the full-window
// experience — run it manually with:
//
//     bun src/viewer.ts /tmp/pi-simocracy/<rkey>.json
//
// The default `/sim` flow renders inline ANSI art instead, so pi keeps the
// terminal it's already running in.

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const LoadSimToolParams = Type.Object({
  query: Type.String({
    description: "Sim name or AT-URI (at://did/org.simocracy.sim/rkey).",
    minLength: 1,
  }),
});

const ChatToolParams = Type.Object({
  message: Type.String({ description: "Message to send to the sim.", minLength: 1 }),
  query: Type.Optional(
    Type.String({
      description:
        "Sim name to chat with. Defaults to the currently loaded sim if omitted.",
    }),
  ),
});

const UnloadToolParams = Type.Object({});

const RunInterviewToolParams = Type.Object({
  sim: Type.Optional(
    Type.String({
      description:
        "Sim name or AT-URI to interview. Defaults to the currently loaded sim if omitted.",
    }),
  ),
  templateUri: Type.Optional(
    Type.String({
      description:
        "AT-URI of an `org.simocracy.interviewTemplate` to use. Skips the picker.",
    }),
  ),
});

const OpenAnswerSchema = Type.Object({
  question: Type.String(),
  answer: Type.String(),
});
const YesNoAnswerSchema = Type.Object({
  statement: Type.String(),
  answer: Type.Boolean(),
});

const DeriveConstitutionToolParams = Type.Object({
  openAnswers: Type.Optional(Type.Array(OpenAnswerSchema)),
  yesNoAnswers: Type.Optional(Type.Array(YesNoAnswerSchema)),
});

const BaselineProposalSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  topic: Type.String(),
});
const BaselineVoteSchema = Type.Object({
  proposalId: Type.String(),
  vote: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("abstain")]),
  importance: Type.Number(),
  reasoning: Type.String(),
});
const InterviewTurnSchema = Type.Object({
  role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
  content: Type.String(),
  target: Type.Optional(Type.String()),
});
const IssuePrioritySchema = Type.Object({
  issue: Type.String(),
  stance: Type.String(),
  importance: Type.Number(),
  negotiability: Type.Number(),
  confidence: Type.Number(),
});
const TrainingProfileSchema = Type.Object({
  summary: Type.String(),
  coreValues: Type.Array(Type.String()),
  issuePriorities: Type.Array(IssuePrioritySchema),
  redLines: Type.Array(Type.String()),
  acceptableTradeoffs: Type.Array(Type.String()),
  uncertaintyAreas: Type.Array(Type.String()),
  representationRules: Type.Array(Type.String()),
});

const TrainingProfileToolParams = Type.Object({
  simName: Type.String({ description: "The sim's display name." }),
  existingConstitution: Type.Optional(Type.String()),
  baselineVotes: Type.Array(BaselineVoteSchema),
  baselineProposals: Type.Array(BaselineProposalSchema),
  transcript: Type.Array(InterviewTurnSchema),
});

const AlignmentProposalSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  topic: Type.String(),
  userVote: Type.Union([
    Type.Literal("yes"),
    Type.Literal("no"),
    Type.Literal("abstain"),
  ]),
});

const AlignmentTestToolParams = Type.Object({
  simName: Type.String({ description: "The sim's display name." }),
  existingConstitution: Type.Optional(Type.String()),
  profile: TrainingProfileSchema,
  proposals: Type.Array(AlignmentProposalSchema),
});

export default async function simocracy(pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // System prompt injection — every turn the loaded sim's persona is appended.
  // After an unload, a one-shot override fires on the very next turn to break
  // character (otherwise the model imitates its own previous in-character
  // replies that are still in the conversation history).
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (loadedSim) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildSimPrompt(loadedSim)}`,
      };
    }
    if (justUnloaded) {
      const formerName = justUnloaded;
      justUnloaded = null;
      const override = [
        ``,
        `# Roleplay ended`,
        `You were previously roleplaying as **${formerName}**, a Simocracy sim. That roleplay session has ended.`,
        `Drop the persona completely. Stop using ${formerName}'s speaking style, mannerisms, catchphrases, emoji, or vocabulary.`,
        `Resume your default behavior as pi, a coding assistant. Speak in your normal neutral voice from now on.`,
        `Earlier turns in this conversation will contain in-character replies from when ${formerName} was loaded — ignore that style; do not continue it.`,
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}${override}` };
    }
    return;
  });

  // -------------------------------------------------------------------------
  // Custom message renderer — shows the sprite + bio inline in the chat.
  // -------------------------------------------------------------------------
  pi.registerMessageRenderer<{ body: string }>("simocracy_sim_loaded", (message) => {
    const body =
      (message.details as { body?: string } | undefined)?.body ??
      (typeof message.content === "string" ? message.content : "");
    return new Text(body, 0, 0);
  });

  // -------------------------------------------------------------------------
  // Slash command: /sim
  //
  // All extension commands are namespaced under /sim to avoid colliding
  // with pi's built-in slash commands (notably `/login` for Anthropic
  // OAuth and `/logout`). That namespacing also makes it unambiguous to
  // users that `/sim login` signs them into their ATProto / Bluesky
  // account, NOT into Anthropic.
  // -------------------------------------------------------------------------
  pi.registerCommand("sim", {
    description:
      "Simocracy: load/train sims, sign into ATProto. `/sim help` for the full list.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg || arg === "help" || arg === "--help") {
        ctx.ui.notify(
          "Sim:\n" +
            "  /sim <name>            load a sim (e.g. /sim mr meow)\n" +
            "  /sim unload            stop roleplaying\n" +
            "  /sim status            show currently loaded sim\n" +
            "\n" +
            "Constitution training (operates on the loaded sim):\n" +
            "  /sim interview [name]  adaptive interview → derive constitution\n" +
            "  /sim train baseline    vote on sample proposals\n" +
            "  /sim train chat        conversational training round\n" +
            "  /sim train profile     distill votes + chat → TrainingProfile\n" +
            "  /sim train alignment   score sim against your baseline\n" +
            "  /sim train apply       merge profile into constitution\n" +
            "  /sim train status|reset|feedback\n" +
            "\n" +
            "Sign in with ATProto / Bluesky (not Anthropic — pi's built-in /login\n" +
            "does that). Required before `--apply` writes to your PDS:\n" +
            "  /sim login [handle]    OAuth loopback flow (e.g. /sim login alice.bsky.social)\n" +
            "  /sim logout            clear local session\n" +
            "  /sim whoami            show signed-in handle/DID",
          "info",
        );
        return;
      }
      // ATProto auth subcommands — must come BEFORE the sim-name
      // fallthrough (`runLoadFlow`) so we don't accidentally treat
      // "login" as a sim name to load from the indexer.
      if (arg === "login" || arg.startsWith("login ") || arg.startsWith("login\t")) {
        const rest = arg.slice("login".length).trim();
        await runLogin(ctx, rest);
        return;
      }
      if (arg === "logout") {
        await runLogout(ctx);
        return;
      }
      if (arg === "whoami") {
        await runWhoami(ctx);
        return;
      }
      if (arg === "unload" || arg === "clear") {
        if (!loadedSim) {
          ctx.ui.notify("No sim loaded.", "info");
          return;
        }
        const name = loadedSim.name;
        loadedSim = null;
        justUnloaded = name;
        ctx.ui.setStatus("simocracy", undefined);
        ctx.ui.setWidget("simocracy", undefined);
        ctx.ui.notify(`Unloaded ${name}. Pi will break character on the next reply.`, "info");
        return;
      }
      if (arg === "status") {
        if (!loadedSim) {
          ctx.ui.notify("No sim loaded. Try `/sim mr meow`.", "info");
          return;
        }
        await postSimToChat(pi, ctx, loadedSim, /*reload=*/ false);
        return;
      }
      if (arg === "interview" || arg.startsWith("interview ") || arg.startsWith("interview\t")) {
        const rest = arg.slice("interview".length).trim();
        // Strip recognised flags (--apply) and use the rest as a sim name.
        const tokens = rest.split(/\s+/).filter(Boolean);
        const apply = tokens.includes("--apply");
        const nameTokens = tokens.filter((t) => !t.startsWith("--"));
        const simName = nameTokens.join(" ").trim();
        if (simName && !loadedSim) {
          const sim = await tryLoadFromQuery(simName);
          if (!sim) {
            ctx.ui.notify(`No sim found matching "${simName}".`, "error");
            return;
          }
          loadedSim = sim;
          await postSimToChat(pi, ctx, sim, /*reload=*/ true);
        }
        if (!loadedSim) {
          ctx.ui.notify("No sim loaded. Use `/sim <name>` first or pass a name to `/sim interview <name>`.", "error");
          return;
        }
        await runInterviewFlow(pi, ctx, loadedSim, { apply });
        return;
      }
      if (arg === "train" || arg.startsWith("train ") || arg.startsWith("train\t")) {
        const rest = arg.slice("train".length).trim();
        await runTrainCommand(ctx, rest, loadedSim);
        return;
      }
      await runLoadFlow(pi, ctx, arg);
    },
  });

  // -------------------------------------------------------------------------
  // (Removed) top-level /login, /logout, /whoami slash commands.
  //
  // These collided with pi's own built-in `/login` (Anthropic OAuth) and
  // `/logout`, which made pi emit "Skipping in autocomplete" warnings on
  // every boot and silently degraded discoverability of these handlers.
  // The auth flow now lives under `/sim login`, `/sim logout`,
  // `/sim whoami` — no collision, and the namespacing makes it explicit
  // to users that they're signing into their ATProto / Bluesky account,
  // not Anthropic. See the dispatcher in the `/sim` registerCommand
  // above.
  //
  // The `runLogin` / `runLogout` / `runWhoami` helpers in src/auth/
  // commands.ts are unchanged — only the slash-command surface moved.
  // -------------------------------------------------------------------------
  // (no top-level registration — the auth helpers `runLogin`, `runLogout`,
  // `runWhoami` are dispatched from inside the `/sim` handler above.)

  // -------------------------------------------------------------------------
  // Tool: simocracy_load_sim
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_load_sim",
    label: "Load Simocracy sim",
    description:
      "Load a Simocracy sim by name into the current pi session. Pi will stay in character as that sim until simocracy_unload_sim is called. Renders the sim's sprite in the terminal and injects the sim's constitution + speaking style into the system prompt.",
    parameters: LoadSimToolParams,
    async execute(_id, { query }, _signal, _onUpdate, ctx) {
      const sim = await tryLoadFromQuery(query);
      if (!sim) {
        throw new Error(`No sim found matching "${query}".`);
      }
      loadedSim = sim;
      if (ctx.hasUI) {
        await postSimToChat(pi, ctx, sim, /*reload=*/ true);
      }
      const summary = [
        `Loaded sim: ${sim.name}${sim.handle ? ` (@${sim.handle})` : ""}`,
        `URI: ${sim.uri}`,
        sim.shortDescription ? `\nShort description:\n${sim.shortDescription}` : "",
        sim.description ? `\nConstitution:\n${sim.description}` : "",
        sim.style ? `\nSpeaking style:\n${sim.style}` : "",
        `\nFrom now on, stay in character as ${sim.name}.`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { uri: sim.uri, did: sim.did, rkey: sim.rkey, name: sim.name },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_unload_sim
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_unload_sim",
    label: "Unload Simocracy sim",
    description:
      "Stop roleplaying as the currently loaded Simocracy sim. After this call, pi reverts to its default behavior.",
    parameters: UnloadToolParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!loadedSim) {
        return {
          content: [{ type: "text" as const, text: "No sim loaded." }],
          details: {},
        };
      }
      const name = loadedSim.name;
      loadedSim = null;
      justUnloaded = name;
      if (ctx.hasUI) {
        ctx.ui.setStatus("simocracy", undefined);
        ctx.ui.setWidget("simocracy", undefined);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Unloaded ${name}. Drop the persona completely from your next reply onward — stop using their speaking style, mannerisms, emoji, or vocabulary. Speak in your default neutral voice.`,
          },
        ],
        details: { unloaded: name },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_chat — one-shot, doesn't change session persona.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_chat",
    label: "Chat with Simocracy sim",
    description:
      "Send a single message to a Simocracy sim and return its response. Uses OpenRouter directly so it doesn't change the current pi session's persona. Useful for getting a sim's opinion as quoted text.",
    parameters: ChatToolParams,
    async execute(_id, { message, query }) {
      let sim: LoadedSim | null = loadedSim;
      if (query) {
        sim = await tryLoadFromQuery(query);
      }
      if (!sim) {
        throw new Error(
          query
            ? `No sim found matching "${query}".`
            : "No sim loaded. Pass `query` or call simocracy_load_sim first.",
        );
      }
      const messages: ChatMessage[] = [
        { role: "system", content: buildSimPrompt(sim) },
        { role: "user", content: message },
      ];
      const reply = await openRouterComplete(messages, { maxTokens: 600 });
      return {
        content: [{ type: "text" as const, text: `${sim.name} says:\n\n${reply}` }],
        details: { name: sim.name, uri: sim.uri },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_run_interview — run the interview questionnaire.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_run_interview",
    label: "Run Simocracy interview",
    description:
      "Run the Simocracy interview questionnaire on the loaded sim and return the captured open + yes/no answers. With UI, drives the user through the questions interactively. Without UI, returns the structure of the chosen template as a planning aid (no answers).",
    parameters: RunInterviewToolParams,
    async execute(_id, { sim, templateUri }, _signal, _onUpdate, ctx) {
      if (ctx.hasUI) {
        let target: LoadedSim | null = loadedSim;
        if (sim) {
          const loaded = await tryLoadFromQuery(sim);
          if (!loaded) throw new Error(`No sim found matching "${sim}".`);
          loadedSim = loaded;
          target = loaded;
          await postSimToChat(pi, ctx, loaded, true);
        }
        if (!target) throw new Error("No sim loaded. Pass `sim` or call simocracy_load_sim first.");
        const out = await runInterviewFlow(pi, ctx as ExtensionCommandContext, target, {
          templateUri,
        });
        if (!out) {
          return {
            content: [{ type: "text" as const, text: "Interview cancelled." }],
            details: { cancelled: true },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Captured ${out.result.openAnswers.length} open answers and ${out.result.yesNoAnswers.length} value positions.`,
            },
          ],
          details: out.result,
        };
      }
      // No UI: return the template snapshot as a planning aid.
      const snapshot = await snapshotInterviewTemplate(templateUri);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Interview template "${snapshot.name}" — ${snapshot.questions.length} questions. ` +
              `Run from a UI session to capture answers.`,
          },
        ],
        details: { template: snapshot, openAnswers: [], yesNoAnswers: [] },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_derive_constitution — turn answers into constitution+style.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_derive_constitution",
    label: "Derive Simocracy constitution",
    description:
      "Given an interview's open + yes/no answers, derive a sim constitution (short description + markdown body) and a speaking style. Returns plain markdown — no PDS write happens here.",
    parameters: DeriveConstitutionToolParams,
    async execute(_id, { openAnswers, yesNoAnswers }) {
      const sim: LoadedSim = loadedSim ?? {
        uri: "",
        did: "",
        rkey: "",
        name: "Sim",
        handle: null,
      };
      const derived = await deriveFromInterview(sim, {
        openAnswers: openAnswers ?? [],
        yesNoAnswers: yesNoAnswers ?? [],
      });
      if (!derived) {
        throw new Error("Could not parse derive-from-interview model output.");
      }
      const summary = [
        `Short description:`,
        derived.constitution.shortDescription,
        ``,
        `Constitution:`,
        derived.constitution.description,
        ``,
        `Speaking style:`,
        derived.style.description,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text: summary }],
        details: derived,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_training_profile — distill into a TrainingProfile.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_training_profile",
    label: "Distill Simocracy training profile",
    description:
      "Distill a baseline questionnaire + interview transcript into a structured TrainingProfile (summary, core values, issue priorities, red lines, etc.). Read-only — does not write to the sim.",
    parameters: TrainingProfileToolParams,
    async execute(_id, params) {
      const sim: LoadedSim = loadedSim ?? {
        uri: "",
        did: "",
        rkey: "",
        name: params.simName,
        handle: null,
        description: params.existingConstitution,
      };
      const stateSnapshot = {
        baselineVotes: params.baselineVotes as BaselineVote[],
        interviewTurns: params.transcript as InterviewTurn[],
        feedbackTurns: [] as never[],
        profile: null as TrainingProfile | null,
        alignment: null as AlignmentResult | null,
        updatedAt: new Date().toISOString(),
      };
      const profile = await deriveProfile(
        { ...sim, description: params.existingConstitution ?? sim.description },
        stateSnapshot,
        params.baselineProposals as BaselineProposal[],
      );
      if (!profile) throw new Error("Could not parse training profile from model output.");
      if (loadedSim && loadedSim.rkey) {
        const persisted = loadTrainingLabState(loadedSim.rkey);
        saveTrainingLabState(loadedSim.rkey, { ...persisted, profile, alignment: null });
      }
      try {
        printProfile(profile);
      } catch {
        /* best effort */
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Distilled profile: ${profile.coreValues.length} core values, ${profile.issuePriorities.length} issue priorities, ${profile.redLines.length} red lines.`,
          },
        ],
        details: profile,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_alignment_test — score the sim against baseline votes.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_alignment_test",
    label: "Run Simocracy alignment test",
    description:
      "Run the loaded sim's training profile against a list of proposals (each with the user's hidden vote) and return per-proposal match/mismatch + an overall match percentage. Calls the alignment prompt once per proposal at concurrency 4.",
    parameters: AlignmentTestToolParams,
    async execute(_id, params) {
      const sim: LoadedSim = loadedSim ?? {
        uri: "",
        did: "",
        rkey: "",
        name: params.simName,
        handle: null,
        description: params.existingConstitution,
      };
      const aligned = (params.proposals as Array<BaselineProposal & { userVote: Vote }>).map(
        (p) => ({
          proposal: { id: p.id, title: p.title, summary: p.summary, topic: p.topic },
          userVote: p.userVote,
        }),
      );
      const alignment = await scoreAlignment(
        { ...sim, description: params.existingConstitution ?? sim.description },
        params.profile as TrainingProfile,
        aligned,
      );
      if (loadedSim && loadedSim.rkey) {
        const persisted = loadTrainingLabState(loadedSim.rkey);
        saveTrainingLabState(loadedSim.rkey, { ...persisted, alignment });
      }
      try {
        printAlignment(alignment, aligned);
      } catch {
        /* not in UI mode — printing is best-effort */
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Alignment: ${alignment.matchedCount}/${alignment.totalCount} matched. Weak areas: ${
              alignment.weakAreas.length ? alignment.weakAreas.join(", ") : "none"
            }.`,
          },
        ],
        details: alignment,
      };
    },
  });
}


// ---------------------------------------------------------------------------
// Slash-command flow
// ---------------------------------------------------------------------------

async function runLoadFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  ctx.ui.notify(`Searching for "${arg}"…`, "info");
  let matches: SimMatch[] = [];
  if (arg.startsWith("at://")) {
    // AT-URI shortcut — fetch directly.
    try {
      const sim = await tryLoadFromQuery(arg);
      if (sim) {
        loadedSim = sim;
        await postSimToChat(pi, ctx, sim, true);
        return;
      }
    } catch {
      /* fall through to search */
    }
  }
  try {
    const result = await loadSimByName(arg);
    matches = result.matches;
    if (result.error) {
      ctx.ui.notify(result.error, "error");
      return;
    }
  } catch (err) {
    ctx.ui.notify(`Search failed: ${(err as Error).message}`, "error");
    return;
  }
  let chosen = matches[0];
  if (matches.length > 1) {
    const labels = matches.map((m) => `${m.sim.name}  —  ${m.uri}`);
    const picked = await ctx.ui.select(`Multiple matches for "${arg}"`, labels);
    if (!picked) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    chosen = matches[labels.indexOf(picked)];
  }
  ctx.ui.notify(`Loading ${chosen.sim.name}…`, "info");
  let sim: LoadedSim;
  try {
    sim = await hydrateLoadedSim(chosen);
  } catch (err) {
    ctx.ui.notify(`Failed to load sim: ${(err as Error).message}`, "error");
    return;
  }
  loadedSim = sim;
  await postSimToChat(pi, ctx, sim, true);
}

async function tryLoadFromQuery(query: string): Promise<LoadedSim | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("at://")) {
    try {
      const { did, rkey } = parseAtUri(trimmed);
      // Fetch the sim record from the PDS so we have the blob refs.
      const { getRecordFromPds } = await import("./simocracy.ts");
      const sim = await getRecordFromPds<{
        name: string;
        image?: { ref: unknown };
        sprite?: { ref: unknown };
        $type?: string;
      }>(did, "org.simocracy.sim", rkey);
      const match: SimMatch = {
        uri: trimmed,
        cid: "",
        did,
        rkey,
        sim: {
          $type: "org.simocracy.sim",
          name: sim.name,
          settings: { selectedOptions: {} },
          image: sim.image as never,
          sprite: sim.sprite as never,
          createdAt: "",
        },
      };
      return await hydrateLoadedSim(match);
    } catch {
      return null;
    }
  }
  const result = await loadSimByName(trimmed);
  if (!result.matches.length) return null;
  return await hydrateLoadedSim(result.matches[0]);
}

async function postSimToChat(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sim: LoadedSim,
  _reload: boolean,
) {
  ctx.ui.setStatus("simocracy", `🐾 ${sim.name}`);
  const headerLines = [`Simocracy: ${sim.name}${sim.handle ? `  (@${sim.handle})` : ""}`];
  ctx.ui.setWidget("simocracy", headerLines, { placement: "aboveEditor" });
  const body = formatSimSummary(sim, ctx.ui.theme);
  pi.sendMessage({
    customType: "simocracy_sim_loaded",
    content: stripAnsiForLog(body),
    display: true,
    details: {
      uri: sim.uri,
      did: sim.did,
      rkey: sim.rkey,
      name: sim.name,
      body,
    },
  });
}

/** Strip ANSI escapes for the textual log copy (the renderer uses details.body). */
function stripAnsiForLog(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
