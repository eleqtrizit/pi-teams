/**
 * Flavored model configuration utilities.
 *
 * Reads and writes flavor-categorized model lists (orchestrator/worker/swarm)
 * from the pi settings.json file, alongside the master `enabledModels` list.
 *
 * Settings keys:
 *   enabledModels: string[]              — master list of all model IDs
 *   enabledModelsOrchestrator: string[]  — models for orchestrating, planning, coordinating
 *   enabledModelsWorker: string[]        — models for coding
 *   enabledModelsSwarm: string[]         — models for read-only information gathering
 *
 * Legacy keys (enabledModelsHigh/Med/Fast) are migrated by
 * {@link migrateLegacyFlavors}: high -> orchestrator, med and fast -> worker.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

/** Flavor-categorized model lists. */
export interface FlavoredModelsResult {
  orchestrator: string[];
  worker: string[];
  swarm: string[];
}

/** In-memory representation of one model's flavor assignment. */
export interface ModelFlavor {
  id: string;
  flavor: FlavorValue;
}

export type FlavorKey = "orchestrator" | "worker" | "swarm";
export type FlavorValue = FlavorKey | "none";

export const FLAVOR_VALUES: FlavorValue[] = [
  "orchestrator",
  "worker",
  "swarm",
  "none",
];

/** Settings key that stores each flavor's model list. */
export const FLAVOR_SETTINGS_KEYS: Record<FlavorKey, string> = {
  orchestrator: "enabledModelsOrchestrator",
  worker: "enabledModelsWorker",
  swarm: "enabledModelsSwarm",
};

/** Legacy settings keys replaced by the orchestrator/worker/swarm flavors. */
export const LEGACY_SETTINGS_KEYS = {
  high: "enabledModelsHigh",
  med: "enabledModelsMed",
  fast: "enabledModelsFast",
} as const;

/** Outcome of a legacy flavor migration. */
export interface MigrationResult {
  /** Models appended to the orchestrator list (from `high`) */
  toOrchestrator: string[];
  /** Models appended to the worker list (from `med` and `fast`) */
  toWorker: string[];
}

/** @internal Settings file shape — only the keys we care about. */
export interface SettingsFile {
  enabledModels?: unknown;
  enabledModelsOrchestrator?: unknown;
  enabledModelsWorker?: unknown;
  enabledModelsSwarm?: unknown;
  [key: string]: unknown;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);

// ── Settings I/O ────────────────────────────────────────────────────────────

/**
 * Read the full settings.json object.
 *
 * @param settingsPath - Path to the settings file
 * @returns The parsed settings object
 * @throws If the file cannot be read or parsed
 */
