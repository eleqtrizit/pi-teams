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
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
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
import { InboxMessage, Member } from "../src/utils/models";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null =
  null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

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
 * Find the best matching provider for a given model name.
 * Returns the full provider/model string or null if not found.
 */
export function resolveModelWithProvider(
  modelName: string,
  modelRegistry: ModelRegistryLike,
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

  // Find all exact matches (case-insensitive) and sort by provider priority
  const exactMatches = availableModels.filter(
    (m) => m.model.toLowerCase() === lowerModelName,
  );

  if (exactMatches.length > 0) {
    // Sort by provider priority (lower index = higher priority)
    exactMatches.sort((a, b) => {
      return (
        getProviderPriority(a.provider) - getProviderPriority(b.provider) ||
        a.provider.localeCompare(b.provider)
      );
    });
    return `${exactMatches[0].provider}/${exactMatches[0].model}`;
  }

  const queryTokens = tokenizeForSearch(modelName);

  // Try partial/token match (model name contains all query tokens)
  const partialMatches = availableModels
    .filter((m) => {
      const normalizedModel = normalizeForSearch(m.model);
      return queryTokens.every((token) => normalizedModel.includes(token));
    })
    .sort(
      (a, b) =>
        getProviderPriority(a.provider) - getProviderPriority(b.provider) ||
        a.provider.localeCompare(b.provider),
    );

  if (partialMatches.length > 0) {
    return `${partialMatches[0].provider}/${partialMatches[0].model}`;
  }

  // Fall back to composite-aware token matching via getTopModelMatches
  const topMatches = getTopModelMatches(modelName, modelRegistry, 1);
  return topMatches.length > 0 ? topMatches[0].model : null;
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
 * Find top model matches by substring relevance and Levenshtein distance.
 *
 * Matching is done by collapsing "provider/model" into a single lowercase
 * alphanumeric string and checking whether each query token appears as a
 * substring. Tokens that are composites like "35b" or "qwen3" are also
 * split on letter/number boundaries so their parts can match individually.
 *
 * :param modelName: The user's free-form query string
 * :param modelRegistry: Registry providing available models
 * :param limit: Maximum number of results to return
 * :return: Array of { model, distance } sorted by relevance
 */
export function getTopModelMatches(
  modelName: string,
  modelRegistry: ModelRegistryLike,
  limit = 5,
): Array<{ model: string; distance: number }> {
  const query = modelName.trim().toLowerCase();
  const queryTokens = tokenizeQuery(query);
  const normalizedQuery = normalizeForSearch(query);
  const available = getAvailableModels(modelRegistry);

  return available
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

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentType = process.env.PI_AGENT_TYPE || "lead";
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  let teamName = process.env.PI_TEAM_NAME;

  const terminal = getTerminalAdapter();
  let inboxCheckInterval: ReturnType<typeof setInterval> | null = null;
  let titleRefreshTimeouts: ReturnType<typeof setTimeout>[] = [];
  let isAgentIdle = true;
  let isAgentRunning = false;
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
    pi.sendUserMessage(message, { deliverAs: "followUp" });
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

  pi.on("agent_start", async () => {
    isAgentRunning = true;
    pendingInboxNotifications.clear();
  });

  pi.on("agent_end", async () => {
    isAgentRunning = false;
    pendingInboxNotifications.flush(sendFollowUp);
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
          ? "\nYou are limited to reading files (read, grep, find, ls) and messaging tools (send_message, broadcast_message). You cannot write, edit, or execute commands."
          : "";

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nYou are ${roleDescription} '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${capabilitiesNote}\nMessages from teammates are delivered to you automatically as user messages; you do not need to fetch them. When your work is done, end your turn and stop — you will be woken automatically when the next message arrives.\n\nHARD RULES (violating these wastes tokens and breaks the team):\n- NEVER run sleep, polling, or wait commands (e.g. 'sleep 30', 'while true; do ...; done').\n- NEVER loop or poll to wait for messages. They arrive on their own.\n- When your work is done, simply stop. Do not announce that you are 'sleeping' or 'waiting' with a command. Just end your turn.`,
      };
    }
  });

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf-8").trim();
        process.kill(parseInt(pid), "SIGKILL");
        fs.unlinkSync(pidFile);
      } catch (e) {
        // ignore
      }
    }

    if (member.windowId && terminal) {
      terminal.killWindow(member.windowId);
    }

    if (member.tmuxPaneId && terminal) {
      terminal.kill(member.tmuxPaneId);
    }
  }

  // Tools
  if (!isTeammate) {
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

  if (!isTeammate) {
    pi.registerTool({
      name: "resolve_model",
      label: "Resolve Model",
      description:
        'Resolve a provider/model name for use in spawn_teammate. ALWAYS provide the full <provider>/<model> format (e.g., "anthropic/claude-sonnet-4-20250514", "bighank/Qwen35Coder-35B-NoThinking"). ' +
        'To find what provider/model pairs are available: call get_available_models() or use "DEFAULT MODEL" which is the team-leader\'s own model. ' +
        "This tool ONLY searches within the specified provider when a provider prefix is given. If no match is found, try a different provider or use DEFAULT MODEL.",
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

  if (!isTeammate) {
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
        const safeName = paths.sanitizeName(params.name);
        const safeTeamName = paths.sanitizeName(params.team_name);

        if (!teams.teamExists(safeTeamName)) {
          throw new Error(`Team ${params.team_name} does not exist`);
        }

        if (!terminal) {
          throw new Error("No terminal adapter detected.");
        }

        const teamConfig = await teams.readConfig(safeTeamName);
        let chosenModel = params.model?.trim();

        // If model is not provided or contains "default" (case-insensitive), use the team-leader's model from context
        if (!chosenModel || /default/i.test(chosenModel)) {
          const defaultModel = ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : null;
          if (defaultModel) {
            chosenModel = defaultModel;
          }
        }

        if (!chosenModel) {
          throw new Error(
            "spawn_teammate requires a model. " +
              "Either provide one explicitly or ensure the team-leader has a model configured.",
          );
        }

        // Spawn tool only accepts fully-qualified provider/model values.
        // Use resolve_model first to resolve aliases like "haiku".
        if (!chosenModel.includes("/")) {
          throw new Error(
            `Model '${chosenModel}' is not fully qualified. ` +
              `Use resolve_model(model_name="${chosenModel}") and pass the returned provider/model value to spawn_teammate.`,
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

        const useSeparateWindow =
          params.separate_window ?? teamConfig.separateWindows ?? false;
        if (useSeparateWindow && !terminal.supportsWindows()) {
          throw new Error(
            `Separate windows mode is not supported in ${terminal.name}.`,
          );
        }

        const member: Member = {
          agentId: `${safeName}@${safeTeamName}`,
          name: safeName,
          agentType: "teammate",
          model: chosenModel,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd: params.cwd,
          subscriptions: [],
          color: "blue",
          thinking: params.thinking,
        };

        await teams.addMember(safeTeamName, member);

        const piBinary = process.argv[1] ? `node ${process.argv[1]}` : "pi";
        let piCmd = piBinary;

        if (chosenModel) {
          // Use the combined --model provider/model:thinking format
          if (params.thinking) {
            piCmd = `${piBinary} --model ${chosenModel}:${params.thinking}`;
          } else {
            piCmd = `${piBinary} --model ${chosenModel}`;
          }
        } else if (params.thinking) {
          piCmd = `${piBinary} --thinking ${params.thinking}`;
        }

        const env: Record<string, string> = {
          ...process.env,
          PI_TEAM_NAME: safeTeamName,
          PI_AGENT_NAME: safeName,
          PI_AGENT_TYPE: "teammate",
        };

        // Stamp firstActivationFile and clear stale state files BEFORE spawning
        // the terminal process.  This guarantees session_start sees the file and
        // skips the inbox-deletion cleanup even if the team-lead sends a message
        // between spawn_teammate returning and the worker's session_start firing.
        const firstActivationFile = paths.firstActivationPath(
          safeTeamName,
          safeName,
        );
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

        let terminalId = "";
        let isWindow = false;

        try {
          if (useSeparateWindow) {
            isWindow = true;
            terminalId = terminal.spawnWindow({
              name: safeName,
              cwd: params.cwd,
              command: piCmd,
              env: env,
              teamName: safeTeamName,
            });
            await teams.updateMember(safeTeamName, safeName, {
              windowId: terminalId,
            });
          } else {
            if (terminal instanceof Iterm2Adapter) {
              const teammates = teamConfig.members.filter(
                (m) =>
                  m.agentType === "teammate" &&
                  m.tmuxPaneId.startsWith("iterm_"),
              );
              const lastTeammate =
                teammates.length > 0 ? teammates[teammates.length - 1] : null;
              if (lastTeammate?.tmuxPaneId) {
                terminal.setSpawnContext({
                  lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", ""),
                });
              } else {
                terminal.setSpawnContext({});
              }
            }

            terminalId = terminal.spawn({
              name: safeName,
              cwd: params.cwd,
              command: piCmd,
              env: env,
            });
            await teams.updateMember(safeTeamName, safeName, {
              tmuxPaneId: terminalId,
            });
          }
        } catch (e) {
          throw new Error(
            `Failed to spawn ${terminal.name} ${isWindow ? "window" : "pane"}: ${e}`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Teammate ${params.name} spawned in ${isWindow ? "window" : "pane"} ${terminalId}.`,
            },
          ],
          details: { agentId: member.agentId, terminalId, isWindow },
        };
      },
    });
  }

  if (!isTeammate) {
    pi.registerTool({
      name: "spawn_readonly_worker",
      label: "Spawn Read-Only Worker",
      description:
        "Spawn a read-only worker agent that can only read, grep, find, and ls files. No bash, write, or edit access. Despite being read-only, the worker can still use messaging tools (send_message, broadcast_message) to communicate with the team lead.\n\n" +
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
        const safeName = paths.sanitizeName(params.name);
        const safeTeamName = paths.sanitizeName(params.team_name);

        if (!teams.teamExists(safeTeamName)) {
          throw new Error(`Team ${params.team_name} does not exist`);
        }

        if (!terminal) {
          throw new Error("No terminal adapter detected.");
        }

        const teamConfig = await teams.readConfig(safeTeamName);

        // Use the requested model if fully qualified, else the team lead's model
        let chosenModel: string | null = null;
        const requested = params.model?.trim();
        if (requested && !/default/i.test(requested)) {
          if (!requested.includes("/")) {
            throw new Error(
              `Model '${requested}' is not fully qualified. ` +
                `Use resolve_model(model_name="${requested}") first, then pass ` +
                `the returned provider/model value.`,
            );
          }
          chosenModel = requested;
        }
        const defaultModel = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : null;
        if (!chosenModel) {
          chosenModel = defaultModel;
        }
        if (!chosenModel) {
          throw new Error(
            "Cannot spawn read-only worker: no model configured. " +
              "Ensure the team-leader has a model configured or pass model explicitly.",
          );
        }

        const member: Member = {
          agentId: `${safeName}@${safeTeamName}`,
          name: safeName,
          agentType: "readonly-worker",
          model: chosenModel,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd: params.cwd,
          subscriptions: [],
          color: "green",
        };

        await teams.addMember(safeTeamName, member);

        const piBinary = process.argv[1] ? `node ${process.argv[1]}` : "pi";
        const piCmd = `${piBinary} --model ${chosenModel} --tools read,grep,find,ls,send_message,broadcast_message`;

        const env: Record<string, string> = {
          ...process.env,
          PI_TEAM_NAME: safeTeamName,
          PI_AGENT_NAME: safeName,
          PI_AGENT_TYPE: "readonly-worker",
        };

        // Stamp firstActivationFile and clear stale state files BEFORE spawning
        const firstActivationFile = paths.firstActivationPath(
          safeTeamName,
          safeName,
        );
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

        let terminalId = "";

        try {
          if (terminal instanceof Iterm2Adapter) {
            const teammates = teamConfig.members.filter(
              (m) =>
                m.agentType === "teammate" || m.agentType === "readonly-worker",
            );
            const lastTeammate =
              teammates.length > 0 ? teammates[teammates.length - 1] : null;
            if (lastTeammate?.tmuxPaneId) {
              terminal.setSpawnContext({
                lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", ""),
              });
            } else {
              terminal.setSpawnContext({});
            }
          }

          terminalId = terminal.spawn({
            name: safeName,
            cwd: params.cwd,
            command: piCmd,
            env: env,
          });
          await teams.updateMember(safeTeamName, safeName, {
            tmuxPaneId: terminalId,
          });
        } catch (e) {
          throw new Error(`Failed to spawn ${terminal.name} pane: ${e}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Read-only worker ${params.name} spawned in pane ${terminalId}. Restricted to: read, grep, find, ls plus messaging tools (send_message, broadcast_message).`,
            },
          ],
          details: {
            agentId: member.agentId,
            terminalId,
            tools: [
              "read",
              "grep",
              "find",
              "ls",
              "send_message",
              "broadcast_message",
            ],
          },
        };
      },
    });
  }

  if (!isTeammate) {
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
        let piCmd = piBinary;
        if (teamConfig.defaultModel) {
          // Use the combined --model provider/model format
          piCmd = `${piBinary} --model ${teamConfig.defaultModel}`;
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

  if (!isTeammate) {
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
            await killTeammate(teamName, member);
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

  if (!isTeammate) {
    pi.registerTool({
      name: "process_shutdown_approved",
      label: "Process Shutdown Approved",
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

        await killTeammate(params.team_name, member);
        await teams.removeMember(params.team_name, params.agent_name);
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
  }
}
