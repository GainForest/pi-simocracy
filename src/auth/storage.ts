/**
 * File-backed StateStore + SessionStore for the ATProto loopback
 * OAuth flow, plus a single-DID `auth.json` that records who's
 * currently signed in (so `/whoami` works without round-tripping the
 * session store).
 *
 * Files live in the platform's XDG config dir:
 *   ~/.config/pi-simocracy/auth.json            — { did, handle, lastLogin }
 *   ~/.config/pi-simocracy/oauth-state.json     — OAuth state map
 *   ~/.config/pi-simocracy/oauth-sessions.json  — OAuth session map
 *
 * The session/state stores serialize per-call to keep the file
 * authoritative — these stores are accessed once per command, not in
 * a hot path, so locking isn't needed.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from "@atproto/oauth-client-node";

const DATA_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "pi-simocracy")
  : join(homedir(), ".config", "pi-simocracy");

const STATE_FILE = join(DATA_DIR, "oauth-state.json");
const SESSION_FILE = join(DATA_DIR, "oauth-sessions.json");
const AUTH_FILE = join(DATA_DIR, "auth.json");

export interface AuthRecord {
  did: string;
  handle: string | null;
  lastLogin: string;
}

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readMap<V>(path: string): Record<string, V> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, V>;
  } catch (err) {
    console.error(`[pi-simocracy] Could not parse ${path}:`, (err as Error).message);
    return {};
  }
}

function writeMap<V>(path: string, value: Record<string, V>): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export const stateStore: NodeSavedStateStore = {
  get(key: string) {
    const map = readMap<NodeSavedState>(STATE_FILE);
    return map[key];
  },
  set(key: string, value: NodeSavedState) {
    const map = readMap<NodeSavedState>(STATE_FILE);
    map[key] = value;
    writeMap(STATE_FILE, map);
  },
  del(key: string) {
    const map = readMap<NodeSavedState>(STATE_FILE);
    delete map[key];
    writeMap(STATE_FILE, map);
  },
};

export const sessionStore: NodeSavedSessionStore = {
  get(key: string) {
    const map = readMap<NodeSavedSession>(SESSION_FILE);
    return map[key];
  },
  set(key: string, value: NodeSavedSession) {
    const map = readMap<NodeSavedSession>(SESSION_FILE);
    map[key] = value;
    writeMap(SESSION_FILE, map);
  },
  del(key: string) {
    const map = readMap<NodeSavedSession>(SESSION_FILE);
    delete map[key];
    writeMap(SESSION_FILE, map);
  },
};

export function readAuth(): AuthRecord | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Partial<AuthRecord>;
    if (!parsed.did) return null;
    return {
      did: parsed.did,
      handle: parsed.handle ?? null,
      lastLogin: parsed.lastLogin ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeAuth(record: AuthRecord): void {
  ensureDir();
  writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2), "utf8");
}

export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) rmSync(AUTH_FILE, { force: true });
  if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { force: true });
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE, { force: true });
}

export const AUTH_DIR = DATA_DIR;
