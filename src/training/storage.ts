/**
 * File-backed Training Lab state for the pi-simocracy CLI.
 *
 * Web parity: simocracy-v2 stores `TrainingLabState` in localStorage
 * keyed by `simocracy.trainingLab.v1.<simUri>`. The CLI has no
 * localStorage, so we mirror the schema to a JSON file under the
 * platform's XDG data dir, keyed by the sim's rkey (the loaded sim's
 * AT-URI rkey is unique within the user's PDS).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TrainingLabState } from "./types.ts";

const DATA_DIR = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "pi-simocracy", "training")
  : join(homedir(), ".local", "share", "pi-simocracy", "training");

export function trainingFilePath(rkey: string): string {
  return join(DATA_DIR, `${rkey}.json`);
}

export function trainingDir(): string {
  return DATA_DIR;
}

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function createEmptyTrainingLabState(): TrainingLabState {
  return {
    baselineVotes: [],
    interviewTurns: [],
    feedbackTurns: [],
    profile: null,
    alignment: null,
    updatedAt: new Date().toISOString(),
  };
}

export function loadTrainingLabState(rkey: string): TrainingLabState {
  const path = trainingFilePath(rkey);
  if (!existsSync(path)) return createEmptyTrainingLabState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<TrainingLabState>;
    return {
      baselineVotes: parsed.baselineVotes ?? [],
      interviewTurns: parsed.interviewTurns ?? [],
      feedbackTurns: parsed.feedbackTurns ?? [],
      profile: parsed.profile ?? null,
      alignment: parsed.alignment ?? null,
      questionSet: parsed.questionSet,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[pi-simocracy] Could not parse training state at ${path}:`, (err as Error).message);
    return createEmptyTrainingLabState();
  }
}

export function saveTrainingLabState(rkey: string, state: TrainingLabState): void {
  ensureDir();
  const path = trainingFilePath(rkey);
  const next: TrainingLabState = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

export function clearTrainingLabState(rkey: string): boolean {
  const path = trainingFilePath(rkey);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function trainingStateExists(rkey: string): boolean {
  return existsSync(trainingFilePath(rkey));
}