export function readSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): SettingsFile {
  const raw = readFileSync(settingsPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Validate a settings value as a string array.
 *
 * @param val - Raw settings value
 * @returns The array, or an empty array when the value is not an array
 * @throws If the array contains a non-string value
 */
function safeArray(val: unknown): string[] {
  if (!Array.isArray(val)) {
    return [];
  }
  for (const item of val) {
    if (typeof item !== "string") {
      throw new Error(
        `Non-string value found in model list: ${JSON.stringify(item)}`,
      );
    }
  }
  return val as string[];
}

/**
 * Write the settings object atomically (temp file, then rename).
 *
 * @param config - The full settings object
 * @param settingsPath - Path to the settings file
 */
function writeSettingsAtomic(config: SettingsFile, settingsPath: string): void {
  const tmpPath = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, settingsPath);
}

/**
 * Append items to a list, skipping duplicates and preserving order.
 *
 * @param base - Existing list
 * @param additions - Items to append
 * @returns A new deduplicated list
 */
function mergeUnique(base: string[], additions: string[]): string[] {
  return [...new Set([...base, ...additions])];
}

/**
 * Migrate the legacy high/med/fast lists to orchestrator/worker.
 *
 * high -> orchestrator; med and fast -> worker. The migration appends to any
 * existing lists without duplicates, deletes the legacy keys, and writes the
 * file atomically. It is a no-op when no legacy key exists.
 *
 * @param settingsPath - Path to the settings file
 * @returns The migration result, or null when no legacy key was present
 * @throws If the file cannot be read, parsed, or written, or a legacy list
 *   contains non-string values
 */
export function migrateLegacyFlavors(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): MigrationResult | null {
  const config = readSettings(settingsPath);
  const legacyKeys = Object.values(LEGACY_SETTINGS_KEYS);
  if (!legacyKeys.some((key) => key in config)) {
    return null;
  }

  const high = safeArray(config[LEGACY_SETTINGS_KEYS.high]);
  const med = safeArray(config[LEGACY_SETTINGS_KEYS.med]);
  const fast = safeArray(config[LEGACY_SETTINGS_KEYS.fast]);
  const toOrchestrator = mergeUnique([], high);
  const toWorker = mergeUnique([], [...med, ...fast]);

  config[FLAVOR_SETTINGS_KEYS.orchestrator] = mergeUnique(
    safeArray(config[FLAVOR_SETTINGS_KEYS.orchestrator]),
    toOrchestrator,
  );
  config[FLAVOR_SETTINGS_KEYS.worker] = mergeUnique(
    safeArray(config[FLAVOR_SETTINGS_KEYS.worker]),
    toWorker,
  );
  for (const key of legacyKeys) {
    delete config[key];
  }

  writeSettingsAtomic(config, settingsPath);
  return { toOrchestrator, toWorker };
}

/**
 * Build the user-facing warning for a completed legacy migration.
 *
 * @param result - The migration result
 * @returns A multi-line warning that names the moved models
 */
export function buildMigrationNotice(result: MigrationResult): string {
  const list = (models: string[]): string =>
    models.length > 0 ? models.join(", ") : "(none)";
  return [
    "Flavored models migrated: high/med/fast are now orchestrator/worker/swarm.",
    `- high -> orchestrator: ${list(result.toOrchestrator)}`,
    `- med and fast -> worker: ${list(result.toWorker)}`,
    "- swarm (read-only information gathering) has no models. Assign them with /flavored-models.",
    "Review your prompts and skills that mention high, med, or fast models, and update them.",
  ].join("\n");
}

/**
 * Read flavor-categorized models from the pi settings.json file.
 *
 * Reads three optional arrays: enabledModelsOrchestrator,
 * enabledModelsWorker, enabledModelsSwarm. Missing keys are treated as empty
 * arrays. Legacy keys are not read; call {@link migrateLegacyFlavors} first.
 *
 * @param settingsPath - Path to the settings file
 * @returns An object with orchestrator, worker, and swarm model identifier arrays
 * @throws If the file cannot be read or parsed or contains non-string values
 */
export function readFlavoredModels(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): FlavoredModelsResult {
  const config = readSettings(settingsPath);
  return {
    orchestrator: safeArray(config[FLAVOR_SETTINGS_KEYS.orchestrator]),
    worker: safeArray(config[FLAVOR_SETTINGS_KEYS.worker]),
    swarm: safeArray(config[FLAVOR_SETTINGS_KEYS.swarm]),
  };
}

/**
 * Read the master enabledModels list.
 *
 * @param settingsPath - Path to the settings file
 * @returns The array of model identifiers
 * @throws If enabledModels is missing or not an array
 */
export function readEnabledModels(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): string[] {
  const config = readSettings(settingsPath);
  const models = config.enabledModels;

  if (!Array.isArray(models)) {
    throw new Error("enabledModels is not an array in settings.json");
  }

  return models as string[];
}

/**
 * Derive the current flavor assignment for each model in enabledModels.
 *
 * On duplicate entries across lists, later lists win: swarm overwrites
 * worker, worker overwrites orchestrator.
 *
 * @param enabledModels - The master list of model IDs
 * @param flavors - The flavor-sorted model lists
 * @returns An array of ModelFlavor entries (one per model)
 */
export function buildModelFlavors(
  enabledModels: string[],
  flavors: FlavoredModelsResult,
): ModelFlavor[] {
  // Build a reverse-lookup: modelId -> flavor
  const flavorMap = new Map<string, FlavorValue>();
  for (const modelId of flavors.orchestrator) {
    flavorMap.set(modelId, "orchestrator");
  }
  for (const modelId of flavors.worker) flavorMap.set(modelId, "worker");
  for (const modelId of flavors.swarm) flavorMap.set(modelId, "swarm");

  return enabledModels.map((id) => ({
    id,
    flavor: flavorMap.get(id) ?? "none",
  }));
}

/**
 * Build a summary line showing current flavor counts.
 *
 * @param flavors - The current model flavor assignments
 * @returns A human-readable summary string
 */
export function buildFooterSummary(flavors: ModelFlavor[]): string {
  const count = (flavor: FlavorValue): number =>
    flavors.filter((f) => f.flavor === flavor).length;
  return (
    `orchestrator:${count("orchestrator")} worker:${count("worker")} ` +
    `swarm:${count("swarm")} none:${count("none")}`
  );
}

/**
 * Write the current flavor assignments to settings.json.
 *
 * Performs a read-modify-write to preserve all existing keys.
 *
 * @param flavors - The current model flavor assignments
 * @param settingsPath - Path to the settings file
 * @throws If the file cannot be read or written
 */
export function writeFlavorsToSettings(
  flavors: ModelFlavor[],
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): void {
  const config = readSettings(settingsPath);

  for (const key of Object.keys(FLAVOR_SETTINGS_KEYS) as FlavorKey[]) {
    config[FLAVOR_SETTINGS_KEYS[key]] = flavors
      .filter((f) => f.flavor === key)
      .map((f) => f.id);
  }

  writeSettingsAtomic(config, settingsPath);
}
