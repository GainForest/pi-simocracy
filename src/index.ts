/**
 * pi-simocracy — load a Simocracy sim into your pi chat, refine its
 * constitution + speaking style by chatting with pi, and write the
 * result back to your ATProto PDS.
 *
 * Sim commands:
 *  - `/sim <name>`        Load a sim by name (fuzzy search on the indexer).
 *                         Renders the sprite inline as colored ANSI art and
 *                         pushes the sim's constitution + style into the
 *                         system prompt so pi roleplays as the sim.
 *  - `/sim unload`        Drop the loaded sim and stop roleplaying.
 *  - `/sim status`        Show the currently loaded sim, if any.
 *
 * Editing your sim's constitution / speaking style:
 *  There is no `/sim train` or `/sim interview` slash flow. Instead,
 *  load a sim you own and tell pi how you want the persona to change
 *  ("add a red line about animal welfare", "make the speaking style
 *  punchier and drop the lenny faces", etc.). Pi rewrites the
 *  constitution and/or speaking style and calls the
 *  `simocracy_update_sim` tool to write the result to your PDS.
 *  Requires `/sim login` and ownership of the loaded sim.
 *
 * ATProto sign-in ("sign in with Bluesky / ATProto", NOT Anthropic):
 *  - `/sim login [handle]`
 *        Loopback OAuth flow — opens your PDS's authorize page in the
 *        browser, grants this CLI a DPoP-bound session, persists it to
 *        ~/.config/pi-simocracy/auth.json. Required before pi can
 *        update your sim's constitution / style.
 *  - `/sim logout`        Clear the local OAuth session.
 *  - `/sim whoami`        Show the currently signed-in ATProto handle/DID.
 *
 * Browse your own sims (requires `/sim login`):
 *  - `/sim my`            Pick from the org.simocracy.sim records owned
 *                         by the signed-in DID. Single sim auto-loads;
 *                         multiple sims open a picker, and the chosen one
 *                         renders inline exactly like `/sim <name>`.
 *  - `/sim my <name>`     Fuzzy-load by name within your own sims.
 *                         Exact match auto-loads; ambiguous matches
 *                         open the same picker.
 *
 * Tools (LLM-callable):
 *  - `simocracy_load_sim`     Same as /sim <name>.
 *  - `simocracy_unload_sim`   Same as /sim unload.
 *  - `simocracy_chat`         One-shot chat with a sim via OpenRouter
 *                             (does not change the active session
 *                             persona).
 *  - `simocracy_update_sim`   Write a new constitution and/or speaking
 *                             style for the loaded sim to the user's
 *                             PDS. Requires the user to be signed in
 *                             via /sim login AND to own the sim.
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
  fetchSimsForDid,
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
import { runLogin, runLogout, runWhoami } from "./auth/commands.ts";
import { readAuth } from "./auth/storage.ts";
import {
  assertCanWriteToSim,
  createAgents,
  createStyle,
  findRkeyForSim,
  getAuthenticatedAgent,
  NotSignedInError,
  NotSimOwnerError,
  updateAgents,
  updateStyle,
} from "./writes.ts";

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

const UpdateSimToolParams = Type.Object({
  shortDescription: Type.Optional(
    Type.String({
      description:
        "New short description for the sim's constitution. Max 300 chars; longer values will be truncated. Pass alongside `description` when rewriting the constitution; if you supply `description` without this, the existing short description (if any) is reused.",
      maxLength: 300,
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "New constitution body in markdown. Replaces the existing org.simocracy.agents record's `description`. Required when changing the constitution — a constitution with only a short description and no body is rejected.",
    }),
  ),
  style: Type.Optional(
    Type.String({
      description:
        "New speaking style description in markdown. Replaces the existing org.simocracy.style record's `description`. May be passed alone (style-only update) or together with `shortDescription` + `description` (constitution + style update).",
    }),
  ),
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
      "Simocracy: load sims, edit your own sim's constitution/style, sign into ATProto. `/sim help` for the full list.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg || arg === "help" || arg === "--help") {
        ctx.ui.notify(
          "Sim:\n" +
            "  /sim <name>            load a sim (e.g. /sim mr meow)\n" +
            "  /sim unload            stop roleplaying\n" +
            "  /sim status            show currently loaded sim\n" +
            "\n" +
            "Refining your sim's constitution / speaking style:\n" +
            "  Just chat with pi about what you want to change — pi calls\n" +
            "  the simocracy_update_sim tool to write the new constitution or\n" +
            "  style to your PDS. Requires /sim login + sim ownership.\n" +
            "\n" +
            "Sign in with ATProto / Bluesky (not Anthropic — pi's built-in /login\n" +
            "does that). Required before pi can update your sim:\n" +
            "  /sim login [handle]    OAuth loopback flow (e.g. /sim login alice.bsky.social)\n" +
            "  /sim logout            clear local session\n" +
            "  /sim whoami            show signed-in handle/DID\n" +
            "\n" +
            "Browse your own sims (requires /sim login):\n" +
            "  /sim my                pick from sims you own (auto-loads if just one)\n" +
            "  /sim my <name>         fuzzy-load by name within your sims",
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
      if (arg === "my" || arg === "mine" || arg.startsWith("my ") || arg.startsWith("my\t") || arg.startsWith("mine ") || arg.startsWith("mine\t")) {
        const headLen = arg.startsWith("mine") ? 4 : 2;
        const rest = arg.slice(headLen).trim();
        await runMySimsCommand(pi, ctx, rest);
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
  // Tool: simocracy_update_sim — write a new constitution and/or speaking
  // style for the loaded sim to the signed-in user's PDS.
  //
  // This is the *only* persona-edit surface this extension exposes. The
  // older Interview Modal + Training Lab pipelines (`/sim interview`,
  // `/sim train …`) were removed in favour of this single tool: pi (the
  // coding agent) chats with the user about how to refine the sim, then
  // calls this tool with the new short description / constitution body /
  // speaking style. The model itself does the rewriting; we just persist
  // the result and update the in-memory persona so the next reply uses it.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_update_sim",
    label: "Update Simocracy sim constitution / style",
    description:
      "Update the currently loaded Simocracy sim's constitution (short description + markdown body) and/or speaking style on the user's ATProto PDS. Use this when the user asks to refine, rewrite, extend, or fix any part of the loaded sim's persona — e.g. 'add a red line about animal welfare to the constitution', 'rewrite the speaking style to drop the lenny faces', 'shorten the constitution and emphasise renewable energy'. Pass `description` (with optional `shortDescription`) to update the constitution; pass `style` to update the speaking style; pass any combination. Requires the user to be signed in via /sim login AND to own the loaded sim — the call will fail otherwise. The new persona takes effect on the very next reply, no reload needed.",
    parameters: UpdateSimToolParams,
    async execute(_id, { shortDescription, description, style }) {
      if (!loadedSim) {
        throw new Error(
          "No sim loaded. Call simocracy_load_sim first — the user must load the sim they want to edit.",
        );
      }
      const wantsConstitution =
        description !== undefined || shortDescription !== undefined;
      const wantsStyle = style !== undefined;
      if (!wantsConstitution && !wantsStyle) {
        throw new Error(
          "Pass at least one of `description`, `shortDescription`, `style`. Empty calls are rejected.",
        );
      }
      // Owner + auth gate. The same precondition is re-checked at the
      // XRPC call site in writes.ts (defense-in-depth) but we want a
      // human-readable failure here before we touch the network.
      let auth;
      try {
        auth = await assertCanWriteToSim(loadedSim, { action: "update" });
      } catch (err) {
        if (err instanceof NotSignedInError || err instanceof NotSimOwnerError) {
          throw new Error(err.message);
        }
        throw err;
      }
      let pdsAgent;
      try {
        ({ agent: pdsAgent } = await getAuthenticatedAgent());
      } catch (err) {
        if (err instanceof NotSignedInError) throw new Error(err.message);
        throw new Error(`ATProto auth failed: ${(err as Error).message}`);
      }

      const updates: string[] = [];
      const details: Record<string, unknown> = {
        uri: loadedSim.uri,
        did: loadedSim.did,
        rkey: loadedSim.rkey,
        name: loadedSim.name,
      };

      // Constitution update — org.simocracy.agents. Lexicon stores both
      // shortDescription (≤300 chars) and description (full markdown). If
      // the caller only passed one of those, fall back to the existing
      // value on the loaded sim so we never end up with a half-empty
      // record.
      if (wantsConstitution) {
        const finalShort =
          shortDescription !== undefined
            ? shortDescription
            : loadedSim.shortDescription ?? "";
        const finalBody =
          description !== undefined ? description : loadedSim.description ?? "";
        if (!finalBody.trim()) {
          throw new Error(
            "Cannot write an empty constitution body. Pass `description` with the new markdown body.",
          );
        }
        const existingRkey = await findRkeyForSim(
          pdsAgent,
          auth.did,
          "org.simocracy.agents",
          loadedSim.uri,
        ).catch(() => null);
        try {
          if (existingRkey) {
            const res = await updateAgents({
              agent: pdsAgent,
              did: auth.did,
              rkey: existingRkey,
              simUri: loadedSim.uri,
              simCid: "",
              shortDescription: finalShort,
              description: finalBody,
            });
            details.agentsUri = res.uri;
            updates.push(`Updated constitution (org.simocracy.agents/${existingRkey}).`);
          } else {
            const res = await createAgents({
              agent: pdsAgent,
              did: auth.did,
              simUri: loadedSim.uri,
              simCid: "",
              shortDescription: finalShort,
              description: finalBody,
            });
            details.agentsUri = res.uri;
            updates.push(`Created constitution (org.simocracy.agents/${res.rkey}).`);
          }
        } catch (err) {
          throw new Error(`Constitution write failed: ${(err as Error).message}`);
        }
        // Mutate in-memory persona so the next `before_agent_start` event
        // injects the new constitution without requiring an unload/reload.
        loadedSim.shortDescription = finalShort;
        loadedSim.description = finalBody;
      }

      // Speaking-style update — org.simocracy.style. Single field.
      if (wantsStyle) {
        const finalStyle = style ?? "";
        if (!finalStyle.trim()) {
          throw new Error(
            "Cannot write an empty speaking style. Pass `style` with the new markdown body.",
          );
        }
        const existingRkey = await findRkeyForSim(
          pdsAgent,
          auth.did,
          "org.simocracy.style",
          loadedSim.uri,
        ).catch(() => null);
        try {
          if (existingRkey) {
            const res = await updateStyle({
              agent: pdsAgent,
              did: auth.did,
              rkey: existingRkey,
              simUri: loadedSim.uri,
              simCid: "",
              description: finalStyle,
            });
            details.styleUri = res.uri;
            updates.push(`Updated speaking style (org.simocracy.style/${existingRkey}).`);
          } else {
            const res = await createStyle({
              agent: pdsAgent,
              did: auth.did,
              simUri: loadedSim.uri,
              simCid: "",
              description: finalStyle,
            });
            details.styleUri = res.uri;
            updates.push(`Created speaking style (org.simocracy.style/${res.rkey}).`);
          }
        } catch (err) {
          throw new Error(`Style write failed: ${(err as Error).message}`);
        }
        loadedSim.style = finalStyle;
      }

      const text = [
        `Updated ${loadedSim.name} on ${auth.handle ? `@${auth.handle}` : auth.did}'s PDS:`,
        ...updates.map((u) => `  - ${u}`),
        ``,
        `The new persona takes effect on your next reply.`,
      ].join("\n");
      details.updates = updates;
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  });
}


// ---------------------------------------------------------------------------
// Slash-command flow
// ---------------------------------------------------------------------------

/**
 * `/sim my [name]` — list and load sims owned by the currently
 * signed-in DID. Mirrors the load UX of `/sim <name>` but pre-filtered
 * to the user's own PDS:
 *
 *   - bare `/sim my`     →  if 1 sim: load it. If many: show a select
 *                           picker; on pick, hydrate + render sprite
 *                           inline exactly like `/sim <name>` does.
 *   - `/sim my <name>`   →  fuzzy-match within the user's sims. Exact
 *                           name match loads directly; otherwise the
 *                           ranked candidates go into a select picker.
 *
 * Reads the user's sims from their PDS via `com.atproto.repo.listRecords`
 * (no DPoP needed for reads of the public collection), so this works
 * even if the OAuth session has expired — it only needs the DID, which
 * the auth.json keeps after `lastLogin` is stale.
 */
