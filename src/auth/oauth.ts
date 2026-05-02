/**
 * NodeOAuthClient singleton for the loopback OAuth flow.
 *
 * Builds client metadata via `buildAtprotoLoopbackClientMetadata` so
 * we don't need a hosted client_metadata.json — the redirect URI is
 * the loopback URL the callback server listens on. The client is
 * cached process-wide because building it does some PKCE crypto and
 * registering can fail on subsequent calls.
 */

import {
  NodeOAuthClient,
  type NodeOAuthClientOptions,
} from "@atproto/oauth-client-node";

import { CALLBACK_REDIRECT_URI } from "./callback-server.ts";
import { sessionStore, stateStore } from "./storage.ts";

const SCOPES = "atproto transition:generic";

let cached: NodeOAuthClient | null = null;

export function getOAuthClient(): NodeOAuthClient {
  if (cached) return cached;
  // Note: NodeOAuthClient builds the loopback client metadata
  // internally when client_id starts with `http://localhost`.
  // We pass the loopback URL so it picks the loopback flow.
  const clientId =
    `http://localhost?` +
    new URLSearchParams({
      scope: SCOPES,
      redirect_uri: CALLBACK_REDIRECT_URI,
    }).toString();

  const options: NodeOAuthClientOptions = {
    clientMetadata: {
      client_id: clientId,
      client_name: "pi-simocracy",
      redirect_uris: [CALLBACK_REDIRECT_URI as `http://127.0.0.1:${string}`],
      scope: SCOPES,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    },
    stateStore,
    sessionStore,
  };

  cached = new NodeOAuthClient(options);
  return cached;
}

export const OAUTH_SCOPES = SCOPES;
