/**
 * `/login`, `/logout`, `/whoami` slash-command handlers.
 *
 * `/login` runs the loopback OAuth flow:
 *   1. Start the callback server.
 *   2. Build the authorize URL via `oauthClient.authorize(handle)`.
 *   3. Open the URL in the browser; also print it as a fallback.
 *   4. Wait for the `/callback` GET, exchange the code via
 *      `oauthClient.callback(searchParams)`.
 *   5. Persist the auth record (DID + handle) so subsequent commands
 *      can call `getAuthenticatedAgent()`.
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
      "ATProto handle to sign in with",
      "alice.bsky.social",
    );
    if (!prompt?.trim()) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    handle = prompt.trim().replace(/^@/, "");
  }

  ctx.ui.notify("Starting loopback OAuth flow…", "info");

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
      `Opening ${authUrl.origin} in your browser to authorize. If it doesn't open, paste this URL: ${authUrl.toString()}`,
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
        ? `🔐 Signed in as @${handleResolved} (${did}).`
        : `🔐 Signed in as ${did}.`,
      "info",
    );
  } finally {
    callback.close();
  }
}

export async function runLogout(ctx: ExtensionCommandContext): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify("Not signed in.", "info");
    return;
  }
  clearAuth();
  ctx.ui.notify(
    `Signed out ${auth.handle ? `@${auth.handle}` : auth.did}. Local OAuth tokens cleared.`,
    "info",
  );
}

export async function runWhoami(ctx: ExtensionCommandContext): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify("Not signed in. Run /login.", "info");
    return;
  }
  ctx.ui.notify(
    auth.handle
      ? `@${auth.handle} (${auth.did}) — signed in since ${auth.lastLogin}.`
      : `${auth.did} — signed in since ${auth.lastLogin}.`,
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