async function runMySimsCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify(
      "Not signed into ATProto. Run `/sim login <handle>` first (e.g. `/sim login alice.bsky.social`) so /sim my knows which DID's repo to list.",
      "error",
    );
    return;
  }

  ctx.ui.notify(`Listing sims owned by ${auth.handle ? `@${auth.handle}` : auth.did}\u2026`, "info");

  let mySims: SimMatch[];
  try {
    mySims = await fetchSimsForDid(auth.did);
  } catch (err) {
    ctx.ui.notify(
      `Could not list sims from your PDS: ${(err as Error).message}. Is the DID document still resolvable?`,
      "error",
    );
    return;
  }

  if (mySims.length === 0) {
    ctx.ui.notify(
      auth.handle
        ? `@${auth.handle} doesn't own any sims yet. Visit https://simocracy.org/my-sims to create one, then come back and try /sim my again.`
        : `No sims found on this PDS. Create one at https://simocracy.org/my-sims and try again.`,
      "info",
    );
    return;
  }

  // Narrow the candidate pool to fuzzy-matched sims when an arg was
  // supplied; otherwise the full owned list is the candidate pool.
  let candidates: SimMatch[];
  if (arg) {
    const matches = fuzzyMatchOwnedSims(mySims, arg);
    if (matches.length === 0) {
      ctx.ui.notify(
        `No sim matching "${arg}" in your ${mySims.length} sim${mySims.length === 1 ? "" : "s"}. Run /sim my (no args) to see them.`,
        "error",
      );
      return;
    }
    // Exact name match — load straight away, same shortcut /sim <name>
    // takes when the indexer returns one perfect hit.
    if (matches.length === 1 || matches[0].score === 0) {
      await loadAndPostMySim(pi, ctx, matches[0].sim);
      return;
    }
    candidates = matches.map((m) => m.sim);
  } else {
    if (mySims.length === 1) {
      // Only one owned sim — skip the picker, just load it.
      await loadAndPostMySim(pi, ctx, mySims[0]);
      return;
    }
    candidates = mySims;
  }

  // Picker — same shape as /sim <name>'s ambiguous-match prompt so the
  // two flows feel identical. We show created-date as a secondary key
  // since multiple sims can share a name within one repo.
  const labels = candidates.map((s) => {
    const created = (s.sim.createdAt || "").slice(0, 10);
    const tail = created ? `${created}  at://…/${s.rkey}` : `at://…/${s.rkey}`;
    return `${s.sim.name}  —  ${tail}`;
  });
  const title = arg
    ? `Matches for "${arg}" in your ${mySims.length} sim${mySims.length === 1 ? "" : "s"}`
    : `Your sims (${mySims.length})`;
  const picked = await ctx.ui.select(title, labels);
  if (!picked) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }
  const chosen = candidates[labels.indexOf(picked)];
  await loadAndPostMySim(pi, ctx, chosen);
}

