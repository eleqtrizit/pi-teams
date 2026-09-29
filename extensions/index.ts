import { StringEnum } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { shQuote, type TerminalAdapter } from "../src/utils/terminal-adapter";
import * as messaging from "../src/utils/messaging";
import { updateLastAwokenTime } from "../src/utils/messaging";
import * as flavoredModels from "../src/utils/flavoredModels";
import {
  FLAVOR_VALUES,
  type FlavorKey,
  type FlavorValue,
  type FlavoredModelsResult,
  type ModelFlavor,
} from "../src/utils/flavoredModels";
import * as holdRun from "../src/utils/hold";
import { InboxMessage, Member } from "../src/utils/models";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null =
  null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

// Absolute path of the pi-teams extension entry loaded into THIS session.
// jiti provides __filename (and resolves import.meta.url) to the real module
// file whether pi-teams runs from a git checkout, a package install, or a
// standalone file. Spawned agents load exactly this entry with "-ne -e <path>"
// so they share the parent session's pi-teams copy instead of re-discovering
// it, which would double-register tools and fail to load.
const EXTENSION_ENTRY: string =
  typeof __filename !== "undefined" && __filename
    ? __filename
    : // @ts-expect-error: jiti resolves import.meta.url to the real module
      // file at runtime; tsc rejects it because the package builds into CJS.
      fileURLToPath(import.meta.url);

/**
 * CLI flags that make a spawned agent load exactly this extension instance.
 * Discovery is disabled so no other pi-teams copy (settings package or
 * project-local package) can register the same tools alongside it.
 */
function extensionLoadFlags(): string {
  return `-ne -e "${EXTENSION_ENTRY}"`;
}

/** A resolved model reference: full "provider/model" string split in two. */
export interface SubModelRef {
  provider: string;
  model: string;
}

/** Parsed arguments of the substitute-model command. */
export interface SubCommandArgs {
  modelRequest: string;
  prompt: string;
}

/** Which bang-model command a `$`-prefixed input maps to. */
export type BangModelCommandKind = "sub" | "worker" | "readonly-worker";

/** Parsed `$`-prefixed model command input. */
export interface BangModelCommandArgs {
  /** One `$` runs a substitute turn; `$$` spawns a worker, `$$$` a read-only worker */
  kind: BangModelCommandKind;
  /** Fuzzy model request, e.g. "opus-4" or "openai/gpt-5" */
  modelRequest: string;
  /** Everything after the model token */
  prompt: string;
}

/** One to three dollars; four or more is ordinary text, not a command prefix. */
const BANG_MODEL_INPUT = /^(\${1,3})(\S+)\s+(\S.*)$/;

/**
 * What a plausible model request looks like: a letter first, then word
 * characters, dots, slashes, colons, at-signs, or hyphens. Rejects dollar
 * amounts ("$100 note"), stray dollars ("$$$$$ money"), and plain numbers so
 * ordinary text reaches the model untouched.
 */
const MODEL_REQUEST_LIKE = /^[A-Za-z][\w./:@-]*$/;

/**
 * Parse a `$`-prefixed model command: "$<model> <prompt...>",
 * "$$<model> <prompt...>", or "$$$<model> <prompt...>".
 *
 * Input that does not match the shape, such as "$100 budget note" or a lone
 * "$model" without a prompt, is left as ordinary message text.
 *
 * @param text - Raw user input
 * @returns The parsed command, or null when the input is not a bang-model command
 */
export function parseBangModelCommand(
  text: string,
): BangModelCommandArgs | null {
  const match = BANG_MODEL_INPUT.exec(text);
  if (!match || !MODEL_REQUEST_LIKE.test(match[2])) {
    return null;
  }
  const kind: BangModelCommandKind =
    match[1].length === 1
      ? "sub"
      : match[1].length === 2
        ? "worker"
        : "readonly-worker";
  return { kind, modelRequest: match[2], prompt: match[3].trim() };
}

/**
 * Parse substitute-model input: "<model name> <prompt...>" (the "$" prefix is
 * stripped by the input handler before this runs).
 *
 * @param args - Raw argument string: the model request and prompt
 * @returns The model request and prompt, or null when either part is missing
 */
export function parseSubCommandArgs(args: string): SubCommandArgs | null {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return null;
  }
  const modelRequest = trimmed.slice(0, firstSpace);
  const prompt = trimmed.slice(firstSpace).trim();
  if (!prompt) {
    return null;
  }
  return { modelRequest, prompt };
}

/** Injected collaborators of executeSubTurn, kept minimal for testability. */
export interface SubTurnDeps {
  /** Model the session ran with before the substitution */
  originalModel: SubModelRef;
  /** Resolves the user's model request, or null when nothing matches */
  resolve: (modelRequest: string) => SubModelRef | null;
  /** Activates a model; resolves false when the provider is not authenticated */
  setModel: (model: SubModelRef) => Promise<boolean>;
  /** Sends the prompt to the agent for one turn */
  runPrompt: (prompt: string) => Promise<void>;
  /** Resolves when the agent is idle again after the turn */
  waitForIdle: () => Promise<void>;
  /** Shows a status or error message to the user */
  notify: (message: string, level: "info" | "error") => void;
}

/**
 * Run one turn with a substitute model, then restore the original model.
 *
 * The original model is restored even when the prompt run or the idle wait
 * throws, so the session never stays pinned to the substitute model.
 *
 * @param deps - Collaborators for resolution, model switching, prompting
 * @param modelRequest - The user's model request, bare or provider-prefixed
 * @param prompt - The prompt text to run with the substitute model
 */
export async function executeSubTurn(
  deps: SubTurnDeps,
  modelRequest: string,
  prompt: string,
): Promise<void> {
  const substitute = deps.resolve(modelRequest);
  if (!substitute) {
    deps.notify("Could not resolve the substitute model.", "error");
    return;
  }
  const switchResult = await deps.setModel(substitute);
  if (!switchResult) {
    deps.notify(
      `Provider "${substitute.provider}" is not authenticated; no model switch was made.`,
      "error",
    );
    return;
  }
  try {
    deps.notify(
      `Running one turn with ${substitute.provider}/${substitute.model}.`,
      "info",
    );
    await deps.runPrompt(prompt);
    await deps.waitForIdle();
  } finally {
    deps.notify(
      `Substitute turn done; restoring ${deps.originalModel.provider}/${deps.originalModel.model}.`,
      "info",
    );
    await deps.setModel(deps.originalModel);
  }
}

/**
 * Clear the available models cache. Useful for testing.
 */
export function clearModelsCache(): void {
  availableModelsCache = null;
  modelsCacheTime = 0;
}

export function formatDeliveredMessages(messages: InboxMessage[]): string {
  if (messages.length === 0) return "";

  const formatOne = (m: InboxMessage): string => {
    const ts = new Date(m.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return [
      `**From:** ${m.from}`,
      `**To:** ${m.to}`,
      `**Subject:** ${m.subject}`,
      `**Timestamp:** ${ts}`,
      "",
      m.text,
    ].join("\n");
  };

  if (messages.length === 1) return formatOne(messages[0]);

  const sections = messages.map(
    (m, index) =>
      `<delivered-message index="${index + 1}">\n${formatOne(m)}\n</delivered-message>`,
  );
  return [
    "Multiple messages were delivered. Address all of them:",
    ...sections,
  ].join("\n\n");
}

export function mergeQueuedMessages(messages: readonly string[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0];

  const sections = messages.map(
    (message, index) =>
      `<queued-message index="${index + 1}">\n${message}\n</queued-message>`,
  );

  return [
    "Multiple queued messages were produced. Address all of them:",
    ...sections,
  ].join("\n\n");
}

export class FollowUpMessageQueue {
  private messages: string[] = [];

  enqueue(message: string): void {
    const trimmedMessage = message.trim();
    if (trimmedMessage) {
      this.messages.push(trimmedMessage);
    }
  }

  clear(): void {
    this.messages = [];
  }

  flush(send: (message: string) => void): void {
    const messages = this.messages;
    this.messages = [];

    const mergedMessage = mergeQueuedMessages(messages);
    if (mergedMessage) {
      send(mergedMessage);
    }
  }
}

/**
 * Minimal model-registry interface used by this extension.
 */
interface ModelRegistryLike {
  getAvailable(): Array<{ provider: string; id: string }>;
}

/**
 * Query available models from Pi's in-process model registry.
 */
function getAvailableModels(
  modelRegistry: ModelRegistryLike,
): Array<{ provider: string; model: string }> {
  const now = Date.now();
  if (availableModelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return availableModelsCache;
  }

  try {
    const models = modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      model: model.id,
    }));

    availableModelsCache = models;
    modelsCacheTime = now;
    return models;
  } catch (_e) {
    return [];
  }
}

/** One argument-completion entry pi shows below the command line. */
export interface CommandCompletionItem {
  label: string;
  value: string;
}

/**
 * Complete the leading model argument of a typed command like "$<model> <prompt...>".
 *
 * Treats everything before the first space as the model token, so completions
 * are suppressed once the user starts typing the prompt. Within the token an
 * optional "provider/" prefix narrows the candidates, and the remaining text
 * is matched as a case-insensitive substring of the provider or model name.
 *
 * @param argumentPrefix - Text the user typed after the command name so far
 * @param models - Available models to complete against
 * @param maxItems - Upper bound on returned entries
 * @return: Up to maxItems "provider/model" completions, or null when there is nothing to offer
 */
export function completeModelArg(
  argumentPrefix: string,
  models: Array<{ provider: string; model: string }>,
  maxItems = 12,
): CommandCompletionItem[] | null {
  // Model names never contain spaces, so any space after the leading
  // whitespace means the user has moved on to typing the prompt.
  if (argumentPrefix.trim().includes(" ")) return null;
  const modelToken = argumentPrefix.split(" ", 1)[0];
  const tokenParts = modelToken.split("/", 2);
  const providerPrefix =
    tokenParts.length === 2 ? tokenParts[0].toLowerCase() : null;
  const namePrefix = (
    tokenParts.length === 2 ? tokenParts[1] : modelToken
  ).toLowerCase();
  const items = models
    .filter(
      (m) =>
        (providerPrefix === null ||
          m.provider.toLowerCase() === providerPrefix) &&
        (namePrefix === "" ||
          m.model.toLowerCase().includes(namePrefix) ||
          m.provider.toLowerCase().includes(namePrefix)),
    )
    .slice(0, maxItems)
    .map((m) => ({
      label: `${m.provider}/${m.model}`,
      value: `${m.provider}/${m.model}`,
    }));
  return items.length > 0 ? items : null;
}

/** One to three dollars; four or more is ordinary text, not a command prefix. */
const BANG_MODEL_TYPED_PREFIX = /^(\${1,3})(\S*)$/;

/** One suggestion pi's editor can complete: what to insert and how to show it. */
interface BangCompletionItem {
  label: string;
  value: string;
  description?: string;
}

/**
 * Subset of pi-tui's AutocompleteProvider the wrapper needs. Optional
 * `options` mirrors the runtime signature (abort signal, Tab force flag);
 * the vendored peer types predate it.
 */
interface EditorAutocompleteProvider {
  /** Characters that auto-trigger this provider at token boundaries. */
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options?: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: BangCompletionItem[]; prefix: string } | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: BangCompletionItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

