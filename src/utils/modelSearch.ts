/**
 * Model search and resolution for pi-teams.
 *
 * Pure helpers over a minimal model-registry shape: provider-prefixed and
 * bare-name resolution with a priority ladder (flavored models, scoped
 * models, full registry), plus fuzzy "top matches" output for the
 * resolve_model tool.
 */
import * as flavoredModels from "./flavoredModels";

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null =
  null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

/** Clear the available models cache. Useful for testing. */
export function clearModelsCache(): void {
  availableModelsCache = null;
  modelsCacheTime = 0;
}

export interface ModelRegistryLike {
  getAvailable(): Array<{ provider: string; id: string }>;
}

/**
 * Query available models from Pi's in-process model registry.
 */
export function getAvailableModels(
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
 * (orchestrator/worker/swarm), then the session's scoped models (pi --models flag, or the
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
 * Flavored ids are pi settings' orchestrator/worker/swarm entries; each id matches either
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
 * Build the flavored-model group: the orchestrator/worker/swarm lists from pi
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
      ...flavors.orchestrator,
      ...flavors.worker,
      ...flavors.swarm,
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