async function loadAndPostMySim(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  match: SimMatch,
): Promise<void> {
  ctx.ui.notify(`Loading ${match.sim.name}…`, "info");
  let sim: LoadedSim;
  try {
    sim = await hydrateLoadedSim(match);
  } catch (err) {
    ctx.ui.notify(`Failed to load sim: ${(err as Error).message}`, "error");
    return;
  }
  loadedSim = sim;
  await postSimToChat(pi, ctx, sim, true);
}

/**
 * Score user-owned sims against a query string. Returns matches sorted
 * best-first. Score 0 = exact name match (prompt-suppressing), higher =
 * worse. Mirrors the heuristic the indexer search uses but constrained
 * to the already-fetched list, so this is purely client-side and no
 * extra HTTP calls are issued.
 */
function fuzzyMatchOwnedSims(
  sims: SimMatch[],
  query: string,
): Array<{ sim: SimMatch; score: number }> {
  const q = query.toLowerCase().trim();
  const out: Array<{ sim: SimMatch; score: number }> = [];
  for (const sim of sims) {
    const name = sim.sim.name.toLowerCase().trim();
    let score = Number.POSITIVE_INFINITY;
    if (name === q) score = 0;
    else if (name.replace(/\s+/g, "") === q.replace(/\s+/g, "")) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 3 + (name.length - q.length);
    else {
      const tokens = q.split(/\s+/).filter(Boolean);
      const matched = tokens.filter((t) => name.includes(t)).length;
      if (matched > 0) score = 100 - matched;
    }
    if (Number.isFinite(score)) out.push({ sim, score });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

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