/**
 * Runtime shape of pi's UI context. The vendored peer types lack
 * addAutocompleteProvider, so the install site casts through this interface.
 */
interface EditorUIContext {
  addAutocompleteProvider?: (
    factory: (
      current: EditorAutocompleteProvider,
    ) => EditorAutocompleteProvider,
  ) => void;
}

/**
 * Wrap pi's autocomplete provider so `$`, `$$`, and `$$$` prefixes offer the
 * model list while the user is typing the model token.
 *
 * Prefixes without a leading run of one to three dollars fall through to the
 * wrapped provider unchanged. Completion values carry the dollar prefix, so
 * accepting a suggestion keeps it in place.
 *
 * @param getModels - Supplies the models to complete against at call time
 * @return: A factory that wraps the current autocomplete provider
 */
export function createBangModelCompletionFactory(
  getModels: () => Array<{ provider: string; model: string }>,
): (current: EditorAutocompleteProvider) => EditorAutocompleteProvider {
  return (current) => ({
    // pi's editor only auto-opens completions for a known trigger character
    // (defaults: "@" and "#"). Declaring "$" here makes typing a dollar sign
    // open the popup; pi_tui merges this into the editor's trigger set.
    triggerCharacters: ["$"],
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const textBefore = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = BANG_MODEL_TYPED_PREFIX.exec(textBefore);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // The regex anchors at the line start, so a space anywhere before the
      // cursor means the user is already typing the prompt; no completions.
      const items = completeModelArg(match[2], getModels());
      if (!items) {
        return null;
      }
      return {
        items: items.map((item) => ({
          ...item,
          value: `${match[1]}${item.value}`,
        })),
        prefix: textBefore,
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  });
}

/**
 * Provider priority list - OAuth/subscription providers first (cheaper), then API-key providers
 */
const PROVIDER_PRIORITY = [
  // OAuth / Subscription providers (typically free/cheaper)
  "google-gemini-cli", // Google Gemini CLI - OAuth, free tier
  "github-copilot", // GitHub Copilot - subscription
  "kimi-sub", // Kimi subscription
  // API key providers
  "anthropic",
  "openai",
  "google",
  "zai",
  "openrouter",
  "azure-openai",
  "amazon-bedrock",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "vercel-ai-gateway",
];

/**
 * Resolve provider rank. Lower values are preferred.
 * Custom providers (not in built-in priority list) are preferred over built-in providers.
 */
function getProviderPriority(provider: string): number {
  const index = PROVIDER_PRIORITY.indexOf(provider.toLowerCase());
  return index === -1 ? -1 : index + 1;
}

/**
 * Compare two registry entries by provider priority, then provider name.
 */
function byProviderPriority(
  a: { provider: string; model: string },
  b: { provider: string; model: string },
): number {
  return (
    getProviderPriority(a.provider) - getProviderPriority(b.provider) ||
    a.provider.localeCompare(b.provider)
  );
}

/**
 * Resolve a model request to provider/model.
 *
 * Provider-prefixed requests resolve strictly within the named provider. Bare
 * names walk a priority ladder: the flavored models from pi settings first
 * (high/med/fast), then the session's scoped models (pi --models flag, or the
 * enabledModels list when the flag is absent), then the entire registry. The
 * fuzzy match runs only against the first non-empty group, so a configured
 * group always wins: a flavored model is returned when any flavored model is
 * set, and a scoped model is returned when any scoped model is set.
 *
 * @param modelName - The user's model request, bare or provider-prefixed
 * @param modelRegistry - Registry providing available models
 * @param scope - Ladder group overrides; groups are read from pi settings and
 * the pi argv when omitted. Passing a group's key with an empty list means the
 * group is unset and the tier is skipped.
 * @returns The full provider/model string or null if not found
 */
export function resolveModelWithProvider(
  modelName: string,
  modelRegistry: ModelRegistryLike,
  scope?: {
    /** Overrides the flavored-model group ids; pi settings are read when omitted */
    flavoredModelIds?: string[];
    /** Overrides the scoped-model patterns; pi's scope is read when omitted */
    scopedPatterns?: string[];
  },
): string | null {
  const availableModels = getAvailableModels(modelRegistry);
  if (availableModels.length === 0) {
    return null;
  }

  // If already has provider prefix, resolve strictly within that provider only.
  // Never fall back to a different provider — that causes false positives like
  // resolve_model("vyper/Qwen-35B") returning bighank/Qwen-35B.
  if (modelName.includes("/")) {
    const [providerPart, modelPart] = modelName.split("/", 2);
    const provider = providerPart.toLowerCase();
    const modelId = modelPart.toLowerCase();
    const exists = availableModels.some(
      (m) =>
        m.provider.toLowerCase() === provider &&
        m.model.toLowerCase() === modelId,
    );
    if (exists) {
      return modelName;
    }
    // Try resolving model-id scoped to the named provider only.
    const providerModels = availableModels.filter(
      (m) => m.provider.toLowerCase() === provider,
    );
    if (providerModels.length > 0) {
      const scopedRegistry: ModelRegistryLike = {
        getAvailable: () =>
          providerModels.map((m) => ({ provider: m.provider, id: m.model })),
      };
      const scopedResult = resolveModelWithProvider(modelPart, scopedRegistry);
      if (scopedResult) {
        return scopedResult;
      }
    }
    // No match within the specified provider — return null instead of searching across all providers.
    return null;
  }

  const lowerModelName = modelName.toLowerCase();

  // Resolution ladder: flavored models first, then the session's scoped
  // models, then the entire registry. Each group resolves with exact,
  // partial-token, and fuzzy matching; the first non-empty group wins and is
  // never bypassed. Group overrides act as testing hooks: an empty list means
  // the group is unset and pi settings are not consulted.
  const groups: Array<Array<{ provider: string; model: string }>> = [
    scope?.flavoredModelIds
      ? buildFlavoredModelGroup(availableModels, scope.flavoredModelIds)
      : getFlavoredModelGroup(availableModels),
    scope?.scopedPatterns
      ? buildScopedModelGroup(availableModels, scope.scopedPatterns)
      : getScopedModelGroup(availableModels),
    availableModels,
  ];
  for (const group of groups) {
    if (group.length === 0) {
      continue;
    }

    // Find exact matches (case-insensitive) and sort by provider priority
    const exactMatches = group.filter(
      (m) => m.model.toLowerCase() === lowerModelName,
    );
    if (exactMatches.length > 0) {
      exactMatches.sort(byProviderPriority);
      return `${exactMatches[0].provider}/${exactMatches[0].model}`;
    }

    const queryTokens = tokenizeForSearch(modelName);

    // Try partial/token match (model name contains all query tokens)
    const partialMatches = group
      .filter((m) => {
        const normalizedModel = normalizeForSearch(m.model);
        return queryTokens.every((token) => normalizedModel.includes(token));
      })
      .sort(byProviderPriority);
    if (partialMatches.length > 0) {
      return `${partialMatches[0].provider}/${partialMatches[0].model}`;
    }

    // Fall back to composite-aware token matching within this group only
    const topMatches = getTopModelsFromList(group, modelName, 1);
    if (topMatches.length > 0) {
      return topMatches[0].model;
    }
  }
  return null;
}

/**
 * Map flavored model ids to registry-available models.
 *
 * Flavored ids are pi settings' high/med/fast entries; each id matches either
 * the "provider/modelId" pair or the bare model id, case-insensitively.
 *
 * @param availableModels - Registry-available models
 * @param flavoredIds - Flavored model ids from pi settings
 * @returns The registry-available flavored models, deduplicated
 */
export function buildFlavoredModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
  flavoredIds: string[],
): Array<{ provider: string; model: string }> {
  const flavored = new Set(
    flavoredIds.map((id) => id.toLowerCase()).filter(Boolean),
  );
  if (flavored.size === 0) {
    return [];
  }
  const group: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  for (const entry of availableModels) {
    const fullId = `${entry.provider}/${entry.model}`.toLowerCase();
    if (!flavored.has(fullId) && !flavored.has(entry.model.toLowerCase())) {
      continue;
    }
    if (seen.has(fullId)) {
      continue;
    }
    seen.add(fullId);
    group.push(entry);
  }
  return group;
}

/**
 * Match a scoped-model pattern against a registry entry.
 *
 * Patterns are case-insensitive, support * and ? globs, and may end in a
 * ":thinking-level" suffix which is ignored for matching. pi's own
 * minimatch-based scope additionally supports char classes; this matcher
 * compares those characters literally.
 *
 * @param pattern - Scoped-model pattern from the pi session
 * @param entry - Registry entry to match
 * @returns True when the pattern matches the entry
 */
export function scopedPatternMatches(
  pattern: string,
  entry: { provider: string; model: string },
): boolean {
  let core = pattern;
  const colonIdx = core.lastIndexOf(":");
  if (colonIdx !== -1) {
    const suffix = core.substring(colonIdx + 1).toLowerCase();
    if (["off", "minimal", "low", "medium", "high"].includes(suffix)) {
      core = core.substring(0, colonIdx);
    }
  }
  const lowerCore = core.toLowerCase();
  const fullId = `${entry.provider}/${entry.model}`.toLowerCase();
  const modelId = entry.model.toLowerCase();
  if (lowerCore.includes("*") || lowerCore.includes("?")) {
    return (
      globMatchesPattern(lowerCore, fullId) ||
      globMatchesPattern(lowerCore, modelId)
    );
  }
  return fullId === lowerCore || modelId === lowerCore;
}

/** Convert a glob pattern with * and ? wildcards into a matcher function. */
function globMatchesPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return regex.test(value);
}

/**
 * Map scoped-model patterns to registry-available models.
 *
 * @param availableModels - Registry-available models
 * @param patterns - Scoped-model patterns from the pi session
 * @returns The registry-available scoped models, deduplicated
 */
