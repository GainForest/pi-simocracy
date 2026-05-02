/**
 * Handlers for `/sim login`, `/sim logout`, `/sim whoami`.
 *
 * These power the ATProto / Bluesky sign-in flow used by `--apply`
 * subcommands that write records to the user's PDS. They are dispatched
 * from inside the `/sim` slash command in `src/index.ts` rather than
 * registered as top-level slash commands, because pi itself ships a
 * built-in `/login` (Anthropic OAuth) and `/logout` — colliding with
 * those would emit "Skipping in autocomplete" warnings on every boot
 * and confuse users about which account they're signing into.
 *
 * `/sim login` runs the loopback OAuth flow described in
 * https://atproto.com/guides/oauth-cli-tutorial:
 *   1. Start a localhost server on 127.0.0.1:53682/callback.
 *   2. Build the authorize URL via `oauthClient.authorize(handle)`.
 *   3. Open the URL in the user's default browser; also print it as a
 *      fallback in case the browser can't be opened (SSH, etc.).
 *   4. Wait for the `/callback` GET, exchange the code via
 *      `oauthClient.callback(searchParams)` (DPoP-bound).
 *   5. Persist the auth record (DID + handle) to
 *      ~/.config/pi-simocracy/auth.json so subsequent commands can
 *      call `getAuthenticatedAgent()` from `src/writes.ts`.
 */

import { exec } from "node:child_process";
import { platform } from "node:os";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { resolveHandle } from "../simocracy.ts";
import { startCallbackServer } from "./callback-server.ts";
import { getOAuthClient } from "./oauth.ts";
import { clearAuth, readAuth, writeAuth } from "./storage.ts";

export async function runLogin(
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const handleArg = arg.trim();
  let handle: string;
  if (handleArg) {
    handle = handleArg.replace(/^@/, "");
  } else {
    const prompt = await ctx.ui.input(
      "Sign in with ATProto / Bluesky — your handle",
      "alice.bsky.social",
    );
    if (!prompt?.trim()) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    handle = prompt.trim().replace(/^@/, "");
  }

  ctx.ui.notify(
    `Signing in with ATProto / Bluesky as @${handle}. Starting loopback OAuth flow on 127.0.0.1:53682… (this is NOT Anthropic auth — pi's built-in /login does that.)`,
    "info",
  );

  let callback: Awaited<ReturnType<typeof startCallbackServer>>;
  try {
    callback = await startCallbackServer();
  } catch (err) {
    ctx.ui.notify(`Could not bind callback server: ${(err as Error).message}`, "error");
    return;
  }

  try {
    const client = getOAuthClient();
    let authUrl: URL;
    try {
      authUrl = await client.authorize(handle, {
        scope: "atproto transition:generic",
      });
    } catch (err) {
      ctx.ui.notify(
        `Could not start OAuth: ${(err as Error).message}. Check the handle and try again.`,
        "error",
      );
      return;
    }

    ctx.ui.notify(
      `Opening ${authUrl.origin} in your browser — grant pi-simocracy access to your ATProto repo. If the browser doesn't open automatically, paste this URL: ${authUrl.toString()}`,
      "info",
    );
    openInBrowser(authUrl.toString());

    const params = await callback.waitForParams();
    if (!params) {
      ctx.ui.notify("Sign-in cancelled.", "info");
      return;
    }

    let result;
    try {
      result = await client.callback(params);
    } catch (err) {
      ctx.ui.notify(`Token exchange failed: ${(err as Error).message}`, "error");
      return;
    }

    const did = result.session.did;
    const handleResolved = await resolveHandle(did).catch(() => null);
    writeAuth({ did, handle: handleResolved, lastLogin: new Date().toISOString() });

    ctx.ui.notify(
      handleResolved
        ? `🔐 Signed in to ATProto as @${handleResolved} (${did}). You can now use /sim interview --apply and /sim train apply --apply to write to your PDS.`
        : `🔐 Signed in to ATProto as ${did}. You can now use /sim interview --apply and /sim train apply --apply to write to your PDS.`,
      "info",
    );
  } finally {
    callback.close();
  }
}

export async function runLogout(ctx: ExtensionCommandContext): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify("Not signed into ATProto. (Note: this is separate from pi's Anthropic /login.)", "info");
    return;
  }
  clearAuth();
  ctx.ui.notify(
    `Signed out of ATProto ${auth.handle ? `@${auth.handle}` : auth.did}. Local OAuth tokens cleared from ~/.config/pi-simocracy/auth.json. (Pi's Anthropic session is unaffected.)`,
    "info",
  );
}

export async function runWhoami(ctx: ExtensionCommandContext): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify(
      "Not signed into ATProto. Run `/sim login <handle>` (e.g. `/sim login alice.bsky.social`) to sign in with your Bluesky / ATProto account. This is separate from pi's built-in `/login` (Anthropic).",
      "info",
    );
    return;
  }
  ctx.ui.notify(
    auth.handle
      ? `Signed into ATProto as @${auth.handle} (${auth.did}) since ${auth.lastLogin}. Use /sim interview --apply or /sim train apply --apply to write records to your PDS.`
      : `Signed into ATProto as ${auth.did} since ${auth.lastLogin}. Use /sim interview --apply or /sim train apply --apply to write records to your PDS.`,
    "info",
  );
}

function openInBrowser(url: string): void {
  const escaped = url.replace(/"/g, '\\"');
  const command =
    platform() === "darwin"
      ? `open "${escaped}"`
      : platform() === "win32"
        ? `start "" "${escaped}"`
        : `xdg-open "${escaped}"`;
  exec(command, () => {
    /* best effort — failure is fine, user has the URL printed */
  });
}
