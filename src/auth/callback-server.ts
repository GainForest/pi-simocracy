/**
 * Loopback HTTP server that catches the OAuth redirect after the user
 * authorizes pi-simocracy in their browser. Pattern adapted from
 * pi-mono's anthropic.ts.
 *
 * The server listens on 127.0.0.1:53682 (overridable via
 * `PI_SIMOCRACY_OAUTH_PORT`), accepts a single `/callback` GET, and
 * resolves with the URLSearchParams the OAuth client needs.
 */

import { createServer, type Server } from "node:http";

import { oauthErrorHtml, oauthSuccessHtml } from "./pages.ts";

export const CALLBACK_HOST = process.env.PI_SIMOCRACY_OAUTH_HOST ?? "127.0.0.1";
export const CALLBACK_PORT = Number(process.env.PI_SIMOCRACY_OAUTH_PORT ?? "53682");
export const CALLBACK_PATH = "/callback";
export const CALLBACK_REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

export interface CallbackHandle {
  server: Server;
  redirectUri: string;
  /** Resolves with the params from the redirect URL (or null if cancelled). */
  waitForParams: () => Promise<URLSearchParams | null>;
  cancel: () => void;
  close: () => void;
}

export async function startCallbackServer(): Promise<CallbackHandle> {
  return new Promise((resolve, reject) => {
    let settle: ((value: URLSearchParams | null) => void) | undefined;
    const wait = new Promise<URLSearchParams | null>((resolveWait) => {
      let settled = false;
      settle = (v) => {
        if (settled) return;
        settled = true;
        resolveWait(v);
      };
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Callback route not found."));
          return;
        }
        const params = url.searchParams;
        const error = params.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            oauthErrorHtml(
              "ATProto sign-in did not complete.",
              `Error: ${error}${params.get("error_description") ? `\n${params.get("error_description")}` : ""}`,
            ),
          );
          settle?.(null);
          return;
        }
        if (!params.get("code")) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Missing `code` parameter on callback."));
          settle?.(null);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          oauthSuccessHtml(
            "Sign-in complete. You can close this browser tab and return to the terminal.",
          ),
        );
        settle?.(params);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error in callback server");
      }
    });

    server.on("error", (err) => reject(err));

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        redirectUri: CALLBACK_REDIRECT_URI,
        waitForParams: () => wait,
        cancel: () => settle?.(null),
        close: () => server.close(),
      });
    });
  });
}