export function buildScopedModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
  patterns: string[],
): Array<{ provider: string; model: string }> {
  if (patterns.length === 0) {
    return [];
  }
  const group: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  for (const entry of availableModels) {
    if (!patterns.some((pattern) => scopedPatternMatches(pattern, entry))) {
      continue;
    }
    const key = `${entry.provider}/${entry.model}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    group.push(entry);
  }
  return group;
}

/**
 * Build the flavored-model group: the high/med/fast flavor lists from pi
 * settings.json mapped to registry-available models.
 *
 * @param availableModels - Registry-available models
 * @returns Group models, or an empty group when no flavors are set
 */
function getFlavoredModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
): Array<{ provider: string; model: string }> {
  try {
    const flavors = flavoredModels.readFlavoredModels();
    return buildFlavoredModelGroup(availableModels, [
      ...flavors.high,
      ...flavors.med,
      ...flavors.fast,
    ]);
  } catch (_e) {
    // Malformed settings leave the group empty and the ladder falls through.
    return [];
  }
}

/**
 * Build the scoped-model group: the pi session's scoped models mapped to
 * registry-available models.
 *
 * @param availableModels - Registry-available models
 * @returns Group models, or an empty group when no scoped models are set
 */
function getScopedModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
): Array<{ provider: string; model: string }> {
  return buildScopedModelGroup(availableModels, getScopedModelPatterns());
}

/**
 * Read the pi session's scoped model patterns.
 *
 * The scope always exists: pi resolves --models patterns when the session was
 * launched with the flag, and otherwise falls back to the enabledModels list
 * from pi settings.json.
 *
 * @returns The scoped-model patterns, or an empty array when none are configured
 */
function getScopedModelPatterns(): string[] {
  const argv = process.argv;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--models" && index + 1 < argv.length) {
      return argv[index + 1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  try {
    return flavoredModels.readEnabledModels();
  } catch (_e) {
    // Missing or malformed enabledModels leaves the scope empty.
    return [];
  }
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () =>
    Array<number>(cols).fill(0),
  );

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

/**
 * Normalize text for fuzzy matching by collapsing separators.
 */
function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Tokenize text for fuzzy matching.
 */
function tokenizeForSearch(value: string): string[] {
  return normalizeForSearch(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

const STOP_WORDS = new Set([
  "on",
  "the",
  "with",
  "for",
  "by",
  "in",
  "at",
  "to",
  "a",
  "an",
  "of",
  "and",
  "or",
]);

/**
 * Collapse a string to lowercase alphanumeric only (no spaces or separators).
 *
 * :param value: The string to collapse
 * :return: Collapsed lowercase alphanumeric string
 */
function collapse(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Tokenize a user query, filtering out stop words.
 *
 * :param value: The raw user query
 * :return: Array of meaningful query tokens (lowercase, alphanumeric only)
 */
function tokenizeQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Split a token on letter/number boundaries.
 * E.g., "qwen35b" → ["qwen", "35", "b"], "bighank" → ["bighank"]
 *
 * :param token: The token to split
 * :return: Array of sub-parts (or the original token if no split points)
 */
function splitToken(token: string): string[] {
  return token
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .split(" ")
    .filter((p) => p.length > 0);
}

/**
 * Score how well a query token matches a collapsed candidate.
 *
 * Returns a score reflecting match quality. For composite tokens
 * (like "qwen35b"), this sums the lengths of all contiguous
 * sub-segments that are found as direct substrings. This rewards
 * candidates where more of the token's sub-parts are adjacent.
 *
 * :param token: A single query token
 * :param collapsed: The collapsed candidate string
 * :return: Match strength score, or 0 for no match
 */
function tokenMatchStrength(token: string, collapsed: string): number {
  if (collapsed.includes(token)) return token.length * 2;

  const parts = splitToken(token);
  if (parts.length <= 1) return 0;

  // Check all parts exist (composite match)
  if (!parts.every((part) => collapsed.includes(part))) return 0;

  // Sum lengths of all contiguous sub-segments found as direct substrings.
  // For "qwen35b" → ["qwen","35","b"]:
  //   sub-segments: "qwen"(4), "qwen35"(6), "qwen35b"(7), "35"(2), "35b"(3), "b"(1)
  //   Against "...qwen35coder35bnothinking": "qwen"✓, "qwen35"✓, "35"✓, "35b"✓, "b"✓ = 4+6+2+3+1 = 16
  //   Against "...qwen35coder122b": "qwen"✓, "qwen35"✓, "35"✓, "b"✓ = 4+6+2+1 = 13
  let score = 0;
  for (let i = 0; i < parts.length; i++) {
    let segment = "";
    for (let j = i; j < parts.length; j++) {
      segment += parts[j];
      if (collapsed.includes(segment)) {
        score += segment.length;
      }
    }
  }

  return score;
}

/**
 * Count how many query tokens match a collapsed candidate string.
 *
 * :param queryTokens: The tokenized user query
 * :param collapsed: The collapsed candidate string (lowercase alphanumeric)
 * :return: Number of query tokens that match (direct or composite)
 */
function countMatches(queryTokens: string[], collapsed: string): number {
  return queryTokens.filter((t) => tokenMatchStrength(t, collapsed) > 0).length;
}

/**
 * Count how many query tokens exactly match a word-boundary segment of the
 * model's base name (last slash-delimited component of the model ID).
 * Using only the base name avoids false positives from provider-namespace
 * prefixes in model IDs like "qwen/qwen3-coder-480b".
 * E.g., for base "qwen3coder-35b", segments are ["qwen3coder", "35b"]; token
 * "35b" is an exact segment match while "qwen35" is not.
 *
 * :param queryTokens: The tokenized user query
 * :param modelId: The raw model identifier (not collapsed)
 * :return: Number of query tokens that exactly match a model segment
 */
function countExactSegmentMatches(
  queryTokens: string[],
  modelId: string,
): number {
  const baseName = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  const segments = new Set(
    baseName
      .toLowerCase()
      .split(/[-_.\s]+/)
      .map((s) => s.replace(/[^a-z0-9]/g, "")),
  );
  return queryTokens.filter((t) => segments.has(t)).length;
}

/**
 * Sum of match strengths for all query tokens. Higher = better quality
 * matches (direct substring worth 2, composite split worth 1).
 *
 * :param queryTokens: The tokenized user query
 * :param collapsed: The collapsed candidate string
 * :return: Total match strength score
 */
function matchQuality(queryTokens: string[], collapsed: string): number {
  return queryTokens.reduce(
    (sum, t) => sum + tokenMatchStrength(t, collapsed),
    0,
  );
}

/**
 * Find top model matches from an explicit model list by substring relevance
 * and Levenshtein distance.
 *
 * Matching is done by collapsing "provider/model" into a single lowercase
 * alphanumeric string and checking whether each query token appears as a
 * substring. Tokens that are composites like "35b" or "qwen3" are also
 * split on letter/number boundaries so their parts can match individually.
 *
 * @param models - The models to search
 * @param modelName - The user's free-form query string
 * @param limit - Maximum number of results to return
 * @returns Array of { model, distance } sorted by relevance
 */
function getTopModelsFromList(
  models: Array<{ provider: string; model: string }>,
  modelName: string,
  limit = 5,
): Array<{ model: string; distance: number }> {
  const query = modelName.trim().toLowerCase();
  const queryTokens = tokenizeQuery(query);
  const normalizedQuery = normalizeForSearch(query);

  return models
    .map((m) => {
      const fullId = `${m.provider}/${m.model}`;
      const collapsedFull = collapse(fullId);
      const collapsedModel = collapse(m.model);

      const matchCount = countMatches(queryTokens, collapsedFull);
      const quality = matchQuality(queryTokens, collapsedFull);
      const exactSegmentMatches = countExactSegmentMatches(
        queryTokens,
        m.model,
      );
      const distance = Math.min(
        levenshteinDistance(query, m.model.toLowerCase()),
        levenshteinDistance(query, fullId.toLowerCase()),
        levenshteinDistance(normalizedQuery, normalizeForSearch(m.model)),
        levenshteinDistance(normalizedQuery, normalizeForSearch(fullId)),
      );
      const containsFullQuery =
        collapsedFull.includes(collapse(query)) ||
        collapsedModel.includes(collapse(query));
      const providerPriority = getProviderPriority(m.provider);

      return {
        model: fullId,
        matchCount,
        exactSegmentMatches,
        quality,
        distance,
        containsFullQuery,
        providerPriority,
      };
    })
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.exactSegmentMatches - a.exactSegmentMatches ||
        b.quality - a.quality ||
        Number(b.containsFullQuery) - Number(a.containsFullQuery) ||
        a.distance - b.distance ||
        a.providerPriority - b.providerPriority ||
        a.model.localeCompare(b.model),
    )
    .map(({ model, distance }) => ({ model, distance }))
    .slice(0, limit);
}

/**
 * Find top model matches by substring relevance and Levenshtein distance.
 *
 * @param modelName - The user's free-form query string
 * @param modelRegistry - Registry providing available models
 * @param limit - Maximum number of results to return
 * @returns Array of { model, distance } sorted by relevance
 */
export function getTopModelMatches(
  modelName: string,
  modelRegistry: ModelRegistryLike,
  limit = 5,
): Array<{ model: string; distance: number }> {
  return getTopModelsFromList(
    getAvailableModels(modelRegistry),
    modelName,
    limit,
  );
}

/**
 * Bridge local TypeBox schemas into Pi's tool registration surface.
 *
 * Pi's extension typings brand ``TSchema`` from its own resolved ``typebox``
 * dependency. This package may resolve a different module instance, so a direct
 * assignment fails type checking despite runtime compatibility.
 *
 * :param schema: The locally created TypeBox schema
 * :type schema: TSchemaLike
 * :return: Schema cast compatible with Pi tool registration
 * :rtype: TSchemaLike
 */
function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

// ── Model categorization ───────────────────────────────────────────────────

/** Categorized enabled-model lists returned by the get_models tool. */
export interface GetModelsResult {
  oss: string[];
  frontier: string[];
}

// ── Flavored models ─────────────────────────────────────────────────────────

const FLAVOR_LABELS: Record<FlavorKey, string> = {
  high: "High Quality",
  med: "Medium",
  fast: "Fast",
};

const FLAVOR_BULLET: Record<FlavorKey, string> = {
  high: "\u25C6",
  med: "\u25CF",
  fast: "\u25B8",
};

/**
 * Classify a model identifier as frontier (GPT/Claude) or OSS.
 *
 * @param modelId - The full model identifier (e.g. "openai-codex/gpt-5.5")
 * @return "frontier" if the model id contains "gpt" or "claude" (case-insensitive), "oss" otherwise
 */
export function classifyModel(modelId: string): "frontier" | "oss" {
  const lower = modelId.toLowerCase();
  return lower.includes("gpt") || lower.includes("claude") ? "frontier" : "oss";
}

/**
 * Execute the get_models tool: read enabled models from pi settings.json and
 * return two lists: OSS (non-frontier) and frontier (GPT/Claude).
 *
 * @return Tool result content plus categorized model details
 * @throws If the settings file cannot be read or parsed
 */
export function executeGetModels(): {
  content: { type: "text"; text: string }[];
  details: GetModelsResult;
} {
  const models = flavoredModels.readEnabledModels();

  const oss = models.filter((m) => classifyModel(m) === "oss");
  const frontier = models.filter((m) => classifyModel(m) === "frontier");

  const output = [
    "## OSS Models",
    ...(oss.length > 0 ? oss.map((m) => `  - ${m}`) : ["  (none)"]),
    "",
    "## Frontier Models",
    ...(frontier.length > 0 ? frontier.map((m) => `  - ${m}`) : ["  (none)"]),
  ].join("\n");

  return {
    content: [{ type: "text", text: output }],
    details: { oss, frontier },
  };
}

/**
 * Theme for the flavored-models SettingsList.
 *
 * @param theme - The TUI theme object for applying color functions
 * @returns A fully-configured SettingsListTheme
 */
function buildSettingsListTheme(theme: {
  fg: (color: string, text: string) => string;
}): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) =>
      selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) =>
      selected ? theme.fg("warning", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "\u2192"),
    hint: (text: string) => theme.fg("dim", text),
  };
}

/**
 * Execute the get-flavored-models tool: read flavor-categorized models from
 * pi settings.json and return three lists (high/med/fast).
 *
 * @returns Tool result content plus flavor details
 * @throws If the settings file cannot be read or parsed
 */
function executeGetFlavoredModels(): {
  content: { type: "text"; text: string }[];
  details: FlavoredModelsResult;
} {
  const flavors = flavoredModels.readFlavoredModels();

  const sections = (["high", "med", "fast"] as const).flatMap((flavor) => {
    const items = flavors[flavor];
    return [
      `## ${FLAVOR_LABELS[flavor]} Models`,
      ...(items.length > 0
        ? items.map((m) => `  - ${m}`)
        : ["  (none configured)"]),
      "",
    ];
  });

  return {
    content: [{ type: "text", text: sections.join("\n") }],
    details: flavors,
  };
}

/**
 * Handler for the /flavored-models command.
 *
 * Opens an interactive SettingsList UI that lets the user assign each
 * enabled model to a flavor (high/med/fast/none). Changes are saved to
 * settings.json when the dialog closes.
 *
 * @param ctx - The extension context providing the UI interface
 */
async function handleFlavoredModelsCommand(
  ctx: ExtensionContext,
): Promise<void> {
  // ── Phase 1: Read current state ───────────────────────────────────────────

  let enabledModels: string[];
  try {
    enabledModels = flavoredModels.readEnabledModels();
  } catch (err) {
    ctx.ui.notify(
      `Failed to read settings: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  let flavors: FlavoredModelsResult;
  try {
    flavors = flavoredModels.readFlavoredModels();
  } catch (err) {
    ctx.ui.notify(
      `Failed to read flavors: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  // Build in-memory flavor state
  const modelFlavors: ModelFlavor[] = flavoredModels.buildModelFlavors(
    enabledModels,
    flavors,
  );

  // ── Phase 2: Open interactive UI ──────────────────────────────────────────

  await ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: unknown, done: (result?: void) => void) => {
      // Build SettingItems from current state
      const items: SettingItem[] = modelFlavors.map((mf) => ({
        id: mf.id,
        label: mf.id,
        currentValue: mf.flavor,
        values: [...FLAVOR_VALUES],
      }));

      const container = new Container();

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Flavored Model Configuration")),
        ),
      );
      container.addChild(new Spacer());

      // SettingsList
      const settingsTheme = buildSettingsListTheme(theme);
      const maxVisible = Math.min(items.length + 2, 15);

      const settingsList = new SettingsList(
        items,
        maxVisible,
        settingsTheme,
        (id: string, newValue: string) => {
          // Update in-memory state (no disk write yet)
          const mf = modelFlavors.find((f) => f.id === id);
          if (mf) {
            mf.flavor = newValue as FlavorValue;
          }
        },
        () => {
          // Cancel: discard changes, close dialog
          done(undefined);
        },
      );

      container.addChild(settingsList);
      container.addChild(new Spacer());

      // Footer hint
      const summary = flavoredModels.buildFooterSummary(modelFlavors);
      container.addChild(
        new Text(theme.fg("dim", `Enter/Space to cycle \u2022 Esc to cancel`)),
      );
      container.addChild(new Text(theme.fg("muted", summary)));

      return {
        render(width: number): string[] {
          return container.render(width);
        },
        invalidate(): void {
          container.invalidate();
        },
        handleInput(data: string): void {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  // ── Phase 3: Save on close ────────────────────────────────────────────────

  try {
    flavoredModels.writeFlavorsToSettings(modelFlavors);
    ctx.ui.notify(
      `Flavored models saved (${flavoredModels.buildFooterSummary(modelFlavors)})`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `Failed to save flavored-models config: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

/** Closing instruction appended to every insta-worker task prompt. */
export const INSTA_WORKER_INSTRUCTION =
  "When done, send message to the team-lead reporting back your results. Then, run close_myself tool to signal you are finished.";

/** Name prefix shared by insta teams and insta workers. */
export const INSTA_NAME_PREFIX = "insta-";

/** Tools granted to read-only workers at spawn and reported in spawn results. */
export const READONLY_WORKER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "send_message",
  "broadcast_message",
  "close_myself",
] as const;

/**
 * Split an insta-worker command's arguments into the model request and the
 * task prompt. The model request is the first whitespace-separated token;
 * everything after it is the prompt.
 *
 * @param args - Raw command argument string
 * @returns The model request and prompt, or null when args are empty
 */
export function parseInstaWorkerArgs(
  args: string,
): { modelRequest: string; prompt: string } | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { modelRequest: trimmed, prompt: "" };
  }
  return {
    modelRequest: trimmed.slice(0, spaceIndex),
    prompt: trimmed.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Derive a message subject from a task prompt: its first line, capped at 60
 * characters.
 *
 * @param prompt - Raw task prompt text
 * @returns The first prompt line, truncated to 60 characters when longer
 */
export function instaWorkerSubject(prompt: string): string {
  const line = prompt.split("\n")[0].trim();
  return line.length > 60 ? line.slice(0, 60) : line;
}

/**
 * Derive a unique worker name inside a team from an insta stamp.
 *
 * @param taken - Names already used by team members
 * @param now - Current timestamp used to stamp the name
 * @returns A worker name that is not present in taken
 */
export function uniqueInstaWorkerName(
  taken: Set<string>,
  now: number = Date.now(),
): string {
  const base = `${INSTA_NAME_PREFIX}${now.toString(36)}`;
  let name = base;
  let suffix = 0;
  while (taken.has(name)) {
    suffix++;
    name = `${base}-${suffix}`;
  }
  return name;
}

/**
 * Decide the team for an insta-worker run.
 *
 * Reuses the session's active team when it still exists so every insta worker
 * reports into the team the lead polls; otherwise produces a fresh unique
 * team name for creation.
 *
 * @param currentTeam - The session's current team name, or undefined
 * @param teamExists - Predicate for whether a team exists on disk
 * @param now - Current timestamp used to stamp a fresh team name
 * @returns The team to use and whether it still needs to be created
 */
export function resolveInstaTeam(
  currentTeam: string | undefined,
  teamExists: (team: string) => boolean,
  now: number = Date.now(),
): { team: string; created: boolean } {
  if (currentTeam && teamExists(currentTeam)) {
    return { team: currentTeam, created: false };
  }
  return { team: `${INSTA_NAME_PREFIX}${now.toString(36)}`, created: true };
}

/**
 * Resolve an insta-worker's model request to provider/model.
 *
 * A request matching "default" passes through; the spawn path resolves it to
 * the team-lead's current model. Any other bare name resolves through the
 * resolveModelWithProvider ladder: flavored models first, then the session's
 * scoped models, then the entire registry. The best matches are returned
 * alongside the resolved model for caller messaging.
 *
 * @param modelRequest - Raw model input from the command
 * @param modelRegistry - Registry providing available models
 * @param scope - Ladder group overrides passed through to the resolver
 * @returns The resolved provider/model (null when unresolvable) and best matches
 */
export function resolveInstaModel(
  modelRequest: string,
  modelRegistry: ModelRegistryLike,
  scope?: Parameters<typeof resolveModelWithProvider>[2],
): { resolved: string | null; matches: string[] } {
  if (/default/i.test(modelRequest)) {
    return { resolved: modelRequest, matches: [] };
  }
  return {
    resolved: resolveModelWithProvider(modelRequest, modelRegistry, scope),
    matches: getTopModelMatches(modelRequest, modelRegistry, 5).map(
      (m) => m.model,
    ),
  };
}

/**
 * Resolve the worker's model from raw spawn input.
 *
 * An undefined request or one matching "default" falls back to the team-lead's
 * current model. Any other request must be fully qualified as provider/model
 * and present in the model registry.
 *
 * @param ctx - Extension context providing the current model and registry
 * @param modelRequest - Raw model input from the caller, or undefined
 * @returns The fully qualified provider/model for the worker
 * @throws If no model resolves or the request is not registry-qualified
 */
export function resolveSpawnModel(
  ctx: ExtensionContext,
  modelRequest: string | undefined,
): string {
  const defaultModel = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : null;
  let chosenModel = modelRequest?.trim();
  if (!chosenModel || /default/i.test(chosenModel)) {
    chosenModel = defaultModel ?? undefined;
  }
  if (!chosenModel) {
    throw new Error(
      "No model is available for the worker. Pass an explicit model or " +
        "ensure the team-lead has a model configured.",
    );
  }
  if (!chosenModel.includes("/")) {
    throw new Error(
      `Model '${chosenModel}' is not fully qualified. ` +
        `Use resolve_model(model_name="${chosenModel}") first, then pass ` +
        `the returned provider/model value.`,
    );
  }
  const slashIndex = chosenModel.indexOf("/");
  const provider = chosenModel.slice(0, slashIndex).toLowerCase();
  const modelId = chosenModel.slice(slashIndex + 1).toLowerCase();
  const isAvailable = getAvailableModels(ctx.modelRegistry).some(
    (m) =>
      m.provider.toLowerCase() === provider &&
      m.model.toLowerCase() === modelId,
  );
  if (!isAvailable) {
    throw new Error(
      `Model '${chosenModel}' is not available in the current registry. ` +
        `Use resolve_model(model_name="...") to find a valid provider/model value.`,
    );
  }
  return chosenModel;
}

/**
 * Build the pi launch command and member identity for a spawned worker.
 *
 * Read-only workers receive the restricted tool list; teammates honor the
 * thinking level in the combined --model provider/model:thinking form.
 *
 * @param goals - Worker goals including readonlyWorker and thinking
 * @param chosenModel - Fully qualified provider/model resolved for the worker
 * @returns The launch command and the member agent type
 */
function buildWorkerCommand(
  goals: {
    readonlyWorker: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
  },
  chosenModel: string,
): { piCmd: string; agentType: "teammate" | "readonly-worker" } {
  const agentType = goals.readonlyWorker ? "readonly-worker" : "teammate";
  // Spawned agents must load exactly the pi-teams copy running in this
  // session: without -ne they would re-discover it (settings package and
  // project-local package) and fail to load on duplicate tool registration.
  // Use the combined --model provider/model:thinking format.
  const piBinary = process.argv[1] ? `node ${shQuote(process.argv[1])}` : "pi";
  let piCmd = `${piBinary} ${extensionLoadFlags()} --model ${shQuote(chosenModel)}`;
  if (!goals.readonlyWorker && goals.thinking) {
    piCmd = `${piCmd}:${goals.thinking}`;
  }
  if (goals.readonlyWorker) {
    piCmd = `${piCmd} --tools ${READONLY_WORKER_TOOLS.join(",")}`;
  }
  return { piCmd, agentType };
}

/**
 * Launch a worker process through the terminal adapter.
 *
 * Spawns a separate OS window when requested; otherwise spawns a pane next to
 * the last matching teammate pane in iTerm2.
 *
 * @param terminal - Detected terminal adapter
 * @param args - Launch details: sanitized names, command, environment, and team members
 * @returns The spawned terminal id (a window id or a pane id)
 */
function spawnWorkerProcess(
  terminal: TerminalAdapter,
  args: {
    teamName: string;
    name: string;
    cwd: string;
    piCmd: string;
    env: Record<string, string>;
    members: Member[];
    useSeparateWindow: boolean;
    readonlyWorker: boolean;
  },
): string {
  if (args.useSeparateWindow) {
    return terminal.spawnWindow({
      name: args.name,
      cwd: args.cwd,
      command: args.piCmd,
      env: args.env,
      teamName: args.teamName,
    });
  }
  if (terminal instanceof Iterm2Adapter) {
    // iTerm2 panes spawn next to the last teammate pane; read-only workers
    // also follow teammates.
    const candidates = args.members.filter(
      (m) =>
        m.tmuxPaneId.startsWith("iterm_") &&
        (args.readonlyWorker || m.agentType === "teammate"),
    );
    const lastCandidate =
      candidates.length > 0 ? candidates[candidates.length - 1] : null;
    terminal.setSpawnContext(
      lastCandidate?.tmuxPaneId
        ? { lastSessionId: lastCandidate.tmuxPaneId.replace("iterm_", "") }
        : {},
    );
  }
  return terminal.spawn({
    name: args.name,
    cwd: args.cwd,
    command: args.piCmd,
    env: args.env,
  });
}

/**
 * Pre-seed a worker's state files before its terminal process starts.
 *
 * Stamping the first-activation file makes the worker's session_start skip the
 * inbox-deletion cleanup, so messages delivered to the worker before or during
 * its boot are preserved.
 *
 * @param safeTeamName - Sanitized team name
 * @param safeName - Sanitized worker name
 */
function seedWorkerStateFiles(safeTeamName: string, safeName: string): void {
  const firstActivationFile = paths.firstActivationPath(safeTeamName, safeName);
  const lastMessageFile = paths.lastMessagePath(safeTeamName, safeName);
  const lastReportFile = paths.lastReportPath(safeTeamName, safeName);
  const lastAwokenFile = paths.lastAwokenPath(safeTeamName, safeName);
  const lastReminderFile = paths.lastReminderPath(safeTeamName, safeName);
  if (fs.existsSync(lastMessageFile)) fs.unlinkSync(lastMessageFile);
  if (fs.existsSync(lastReportFile)) fs.unlinkSync(lastReportFile);
  if (fs.existsSync(lastAwokenFile)) fs.unlinkSync(lastAwokenFile);
  if (fs.existsSync(lastReminderFile)) fs.unlinkSync(lastReminderFile);
  fs.mkdirSync(path.dirname(firstActivationFile), { recursive: true });
  fs.writeFileSync(firstActivationFile, Date.now().toString());
}

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentType = process.env.PI_AGENT_TYPE || "lead";
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  let teamName = process.env.PI_TEAM_NAME;

  // Tool identity: spawned workers carry PI_AGENT_TYPE "teammate" or
  // "readonly-worker"; every other session (the interactive lead or a lead
  // window) is the team-lead. A worker named "team-lead" is excluded from
  // worker tools because removeAgent refuses to remove any agent with that
  // name, so a close_myself call would silently leave it running.
  const isLead = agentType === "lead";
  const isWorker =
    (agentType === "teammate" || agentType === "readonly-worker") &&
    agentName !== "team-lead";

  // ── Spawn plumbing ────────────────────────────────────────────────────
  // spawn_teammate, spawn_readonly_worker, and the insta-worker commands all
  // share this path: model resolution, member record, state pre-seed, then
  // launch through the terminal adapter.

  interface SpawnWorkerGoals {
    team: string;
    name: string;
    cwd: string;
    /** Raw model input: undefined or "default" resolves to the lead's model */
    modelRequest?: string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
    separateWindow?: boolean;
    readonlyWorker: boolean;
  }

  interface SpawnedWorker {
    member: Member;
    terminalId: string;
    isWindow: boolean;
    model: string;
  }

  async function spawnTeamWorker(
    ctx: ExtensionContext,
    goals: SpawnWorkerGoals,
  ): Promise<SpawnedWorker> {
    const safeName = paths.sanitizeName(goals.name);
    const safeTeamName = paths.sanitizeName(goals.team);
    if (!teams.teamExists(safeTeamName)) {
      throw new Error(`Team ${goals.team} does not exist`);
    }
    if (!terminal) {
      throw new Error("No terminal adapter detected.");
    }
    const teamConfig = await teams.readConfig(safeTeamName);
    const model = resolveSpawnModel(ctx, goals.modelRequest);
    const useSeparateWindow =
      !goals.readonlyWorker &&
      (goals.separateWindow ?? teamConfig.separateWindows ?? false);
    if (useSeparateWindow && !terminal.supportsWindows()) {
      throw new Error(
        `Separate windows mode is not supported in ${terminal.name}.`,
      );
    }

    const { piCmd, agentType } = buildWorkerCommand(goals, model);
    const member: Member = {
      agentId: `${safeName}@${safeTeamName}`,
      name: safeName,
      agentType,
      model,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: goals.cwd,
      subscriptions: [],
      color: goals.readonlyWorker ? "green" : "blue",
      thinking: goals.readonlyWorker ? undefined : goals.thinking,
    };
    await teams.addMember(safeTeamName, member);

    const env: Record<string, string> = {
      ...process.env,
      PI_TEAM_NAME: safeTeamName,
      PI_AGENT_NAME: safeName,
      PI_AGENT_TYPE: agentType,
    };
    seedWorkerStateFiles(safeTeamName, safeName);

    let terminalId = "";
    try {
      terminalId = spawnWorkerProcess(terminal, {
        teamName: safeTeamName,
        name: safeName,
        cwd: goals.cwd,
        piCmd,
        env,
        members: teamConfig.members,
        useSeparateWindow,
        readonlyWorker: goals.readonlyWorker,
      });
    } catch (e) {
      throw new Error(
        `Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`,
      );
    }
    await teams.updateMember(
      safeTeamName,
      safeName,
      useSeparateWindow ? { windowId: terminalId } : { tmuxPaneId: terminalId },
    );

    return { member, terminalId, isWindow: useSeparateWindow, model };
  }

  const terminal = getTerminalAdapter();
  let inboxCheckInterval: ReturnType<typeof setInterval> | null = null;
  let titleRefreshTimeouts: ReturnType<typeof setTimeout>[] = [];
  let isAgentIdle = true;
  let isAgentRunning = false;
  // Captured from the first context that carries a model registry, so the
  // "$"-command completion can list available models before its handler
  // has ever run.
  let subModelRegistry: ModelRegistryLike | null = null;
  // Guards the one-time autocomplete-provider installation for "$" commands.
  let bangModelCompletionsInstalled = false;
  // Increments once a follow-up message has actually reached the agent's
  // followUp queue. The agent_end hold loop watches this counter to decide
  // when the run should continue with queued worker results.
  let followUpEpoch = 0;
  const pendingInboxNotifications = new FollowUpMessageQueue();

  function clearInboxCheckInterval(): void {
    if (inboxCheckInterval == null) {
      return;
    }
    clearInterval(inboxCheckInterval);
    inboxCheckInterval = null;
  }

  function clearTitleRefreshTimeouts(): void {
    for (const timeoutId of titleRefreshTimeouts) {
      clearTimeout(timeoutId);
    }
    titleRefreshTimeouts = [];
  }

  function setSessionTitle(ctx: ExtensionContext, title: string): void {
    ctx.ui.setTitle(title);
    terminal?.setTitle(title);
  }

  function scheduleTerminalTitleRefreshes(title: string): void {
    if (!terminal) {
      return;
    }
    clearTitleRefreshTimeouts();
    for (const delayMs of [500, 2000, 5000]) {
      const timeoutId = setTimeout(() => {
        terminal.setTitle(title);
      }, delayMs);
      titleRefreshTimeouts.push(timeoutId);
    }
  }

  function sendFollowUp(message: string): void {
    // deliverAs: 'followUp' queues the message and delivers it as a user
    // message at the start of the agent's next natural turn boundary.
    // This avoids interrupting mid-turn operations while still providing
    // real-time context before the agent begins new work.
    void (async () => {
      try {
        // Increment only after the promise resolves: the agent_end hold loop
        // must not observe the epoch change before the message has actually
        // reached the agent's followUp queue.
        await pi.sendUserMessage(message, { deliverAs: "followUp" });
        followUpEpoch++;
      } catch (_err) {
        // A transient failure (for example compaction in progress) must not
        // lose the message. Re-queue it so the next agent_end flush retries.
        pendingInboxNotifications.enqueue(message);
      }
    })();
  }

  /**
   * Deliver a formatted message body to this agent. While the agent is mid-run,
   * the message is queued and flushed as a follow-up at the run boundary so it
   * never interrupts active tool work. When idle, it is sent immediately to
   * wake the agent for a new turn.
   */
  function deliverPendingMessage(message: string): void {
    if (isAgentRunning) {
      pendingInboxNotifications.enqueue(message);
      return;
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage) {
      sendFollowUp(trimmedMessage);
    }
  }

  function startInboxPolling(): void {
    clearInboxCheckInterval();
    inboxCheckInterval = setInterval(async () => {
      if (!teamName) {
        return;
      }

      // Drain undelivered messages and deliver their full bodies as a single
      // user message. drainUndelivered marks them delivered atomically, so the
      // same batch is never delivered twice.
      const toDeliver = await messaging.drainUndelivered(teamName, agentName);
      if (toDeliver.length > 0) {
        deliverPendingMessage(formatDeliveredMessages(toDeliver));
        return;
      }

      // Reminder fallback: fires only when the agent is idle. Covers the case
      // where a delivered instruction's follow-up failed to wake the agent for
      // another turn, or the agent ended its turn without reporting back.
      if (isTeammate && isAgentIdle) {
        const allMsgs = await messaging.readInbox(teamName, agentName, false);
        const teamLeadMsgs = allMsgs.filter((m) => m.from === "team-lead");
        if (teamLeadMsgs.length > 0) {
          const latestInstructionTs = Math.max(
            ...teamLeadMsgs.map((m) => new Date(m.timestamp).getTime()),
          );
          const hasUndelivered = teamLeadMsgs.some((m) => !m.delivered);
          if (
            messaging.needsReminderMessage(
              teamName,
              agentName,
              latestInstructionTs,
              hasUndelivered,
            )
          ) {
            messaging.updateLastReminderTime(teamName, agentName);
            deliverPendingMessage(
              "Report back to the team-lead with your results, if you haven't already done so.",
            );
          }
        }
      }
    }, 1000);
  }

  // Block "sleep N" bash commands for agents that participate in a team.
  // Waiting agents must end their turn; the inbox polling loop wakes them
  // automatically when a message arrives. Sleeping wastes wall time and
  // tokens and delays responses to the team-lead.
  const SLEEP_COMMAND_PATTERN = /^sleep\s+\d+/;
  // Resolve the promise the "$" substitute command waits on when the run the
  // substitute prompt started reaches its end. The waiter is installed by the
  // input handler before it sends the prompt, so no agent_end can fire
  // unobserved in between; the agent is idle when the command runs, which
  // makes the next agent_end the turn's end.
  let subRunEndWaiter: (() => void) | null = null;
  pi.on("agent_end", () => {
    const waiter = subRunEndWaiter;
    if (waiter) {
      subRunEndWaiter = null;
      waiter();
    }
  });

  pi.on("tool_call", async (event) => {
    // Only enforce while a team is online; otherwise this would interfere
    // with ordinary sleep usage in standalone pi sessions.
    if (!teamName || !teams.teamExists(teamName)) {
      return;
    }
    if (event.toolName !== "bash") {
      return;
    }
    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") {
      return;
    }
    if (!SLEEP_COMMAND_PATTERN.test(input.command.trim())) {
      return;
    }
    return {
      block: true,
      reason:
        "Blocked: do not run sleep commands to wait for incoming messages. Stop sleeping and simply end your turn. Messages are delivered to you automatically; the system will notify you as soon as a new one arrives. Just say you are waiting and stop.",
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    isAgentRunning = false;
    subModelRegistry ??= ctx.modelRegistry;
    if (isLead && !bangModelCompletionsInstalled) {
      bangModelCompletionsInstalled = true;
      (ctx.ui as EditorUIContext).addAutocompleteProvider?.(
        createBangModelCompletionFactory(() =>
          subModelRegistry ? getAvailableModels(subModelRegistry) : [],
        ),
      );
    }
    pendingInboxNotifications.clear();
    paths.ensureDirs();
    if (isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
        fs.writeFileSync(pidFile, process.pid.toString());
      }
      ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");
      ctx.ui.setStatus("00-pi-teams", `[${agentName.toUpperCase()}]`);

      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      setSessionTitle(ctx, fullTitle);
      scheduleTerminalTitleRefreshes(fullTitle);

      // On first spawn, purge ALL stale state from any previous session and
      // stamp the firstActivationFile immediately (before messages can arrive).
      // Previously this cleanup ran at turn_start, which created a race: a message
      // sent between session_start and the first turn_start would be deleted when
      // the first turn fired and wiped the inbox.
      if (teamName) {
        const firstActivationFile = paths.firstActivationPath(
          teamName,
          agentName,
        );
        if (!fs.existsSync(firstActivationFile)) {
          const inboxFile = paths.inboxPath(teamName, agentName);
          const lastMessageFile = paths.lastMessagePath(teamName, agentName);
          const lastReportFile = paths.lastReportPath(teamName, agentName);
          const lastAwokenFile = paths.lastAwokenPath(teamName, agentName);
          const lastReminderFile = paths.lastReminderPath(teamName, agentName);
          if (fs.existsSync(inboxFile)) fs.unlinkSync(inboxFile);
          if (fs.existsSync(lastMessageFile)) fs.unlinkSync(lastMessageFile);
          if (fs.existsSync(lastReportFile)) fs.unlinkSync(lastReportFile);
          if (fs.existsSync(lastAwokenFile)) fs.unlinkSync(lastAwokenFile);
          if (fs.existsSync(lastReminderFile)) fs.unlinkSync(lastReminderFile);
          fs.writeFileSync(firstActivationFile, Date.now().toString());
        }
      }

      startInboxPolling();
    } else {
      if (teamName) {
        ctx.ui.setStatus("pi-teams", `Lead @ ${teamName}`);
      }

      startInboxPolling();
    }
  });

  function setActiveStatus(active: boolean) {
    if (!teamName) return;
    const teamDirectory = paths.teamDir(teamName);
    if (!fs.existsSync(teamDirectory)) {
      fs.mkdirSync(teamDirectory, { recursive: true });
    }
    const activeFile = path.join(teamDirectory, `${agentName}.active`);
    if (active) {
      const wasInactive = !fs.existsSync(activeFile);
      fs.writeFileSync(activeFile, Date.now().toString());
      // Track when agent wakes up (goes from inactive to active)
      if (wasInactive) {
        // Returning from idle - set awoken time to trigger reminder logic.
        // First-spawn cleanup is done in session_start before any messages arrive.
        updateLastAwokenTime(teamName, agentName);
      }
    } else {
      if (fs.existsSync(activeFile)) {
        fs.unlinkSync(activeFile);
      }
    }
  }

  function isAgentActive(team: string, agent: string): boolean {
    const activeFile = path.join(paths.teamDir(team), `${agent}.active`);
    if (!fs.existsSync(activeFile)) return false;
    try {
      const timestamp = parseInt(fs.readFileSync(activeFile, "utf-8").trim());
      const age = Date.now() - timestamp;
      return age < 5 * 60 * 1000; // Consider stale if older than 5 minutes
    } catch {
      return false;
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    isAgentIdle = false;
    setActiveStatus(true);
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      setSessionTitle(ctx, fullTitle);
    }
  });

  /**
   * Resolve after the given delay.
   *
   * @param ms - Delay in milliseconds
   */
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Decide liveness for one teammate. The pid file written at the member's
   * session_start is the most reliable signal: it needs only a filesystem
   * read plus a signal-0 probe, and it appears before the member's first
   * turn so booting workers count as alive. Pane and window probes and the
   * fresh activity marker remain as fallbacks.
   *
   * @param team - Name of the team the member belongs to
   * @param member - Team member to evaluate
   * @returns True when the member can still produce work or messages
   */
  function isMemberAlive(team: string, member: Member): boolean {
    if (isProcessAlive(path.join(paths.teamDir(team), `${member.name}.pid`))) {
      return true;
    }
    if (member.windowId && terminal?.isWindowAlive(member.windowId))
      return true;
    if (member.tmuxPaneId && terminal?.isAlive(member.tmuxPaneId)) return true;
    return isAgentActive(team, member.name);
  }

  /**
   * Check whether the process named by a pid file is still running.
   *
   * @param pidPath - Path to the pid file to probe
   * @returns True when the process is alive
   */
  function isProcessAlive(pidPath: string): boolean {
    if (!fs.existsSync(pidPath)) return false;
    try {
      const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isFinite(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but is owned by another user, which
      // still counts as running.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Capture what the hold loop needs to know about a team's state. A config
   * read error returns null so a transient file-lock wait never releases the
   * run by mistake.
   *
   * @param team - Name of the team to evaluate
   * @returns Team-liveness snapshot, or null when the config cannot be read
   */
  async function teamLivenessSnapshot(
    team: string,
  ): Promise<holdRun.TeamLivenessSnapshot | null> {
    if (!teams.teamExists(team)) {
      return { teamExists: false, workerCount: 0, liveWorkerCount: 0 };
    }
    try {
      const config = await teams.readConfig(team);
      const workers = config.members.filter((m) => m.name !== "team-lead");
      return {
        teamExists: true,
        workerCount: workers.length,
        liveWorkerCount: holdRun.countLiveWorkers(config, (member) =>
          isMemberAlive(team, member),
        ),
      };
    } catch (_err) {
      return null;
    }
  }

  /**
   * Hold the agent run open while the team is active so the host process does
   * not exit before workers report back.
   *
   * In print-like host modes pi exits as soon as the run settles, which would
   * strand spawned workers. Parking inside the agent_end handler keeps the run
   * alive with no LLM activity between worker updates. When a worker message
   * is queued as a followUp, the epoch counter changes, the hold releases, and
   * agent.continue() wakes the lead with the queued results.
   *
   * @param ctx - Extension context providing the run mode and abort signal
   * @param epochAtEntry - followUpEpoch value captured before pending inbox
   *   notifications were flushed
   */
  async function holdRunOpenForActiveTeam(
    ctx: ExtensionContext,
    epochAtEntry: number,
  ): Promise<void> {
    if (
      !holdRun.shouldHoldWhileTeamActive({
        hasUI: ctx.hasUI,
        isTeammate,
        teamName,
      })
    ) {
      return;
    }
    const activeTeam = teamName;
    if (!activeTeam) return;

    let livenessFailures = 0;
    for (let poll = 0; ; poll++) {
      if (followUpEpoch !== epochAtEntry) return;
      if (poll % holdRun.RUN_HOLD_LIVENESS_POLL_EVERY === 0) {
        const snapshot = await teamLivenessSnapshot(activeTeam);
        if (snapshot !== null) {
          livenessFailures =
            snapshot.liveWorkerCount > 0 ? 0 : livenessFailures + 1;
          if (holdRun.shouldReleaseRun(snapshot, livenessFailures)) return;
        }
      }
      await wait(holdRun.RUN_HOLD_MESSAGE_POLL_MS);
    }
  }

  pi.on("agent_start", async () => {
    isAgentRunning = true;
    pendingInboxNotifications.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    isAgentRunning = false;
    // Capture before the flush: messages queued by the flush advance the
    // epoch, so the hold releases immediately and the run continues with the
    // queued worker results instead of batching them while parked.
    const epochAtEntry = followUpEpoch;
    pendingInboxNotifications.flush(sendFollowUp);
    await holdRunOpenForActiveTeam(ctx, epochAtEntry);
  });

  pi.on("turn_end", async () => {
    isAgentIdle = true;
    setActiveStatus(false);
    if (isTeammate && teamName) {
      // If the agent ended its turn without reporting back after a delivered
      // team-lead instruction, steer it to do so now.
      const allMsgs = await messaging.readInbox(teamName, agentName, false);
      const teamLeadMsgs = allMsgs.filter((m) => m.from === "team-lead");
      if (teamLeadMsgs.length > 0) {
        const latestInstructionTs = Math.max(
          ...teamLeadMsgs.map((m) => new Date(m.timestamp).getTime()),
        );
        const hasUndelivered = teamLeadMsgs.some((m) => !m.delivered);
        if (
          messaging.needsReminderMessage(
            teamName,
            agentName,
            latestInstructionTs,
            hasUndelivered,
          )
        ) {
          messaging.updateLastReminderTime(teamName, agentName);
          const reminder =
            "Report back to the team-lead with your results, if you haven't already done so.";
          // Mid-run, queue for the run boundary so it never injects midstream;
          // when the run has actually ended, steer immediately.
          if (isAgentRunning) {
            pendingInboxNotifications.enqueue(reminder);
          } else {
            pi.sendUserMessage(reminder, { deliverAs: "steer" });
          }
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    clearInboxCheckInterval();
    clearTitleRefreshTimeouts();
    isAgentRunning = false;
    pendingInboxNotifications.clear();
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    // Lead running in an auto-exit host mode: the extension holds the run open
    // while the team is active. Tell the lead so it ends its turn instead of
    // polling, and releases the session through team_shutdown when done.
    if (
      !isTeammate &&
      holdRun.shouldGuideLead({ hasUI: ctx.hasUI, isTeammate })
    ) {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nNon-interactive session: when a team is active, the session stays alive after you end a turn. Worker messages arrive automatically as user messages; never poll, sleep, or run wait commands because they are blocked while a team is online. Respond with your plan or status and end your turn when workers are running. When every teammate has reported back and the work is complete, call team_shutdown with the team name; the team closes and the session exits normally.`,
      };
    }

    if (isTeammate && firstTurn) {
      firstTurn = false;

      let modelInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find((m) => m.name === agentName);
          if (member && member.model) {
            modelInfo = `\nYou are currently using model: ${member.model}`;
            if (member.thinking) {
              modelInfo += ` with thinking level: ${member.thinking}`;
            }
            modelInfo += `. When reporting your model or thinking level, use these exact values.`;
          }
        } catch (e) {
          // Ignore
        }
      }

      const roleDescription =
        agentType === "readonly-worker" ? "read-only worker" : "teammate";

      const capabilitiesNote =
        agentType === "readonly-worker"
          ? "\nYou are limited to reading files (read, grep, find, ls), messaging tools (send_message, broadcast_message), and close_myself. You cannot write, edit, or execute commands. Close yourself with close_myself only when your instructions tell you to."
          : "";

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nYou are ${roleDescription} '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${capabilitiesNote}\nMessages from teammates are delivered to you automatically as user messages; you do not need to fetch them. When your work is done, end your turn and stop — you will be woken automatically when the next message arrives.\n\nHARD RULES (violating these wastes tokens and breaks the team):\n- NEVER run sleep, polling, or wait commands (e.g. 'sleep 30', 'while true; do ...; done').\n- NEVER loop or poll to wait for messages. They arrive on their own.\n- When your work is done, simply stop. Do not announce that you are 'sleeping' or 'waiting' with a command. Just end your turn.`,
      };
    }
  });

  // ── Team-lead tools ─────────────────────────────────────────────────────
  // Everything a lead session needs to build, staff, inspect, and disband a
  // team. Registered for any session that is not a spawned worker.

  if (isLead) {
    pi.registerTool({
      name: "team_create",
      label: "Create Team",
      description: "Create a new agent team.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          description: Type.Optional(Type.String()),
          default_model: Type.Optional(Type.String()),
          separate_windows: Type.Optional(
            Type.Boolean({
              default: false,
              description:
                "Open teammates in separate OS windows instead of panes",
            }),
          ),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const config = teams.createTeam(
          params.team_name,
          "local-session",
          "lead-agent",
          params.description,
          params.default_model,
          params.separate_windows,
        );
        teamName = params.team_name;
        process.env.PI_TEAM_NAME = params.team_name;
        return {
          content: [
            { type: "text", text: `Team ${params.team_name} created.` },
          ],
          details: { config },
        };
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "resolve_model",
      label: "Resolve Model",
      description:
        'Resolve a provider/model name for use in spawn_teammate. ALWAYS provide the full <provider>/<model> format (e.g., "anthropic/claude-sonnet-4-20250514", "bighank/Qwen35Coder-35B-NoThinking"). ' +
        'To find what provider/model pairs are available: call get_available_models() or use "DEFAULT MODEL" which is the team-leader\'s own model. ' +
        "This tool ONLY searches within the specified provider when a provider prefix is given. Bare names resolve through a priority ladder: flavored models from pi settings first, then the scoped models (pi --models flag or the enabledModels list), then the full registry. If no match is found, try a different provider or use DEFAULT MODEL.",
      parameters: asPiToolSchema(
        Type.Object({
          model_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const requested = params.model_name.trim();
        if (!requested) {
          throw new Error("model_name must not be empty.");
        }

        const topMatches = getTopModelMatches(requested, ctx.modelRegistry, 5);
        const defaultModel = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : null;
        const resolved = resolveModelWithProvider(requested, ctx.modelRegistry);
        if (!resolved) {
          const matchesText = topMatches.map((m) => m.model).join(", ");
          const outputText = defaultModel
            ? `DEFAULT MODEL: ${defaultModel}, Best matches: ${matchesText}`
            : matchesText;
          return {
            content: [
              {
                type: "text",
                text: outputText,
              },
            ],
            details: {
              requested,
              resolved_model: null,
              top_matches: topMatches,
              default_model: defaultModel,
            },
          };
        }

        return {
          content: [{ type: "text", text: resolved }],
          details: {
            requested,
            resolved_model: resolved,
            top_matches: topMatches,
            default_model: defaultModel,
          },
        };
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "spawn_teammate",
      label: "Spawn Teammate",
      description:
        "Spawn a new teammate in a terminal pane or separate window.\n\n" +
        "Model selection: before spawning, call get_flavored_models to see the " +
        "configured high/med/fast model lists. Pick a model whose flavor matches " +
        "the task (high = deep reasoning, med = balanced work, fast = quick " +
        "lookups/simple edits), and prefer spreading teammates across different " +
        "providers unless the user names specific models. If no flavors are " +
        "configured, spawn the same model as yours (the team lead's).\n\n" +
        "If you pass a model explicitly, it must be fully qualified as " +
        "provider/model. Use resolve_model first if you only know a model name.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          name: Type.String(),
          cwd: Type.String(),
          model: Type.Optional(
            Type.String({
              description:
                "Fully-qualified provider/model. Omit to follow the " +
                "get_flavored_models guidance (flavor-matched, provider-diverse, " +
                "falling back to the team lead's model).",
            }),
          ),
          thinking: Type.Optional(
            StringEnum(["off", "minimal", "low", "medium", "high"]),
          ),
          separate_window: Type.Optional(Type.Boolean({ default: false })),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const spawned = await spawnTeamWorker(ctx, {
          team: params.team_name,
          name: params.name,
          cwd: params.cwd,
          modelRequest: params.model,
          thinking: params.thinking,
          separateWindow: params.separate_window,
          readonlyWorker: false,
        });
        return {
          content: [
            {
              type: "text",
              text: `Teammate ${params.name} spawned in ${spawned.isWindow ? "window" : "pane"} ${spawned.terminalId}.`,
            },
          ],
          details: {
            agentId: spawned.member.agentId,
            terminalId: spawned.terminalId,
            isWindow: spawned.isWindow,
          },
        };
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "spawn_readonly_worker",
      label: "Spawn Read-Only Worker",
      description:
        "Spawn a read-only worker agent that can only read, grep, find, and ls files. No bash, write, or edit access. Despite being read-only, the worker can still use messaging tools (send_message, broadcast_message) to communicate with the team lead, and it can close itself with close_myself.\n\n" +
        "Model selection: before spawning, call get_flavored_models and spawn a " +
        "model from the flavor that matches the task (usually fast or med for " +
        "read-only research). Prefer spreading workers across different providers " +
        "unless the user names specific models. If no flavors are configured, " +
        "spawn the same model as yours (the team lead's).",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          name: Type.String(),
          cwd: Type.String(),
          model: Type.Optional(
            Type.String({
              description:
                "Fully-qualified provider/model, e.g. from the " +
                "get_flavored_models lists. Omit to use the team lead's model.",
            }),
          ),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const spawned = await spawnTeamWorker(ctx, {
          team: params.team_name,
          name: params.name,
          cwd: params.cwd,
          modelRequest: params.model,
          readonlyWorker: true,
        });
        return {
          content: [
            {
              type: "text",
              text: `Read-only worker ${params.name} spawned in pane ${spawned.terminalId}. Restricted to: read, grep, find, ls, messaging (send_message, broadcast_message), and close_myself.`,
            },
          ],
          details: {
            agentId: spawned.member.agentId,
            terminalId: spawned.terminalId,
            tools: [...READONLY_WORKER_TOOLS],
          },
        };
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "spawn_lead_window",
      label: "Spawn Lead Window",
      description: "Open the team lead in a separate OS window.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          cwd: Type.Optional(Type.String()),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const safeTeamName = paths.sanitizeName(params.team_name);
        if (!teams.teamExists(safeTeamName))
          throw new Error(`Team ${params.team_name} does not exist`);
        if (!terminal || !terminal.supportsWindows())
          throw new Error("Windows mode not supported.");

        const teamConfig = await teams.readConfig(safeTeamName);
        const cwd = params.cwd || process.cwd();
        const piBinary = process.argv[1] ? `node ${process.argv[1]}` : "pi";
        let piCmd = `${piBinary} ${extensionLoadFlags()}`;
        if (teamConfig.defaultModel) {
          // Use the combined --model provider/model format
          piCmd = `${piCmd} --model ${teamConfig.defaultModel}`;
        }

        const env = {
          ...process.env,
          PI_TEAM_NAME: safeTeamName,
          PI_AGENT_NAME: "team-lead",
        };
        try {
          const windowId = terminal.spawnWindow({
            name: "team-lead",
            cwd,
            command: piCmd,
            env,
            teamName: safeTeamName,
          });
          await teams.updateMember(safeTeamName, "team-lead", { windowId });
          return {
            content: [
              { type: "text", text: `Lead window spawned: ${windowId}` },
            ],
            details: { windowId },
          };
        } catch (e) {
          throw new Error(`Failed: ${e}`);
        }
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "team_shutdown",
      label: "Shutdown Team",
      description: "Shutdown the entire team and close all panes/windows.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const teamName = params.team_name;
        try {
          const config = await teams.readConfig(teamName);
          for (const member of config.members) {
            await teams.removeAgent({
              team: teamName,
              agentName: member.name,
              terminal,
            });
          }
          const dir = paths.teamDir(teamName);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
          return {
            content: [{ type: "text", text: `Team ${teamName} shut down.` }],
            details: {},
          };
        } catch (e) {
          throw new Error(`Failed to shutdown team: ${e}`);
        }
      },
    });
  }

  if (isLead) {
    pi.registerTool({
      name: "close_worker",
      label: "Close Worker",
      description: "Process a teammate's shutdown.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          agent_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const config = await teams.readConfig(params.team_name);
        const member = config.members.find((m) => m.name === params.agent_name);
        if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

        await teams.removeAgent({
          team: params.team_name,
          agentName: params.agent_name,
          terminal,
        });
        return {
          content: [
            {
              type: "text",
              text: `Teammate ${params.agent_name} has been shut down.`,
            },
          ],
          details: {},
        };
      },
    });

    // Flavored models: tool + interactive command
    pi.registerTool({
      name: "get_flavored_models",
      label: "Get Flavored Models",
      description:
        "Read flavor-categorized models from pi settings.json and return three " +
        "lists: high (high-quality/deep reasoning), med (balanced performance), " +
        "and fast (quick responses).",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        try {
          return executeGetFlavoredModels();
        } catch (e) {
          throw new Error(`Failed to read flavored models: ${e}`);
        }
      },
      renderCall(_args: any, theme: any): any {
        const text = new Text("", 0, 0);
        text.setText(theme.fg("toolTitle", theme.bold("get_flavored_models")));
        return text;
      },
      renderResult(
        result: any,
        _options: { expanded: boolean },
        theme: any,
      ): any {
        const text = new Text("", 0, 0);
        const details = result.details as FlavoredModelsResult | undefined;
        if (!details) {
          text.setText(theme.fg("error", "[no result]"));
          return text;
        }

        const lines = (["high", "med", "fast"] as FlavorKey[]).flatMap(
          (key) => {
            const items = details[key];
            const color =
              key === "high" ? "accent" : key === "med" ? "success" : "warning";
            const modelLines =
              items.length > 0
                ? items.map(
                    (m) => `  ${theme.fg(color, FLAVOR_BULLET[key])} ${m}`,
                  )
                : [theme.fg("dim", "  (none configured)")];
            return [
              theme.fg("toolTitle", theme.bold(`${FLAVOR_LABELS[key]} Models`)),
              ...modelLines,
              "",
            ];
          },
        );

        text.setText(lines.join("\n"));
        return text;
      },
    });

    pi.registerTool({
      name: "get_models",
      label: "Get Models",
      description:
        "Read enabled models from pi settings.json and return two lists: " +
        'OSS (models not containing "gpt" or "claude", e.g. Qwen, DeepSeek, ' +
        'Nemotron) and frontier (models containing "gpt" or "claude", e.g. ' +
        "GPT-5.x, Claude Sonnet).",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        try {
          return executeGetModels();
        } catch (e) {
          throw new Error(`Failed to read enabled models: ${e}`);
        }
      },
      renderCall(_args: any, theme: any): any {
        const text = new Text("", 0, 0);
        text.setText(theme.fg("toolTitle", theme.bold("get_models")));
        return text;
      },
      renderResult(
        result: any,
        _options: { expanded: boolean },
        theme: any,
      ): any {
        const text = new Text("", 0, 0);
        const details = result.details as GetModelsResult | undefined;
        if (!details) {
          text.setText(theme.fg("error", "[no result]"));
          return text;
        }

        const ossList =
          details.oss.length > 0
            ? details.oss
                .map((m) => `  ${theme.fg("success", "\u25CF")} ${m}`)
                .join("\n")
            : theme.fg("dim", "  (none)");
        const frontierList =
          details.frontier.length > 0
            ? details.frontier
                .map((m) => `  ${theme.fg("accent", "\u25C6")} ${m}`)
                .join("\n")
            : theme.fg("dim", "  (none)");

        text.setText(
          [
            theme.fg("toolTitle", theme.bold("OSS Models")),
            ossList,
            "",
            theme.fg("toolTitle", theme.bold("Frontier Models")),
            frontierList,
          ].join("\n"),
        );
        return text;
      },
    });

    pi.registerCommand("flavored-models", {
      description: "Configure model flavor assignments (high/med/fast/none)",
      handler: (_args: string, ctx: ExtensionContext) =>
        handleFlavoredModelsCommand(ctx),
    });

    pi.on("input", async (event, ctx) => {
      // Only typed input goes through the bang commands. Worker deliveries and
      // other extension-sourced messages flow through this same handler via
      // pi.sendUserMessage, and a report that happens to start with
      // "$<model> <prompt>" must reach the lead as ordinary text.
      if (event.source !== "interactive") {
        return { action: "continue" };
      }
      const parsed = parseBangModelCommand(event.text);
      if (!parsed) {
        return { action: "continue" };
      }
      subModelRegistry ??= ctx.modelRegistry;
      const args = `${parsed.modelRequest} ${parsed.prompt}`;
      if (parsed.kind === "sub") {
        await runSubCommand(args, ctx);
      } else {
        await runInstaWorkerCommand(
          args,
          ctx,
          parsed.kind === "readonly-worker",
        );
      }
      return { action: "handled" };
    });

    /**
     * Handle "$<model> <prompt...>": switch to a fuzzy-matched substitute
     * model for exactly one turn, run the prompt, and restore the original
     * model afterwards.
     *
     * @param args - Raw argument string: "<model name> <prompt...>"
     * @param ctx - Command context for the current session
     */
    async function runSubCommand(
      args: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const parsed = parseSubCommandArgs(args);
      if (!parsed) {
        instaNotify(ctx, "Usage: $<model name> <prompt...>", "error");
        return;
      }
      if (!ctx.isIdle()) {
        instaNotify(
          ctx,
          "$ needs an idle agent; wait for the current run to finish.",
          "error",
        );
        return;
      }
      const original = ctx.model;
      if (!original) {
        instaNotify(ctx, "No model is active in this session.", "error");
        return;
      }
      // Armed before the prompt is sent: the agent is idle, so the next
      // agent_end event marks the end of the substitute turn.
      const subTurnRunEndPromise = new Promise<void>((resolve) => {
        subRunEndWaiter = resolve;
      });
      await executeSubTurn(
        {
          originalModel: { provider: original.provider, model: original.id },
          resolve: (modelRequest) => {
            const full = resolveModelWithProvider(
              modelRequest,
              ctx.modelRegistry,
            );
            if (!full) {
              return null;
            }
            const slashIndex = full.indexOf("/");
            const found = ctx.modelRegistry.find(
              full.slice(0, slashIndex),
              full.slice(slashIndex + 1),
            );
            return found ? { provider: found.provider, model: found.id } : null;
          },
          setModel: async (ref) => {
            const found = ctx.modelRegistry.find(ref.provider, ref.model);
            if (!found) {
              return false;
            }
            return pi.setModel(found);
          },
          runPrompt: (prompt) => {
            pi.sendUserMessage(prompt);
            return Promise.resolve();
          },
          // ctx.waitForIdle() would resolve immediately here: the prompt is
          // queued asynchronously and the agent is still idle when it is
          // called. Instead, wait for the run this prompt starts to end via
          // the persistent agent_end listener. The guard above ensures the
          // agent was idle, so the next agent_end belongs to this turn. The
          // waiter was installed before runPrompt, so no agent_end can slip
          // past it.
          waitForIdle: () => subTurnRunEndPromise,
          notify: (message, level) => instaNotify(ctx, message, level),
        },
        parsed.modelRequest,
        parsed.prompt,
      );
    }

    // Insta workers: create (or reuse) the session's team, fire off a worker,
    // and deliver the task prompt straight into the worker's inbox. They are
    // typed as "$$<model> <prompt...>" and "$$$<model> <prompt...>"; the
    // input handler above dispatches both.

    /**
     * Show a command notification in UI sessions; log to the console in
     * print-like sessions where ctx.ui.notify does nothing.
     *
     * @param ctx - Command context with the UI availability flag
     * @param message - The message to show or log
     * @param level - Notification level
     */
    function instaNotify(
      ctx: ExtensionContext,
      message: string,
      level: "info" | "error",
    ): void {
      if (ctx.hasUI) {
        ctx.ui.notify(message, level);
      } else {
        (level === "error" ? console.error : console.log)(message);
      }
    }

    async function runInstaWorkerCommand(
      args: string,
      ctx: ExtensionContext,
      readonlyWorker: boolean,
    ): Promise<void> {
      const commandName = readonlyWorker ? "$$$" : "$$";
      try {
        const parsed = parseInstaWorkerArgs(args);
        if (!parsed) {
          instaNotify(
            ctx,
            `Usage: ${commandName}<model name> <prompt ...>`,
            "error",
          );
          return;
        }
        const { modelRequest, prompt } = parsed;
        if (!prompt) {
          instaNotify(
            ctx,
            "A task prompt is required after the model name.",
            "error",
          );
          return;
        }

        const { resolved, matches } = resolveInstaModel(
          modelRequest,
          ctx.modelRegistry,
        );
        if (!resolved) {
          instaNotify(
            ctx,
            `Could not resolve model '${modelRequest}'. Best matches: ${matches.join(", ")}`,
            "error",
          );
          return;
        }

        const { team: activeTeam, created } = resolveInstaTeam(
          teamName,
          teams.teamExists,
        );
        if (created) {
          teams.createTeam(
            activeTeam,
            "local-session",
            "lead-agent",
            "Insta worker team",
          );
          teamName = activeTeam;
          process.env.PI_TEAM_NAME = activeTeam;
        }

        const config = await teams.readConfig(activeTeam);
        const workerName = uniqueInstaWorkerName(
          new Set(config.members.map((m) => m.name)),
        );

        const spawned = await spawnTeamWorker(ctx, {
          team: activeTeam,
          name: workerName,
          cwd: ctx.cwd,
          modelRequest: resolved,
          readonlyWorker,
        });

        const content = `${prompt}\n\n${INSTA_WORKER_INSTRUCTION}`;
        await messaging.sendPlainMessage(
          activeTeam,
          agentName,
          workerName,
          instaWorkerSubject(prompt),
          content,
          "Insta worker task",
        );
        instaNotify(
          ctx,
          `Spawned ${workerName} in ${spawned.isWindow ? "window" : "pane"} ${spawned.terminalId} on team ${activeTeam} (${spawned.model}); task prompt delivered.`,
          "info",
        );
      } catch (e) {
        instaNotify(
          ctx,
          `${commandName} failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    }
  }

  // ── Shared tools ─────────────────────────────────────────────────────────
  // Messaging and team status. Available to the team-lead and to workers.

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a teammate.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.Optional(
          Type.String({ description: "Defaults to your current team." }),
        ),
        recipient: Type.String(),
        subject: Type.String({
          description: "Short subject line for the message.",
        }),
        content: Type.String({ description: "Full message body." }),
        summary: Type.Optional(
          Type.String({ description: "Optional brief summary." }),
        ),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const resolvedTeam = params.team_name || teamName;
      if (!resolvedTeam)
        throw new Error("team_name is required (no team is currently active).");
      await messaging.sendPlainMessage(
        resolvedTeam,
        agentName,
        params.recipient,
        params.subject,
        params.content,
        params.summary,
      );
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${params.recipient}.\n\n${params.content}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "broadcast_message",
    label: "Broadcast Message",
    description:
      "Broadcast a message to all team members.  Do not use this just to respond to the team-lead.  Use send_message instead.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.Optional(
          Type.String({ description: "Defaults to your current team." }),
        ),
        subject: Type.String({
          description: "Short subject line for the broadcast.",
        }),
        content: Type.String({ description: "Full message body." }),
        summary: Type.Optional(
          Type.String({ description: "Optional brief summary." }),
        ),
        color: Type.Optional(Type.String()),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const resolvedTeam = params.team_name || teamName;
      if (!resolvedTeam)
        throw new Error("team_name is required (no team is currently active).");
      await messaging.broadcastMessage(
        resolvedTeam,
        agentName,
        params.subject,
        params.content,
        params.summary,
        params.color,
      );
      return {
        content: [
          { type: "text", text: `Message broadcasted to all team members.` },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List all teammates in a team with their status.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.String(),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const teammates = await Promise.all(
        config.members.map(async (m) => {
          let alive = false;
          if (m.name === "team-lead" && !isTeammate) {
            alive = true;
          } else if (m.windowId && terminal) {
            alive = terminal.isWindowAlive(m.windowId);
          } else if (m.tmuxPaneId && terminal) {
            alive = terminal.isAlive(m.tmuxPaneId);
          }
          const undeliveredCount = (
            await messaging.readInbox(params.team_name, m.name, true)
          ).length;
          const active = isAgentActive(params.team_name, m.name);
          return {
            name: m.name,
            agentType: m.agentType,
            model: m.model,
            alive,
            active,
            undeliveredCount,
          };
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(teammates, null, 2) }],
        details: { teammates },
      };
    },
  });

  // ── Worker tools ─────────────────────────────────────────────────────────
  // Tools for spawned workers only. The gate mirrors what removeAgent can
  // remove: any spawned worker, never the team-lead, never the interactive
  // lead session.

  if (isWorker) {
    pi.registerTool({
      name: "close_myself",
      label: "Close Myself",
      description:
        "Close this agent: remove yourself from the team config, clean up your state files, and terminate your own process and terminal pane or window. " +
        "Do not run this unless your instructions told you to run it. When the team-lead tells you to close yourself, call this tool instead of ending your turn or running kill commands.",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        const activeTeam = teamName;
        if (!activeTeam) {
          throw new Error(
            "No team is active for this agent, so there is nothing to close.",
          );
        }

        // removeAgent removes this member from the team config, deletes every
        // state file for this agent, closes the pane or window hosting this
        // process, and SIGKILLs this process. The result is never delivered;
        // the agent terminates mid-execute.
        await teams.removeAgent({
          team: activeTeam,
          agentName,
          ownPid: process.pid,
          terminal,
        });

        // Unreachable at runtime: removeAgent terminated this process, but the
        // tool contract requires a result to satisfy the type system.
        return {
          content: [
            { type: "text", text: `Agent ${agentName} closed itself.` },
          ],
          details: {},
        };
      },
    });
  }
}
