import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Iterm2Adapter } from '../src/adapters/iterm2-adapter';
import { getTerminalAdapter } from '../src/adapters/terminal-registry';
import * as messaging from '../src/utils/messaging';
import { updateLastAwokenTime } from '../src/utils/messaging';
import { Member } from '../src/utils/models';
import * as paths from '../src/utils/paths';
import * as teams from '../src/utils/teams';

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

/**
 * Minimal model-registry interface used by this extension.
 */
interface ModelRegistryLike {
    getAvailable(): Array<{ provider: string; id: string }>;
}

/**
 * Query available models from Pi's in-process model registry.
 */
function getAvailableModels(modelRegistry: ModelRegistryLike): Array<{ provider: string; model: string }> {
    const now = Date.now();
    if (availableModelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
        return availableModelsCache;
    }

    try {
        const models = modelRegistry.getAvailable().map((model) => ({
            provider: model.provider,
            model: model.id
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
    'google-gemini-cli', // Google Gemini CLI - OAuth, free tier
    'github-copilot', // GitHub Copilot - subscription
    'kimi-sub', // Kimi subscription
    // API key providers
    'anthropic',
    'openai',
    'google',
    'zai',
    'openrouter',
    'azure-openai',
    'amazon-bedrock',
    'mistral',
    'groq',
    'cerebras',
    'xai',
    'vercel-ai-gateway'
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
function resolveModelWithProvider(modelName: string, modelRegistry: ModelRegistryLike): string | null {
    // If already has provider prefix, return as-is
    if (modelName.includes('/')) {
        return modelName;
    }

    const availableModels = getAvailableModels(modelRegistry);
    if (availableModels.length === 0) {
        return null;
    }

    const lowerModelName = modelName.toLowerCase();

    // Find all exact matches (case-insensitive) and sort by provider priority
    const exactMatches = availableModels.filter((m) => m.model.toLowerCase() === lowerModelName);

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
                a.provider.localeCompare(b.provider)
        );

    if (partialMatches.length > 0) {
        return `${partialMatches[0].provider}/${partialMatches[0].model}`;
    }

    return null;
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let i = 0; i < rows; i++) matrix[i][0] = i;
    for (let j = 0; j < cols; j++) matrix[0][j] = j;

    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + substitutionCost
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
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Tokenize text for fuzzy matching.
 */
function tokenizeForSearch(value: string): string[] {
    return normalizeForSearch(value)
        .split(' ')
        .filter((token) => token.length > 0);
}

/**
 * Count query tokens found in candidate text.
 */
function countMatchingTokens(queryTokens: string[], candidate: string): number {
    const normalizedCandidate = normalizeForSearch(candidate);
    return queryTokens.reduce((count, token) => count + (normalizedCandidate.includes(token) ? 1 : 0), 0);
}

/**
 * Find top model matches by token relevance and Levenshtein distance.
 */
export function getTopModelMatches(
    modelName: string,
    modelRegistry: ModelRegistryLike,
    limit = 5
): Array<{ model: string; distance: number }> {
    const query = modelName.trim().toLowerCase();
    const normalizedQuery = normalizeForSearch(query);
    const queryTokens = tokenizeForSearch(query);
    const available = getAvailableModels(modelRegistry);

    return available
        .map((m) => {
            const modelOnly = m.model.toLowerCase();
            const fullModel = `${m.provider}/${m.model}`.toLowerCase();
            const normalizedModelOnly = normalizeForSearch(modelOnly);
            const normalizedFullModel = normalizeForSearch(fullModel);
            const distance = Math.min(
                levenshteinDistance(query, modelOnly),
                levenshteinDistance(query, fullModel),
                levenshteinDistance(normalizedQuery, normalizedModelOnly),
                levenshteinDistance(normalizedQuery, normalizedFullModel)
            );
            const tokenMatches = Math.max(
                countMatchingTokens(queryTokens, modelOnly),
                countMatchingTokens(queryTokens, fullModel)
            );
            const containsFullQuery =
                normalizedModelOnly.includes(normalizedQuery) || normalizedFullModel.includes(normalizedQuery);
            const missingTokenPenalty = Math.max(0, queryTokens.length - tokenMatches);
            const score = missingTokenPenalty * 1000 + (containsFullQuery ? 0 : 100) + distance;
            const providerPriority = getProviderPriority(m.provider);
            return {
                model: `${m.provider}/${m.model}`,
                distance,
                tokenMatches,
                containsFullQuery,
                score,
                providerPriority
            };
        })
        .sort(
            (a, b) =>
                b.tokenMatches - a.tokenMatches ||
                Number(b.containsFullQuery) - Number(a.containsFullQuery) ||
                a.score - b.score ||
                a.providerPriority - b.providerPriority ||
                a.model.localeCompare(b.model)
        )
        .map(({ model, distance }) => ({ model, distance }))
        .slice(0, limit);
}

export default function (pi: ExtensionAPI) {
    const isTeammate = !!process.env.PI_AGENT_NAME;
    const agentName = process.env.PI_AGENT_NAME || 'team-lead';
    const teamName = process.env.PI_TEAM_NAME;

    const terminal = getTerminalAdapter();

    pi.on('session_start', async (_event, ctx) => {
        paths.ensureDirs();
        if (isTeammate) {
            if (teamName) {
                const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
                fs.writeFileSync(pidFile, process.pid.toString());
            }
            ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, 'info');
            ctx.ui.setStatus('00-pi-teams', `[${agentName.toUpperCase()}]`);

            if (terminal) {
                const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
                const setIt = () => {
                    if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
                    terminal.setTitle(fullTitle);
                };
                setIt();
                setTimeout(setIt, 500);
                setTimeout(setIt, 2000);
                setTimeout(setIt, 5000);
            }

            // On first spawn, purge ALL stale state from any previous session and
            // stamp the firstActivationFile immediately (before messages can arrive).
            // Previously this cleanup ran at turn_start, which created a race: a message
            // sent between session_start and the first turn_start would be deleted when
            // the first turn fired and wiped the inbox.
            if (teamName) {
                const firstActivationFile = paths.firstActivationPath(teamName, agentName);
                if (!fs.existsSync(firstActivationFile)) {
                    const inboxFile = paths.inboxPath(teamName, agentName);
                    const lastMessageFile = paths.lastMessagePath(teamName, agentName);
                    const lastAwokenFile = paths.lastAwokenPath(teamName, agentName);
                    const lastReminderFile = paths.lastReminderPath(teamName, agentName);
                    if (fs.existsSync(inboxFile)) fs.unlinkSync(inboxFile);
                    if (fs.existsSync(lastMessageFile)) fs.unlinkSync(lastMessageFile);
                    if (fs.existsSync(lastAwokenFile)) fs.unlinkSync(lastAwokenFile);
                    if (fs.existsSync(lastReminderFile)) fs.unlinkSync(lastReminderFile);
                    fs.writeFileSync(firstActivationFile, Date.now().toString());
                }
            }

            setInterval(async () => {
                if (!ctx.isIdle() || !teamName) {
                    return;
                }

                await messaging.ensureReminderMessage(teamName, agentName);
                const unread = await messaging.readInbox(teamName, agentName, true, false);
                if (unread.length > 0) {
                    pi.sendUserMessage(`I have ${unread.length} new message(s) in my inbox.`);
                }
            }, 1000);
        } else if (teamName) {
            ctx.ui.setStatus('pi-teams', `Lead @ ${teamName}`);

            setInterval(async () => {
                if (ctx.isIdle() && teamName) {
                    const unread = await messaging.readInbox(teamName, agentName, true, false);
                    if (unread.length > 0) {
                        pi.sendUserMessage(
                            `You have ${unread.length} new message(s) in your inbox from your team. Call read_inbox(team_name="${teamName}") to check them.`
                        );
                    }
                }
            }, 1000);
        }
    });

    function setActiveStatus(active: boolean) {
        if (!teamName) return;
        const activeFile = path.join(paths.teamDir(teamName), `${agentName}.active`);
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
            const timestamp = parseInt(fs.readFileSync(activeFile, 'utf-8').trim());
            const age = Date.now() - timestamp;
            return age < 5 * 60 * 1000; // Consider stale if older than 5 minutes
        } catch {
            return false;
        }
    }

    pi.on('turn_start', async (_event, ctx) => {
        setActiveStatus(true);
        if (isTeammate) {
            const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
            if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
            if (terminal) terminal.setTitle(fullTitle);
        }
    });

    pi.on('turn_end', async (_event, ctx) => {
        setActiveStatus(false);
    });

    let firstTurn = true;
    pi.on('before_agent_start', async (event, ctx) => {
        if (isTeammate && firstTurn) {
            firstTurn = false;

            let modelInfo = '';
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

            return {
                systemPrompt:
                    event.systemPrompt +
                    `\n\nYou are teammate '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}\nWait for instructions via your inbox. You will be notified when new messages arrive.`
            };
        }
    });

    async function killTeammate(teamName: string, member: Member) {
        if (member.name === 'team-lead') return;

        const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
        if (fs.existsSync(pidFile)) {
            try {
                const pid = fs.readFileSync(pidFile, 'utf-8').trim();
                process.kill(parseInt(pid), 'SIGKILL');
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
    pi.registerTool({
        name: 'team_create',
        label: 'Create Team',
        description: 'Create a new agent team.',
        parameters: Type.Object({
            team_name: Type.String(),
            description: Type.Optional(Type.String()),
            default_model: Type.Optional(Type.String()),
            separate_windows: Type.Optional(
                Type.Boolean({ default: false, description: 'Open teammates in separate OS windows instead of panes' })
            )
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const config = teams.createTeam(
                params.team_name,
                'local-session',
                'lead-agent',
                params.description,
                params.default_model,
                params.separate_windows
            );
            // Set PI_TEAM_NAME for the lead so message polling loop activates
            process.env.PI_TEAM_NAME = params.team_name;
            return {
                content: [{ type: 'text', text: `Team ${params.team_name} created.` }],
                details: { config }
            };
        }
    });

    pi.registerTool({
        name: 'resolve_model',
        label: 'Resolve Model',
        description:
            'Use this tool to find the correct provider/model name to use in spawn_teammate.  Use DEFAULT MODEL if no good match is found.',
        parameters: Type.Object({
            model_name: Type.String()
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const requested = params.model_name.trim();
            if (!requested) {
                throw new Error('model_name must not be empty.');
            }

            const topMatches = getTopModelMatches(requested, ctx.modelRegistry, 5);
            const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
            const resolved = resolveModelWithProvider(requested, ctx.modelRegistry);
            if (!resolved) {
                const matchesText = topMatches.map((m) => m.model).join(', ');
                const outputText = defaultModel
                    ? `DEFAULT MODEL: ${defaultModel}, Best matches: ${matchesText}`
                    : matchesText;
                return {
                    content: [
                        {
                            type: 'text',
                            text: outputText
                        }
                    ],
                    details: { requested, resolved_model: null, top_matches: topMatches, default_model: defaultModel }
                };
            }

            return {
                content: [{ type: 'text', text: resolved }],
                details: { requested, resolved_model: resolved, top_matches: topMatches, default_model: defaultModel }
            };
        }
    });

    pi.registerTool({
        name: 'spawn_teammate',
        label: 'Spawn Teammate',
        description: 'Spawn a new teammate in a terminal pane or separate window.',
        parameters: Type.Object({
            team_name: Type.String(),
            name: Type.String(),
            cwd: Type.String(),
            model: Type.Optional(Type.String()),
            thinking: Type.Optional(StringEnum(['off', 'minimal', 'low', 'medium', 'high'])),
            separate_window: Type.Optional(Type.Boolean({ default: false }))
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const safeName = paths.sanitizeName(params.name);
            const safeTeamName = paths.sanitizeName(params.team_name);

            if (!teams.teamExists(safeTeamName)) {
                throw new Error(`Team ${params.team_name} does not exist`);
            }

            if (!terminal) {
                throw new Error('No terminal adapter detected.');
            }

            const teamConfig = await teams.readConfig(safeTeamName);
            let chosenModel = params.model?.trim();

            // If model is not provided or contains "default" (case-insensitive), use the team-leader's model from context
            if (!chosenModel || /default/i.test(chosenModel)) {
                const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
                if (defaultModel) {
                    chosenModel = defaultModel;
                }
            }

            if (!chosenModel) {
                throw new Error(
                    'spawn_teammate requires a model. ' +
                        'Either provide one explicitly or ensure the team-leader has a model configured.'
                );
            }

            // Spawn tool only accepts fully-qualified provider/model values.
            // Use resolve_model first to resolve aliases like "haiku".
            if (!chosenModel.includes('/')) {
                throw new Error(
                    `Model '${chosenModel}' is not fully qualified. ` +
                        `Use resolve_model(model_name="${chosenModel}") and pass the returned provider/model value to spawn_teammate.`
                );
            }

            const slashIndex = chosenModel.indexOf('/');
            const provider = chosenModel.slice(0, slashIndex).toLowerCase();
            const modelId = chosenModel.slice(slashIndex + 1).toLowerCase();
            const isAvailable = getAvailableModels(ctx.modelRegistry).some(
                (m) => m.provider.toLowerCase() === provider && m.model.toLowerCase() === modelId
            );
            if (!isAvailable) {
                throw new Error(
                    `Model '${chosenModel}' is not available in the current registry. ` +
                        `Use resolve_model(model_name="...") to find a valid provider/model value.`
                );
            }

            const useSeparateWindow = params.separate_window ?? teamConfig.separateWindows ?? false;
            if (useSeparateWindow && !terminal.supportsWindows()) {
                throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
            }

            const member: Member = {
                agentId: `${safeName}@${safeTeamName}`,
                name: safeName,
                agentType: 'teammate',
                model: chosenModel,
                joinedAt: Date.now(),
                tmuxPaneId: '',
                cwd: params.cwd,
                subscriptions: [],
                color: 'blue',
                thinking: params.thinking
            };

            await teams.addMember(safeTeamName, member);

            const piBinary = process.argv[1] ? `node ${process.argv[1]}` : 'pi';
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
                PI_AGENT_NAME: safeName
            };

            let terminalId = '';
            let isWindow = false;

            try {
                if (useSeparateWindow) {
                    isWindow = true;
                    terminalId = terminal.spawnWindow({
                        name: safeName,
                        cwd: params.cwd,
                        command: piCmd,
                        env: env,
                        teamName: safeTeamName
                    });
                    await teams.updateMember(safeTeamName, safeName, { windowId: terminalId });
                } else {
                    if (terminal instanceof Iterm2Adapter) {
                        const teammates = teamConfig.members.filter(
                            (m) => m.agentType === 'teammate' && m.tmuxPaneId.startsWith('iterm_')
                        );
                        const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
                        if (lastTeammate?.tmuxPaneId) {
                            terminal.setSpawnContext({ lastSessionId: lastTeammate.tmuxPaneId.replace('iterm_', '') });
                        } else {
                            terminal.setSpawnContext({});
                        }
                    }

                    terminalId = terminal.spawn({
                        name: safeName,
                        cwd: params.cwd,
                        command: piCmd,
                        env: env
                    });
                    await teams.updateMember(safeTeamName, safeName, { tmuxPaneId: terminalId });
                }
            } catch (e) {
                throw new Error(`Failed to spawn ${terminal.name} ${isWindow ? 'window' : 'pane'}: ${e}`);
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Teammate ${params.name} spawned in ${isWindow ? 'window' : 'pane'} ${terminalId}.`
                    }
                ],
                details: { agentId: member.agentId, terminalId, isWindow }
            };
        }
    });

    pi.registerTool({
        name: 'spawn_lead_window',
        label: 'Spawn Lead Window',
        description: 'Open the team lead in a separate OS window.',
        parameters: Type.Object({
            team_name: Type.String(),
            cwd: Type.Optional(Type.String())
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const safeTeamName = paths.sanitizeName(params.team_name);
            if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
            if (!terminal || !terminal.supportsWindows()) throw new Error('Windows mode not supported.');

            const teamConfig = await teams.readConfig(safeTeamName);
            const cwd = params.cwd || process.cwd();
            const piBinary = process.argv[1] ? `node ${process.argv[1]}` : 'pi';
            let piCmd = piBinary;
            if (teamConfig.defaultModel) {
                // Use the combined --model provider/model format
                piCmd = `${piBinary} --model ${teamConfig.defaultModel}`;
            }

            const env = { ...process.env, PI_TEAM_NAME: safeTeamName, PI_AGENT_NAME: 'team-lead' };
            try {
                const windowId = terminal.spawnWindow({
                    name: 'team-lead',
                    cwd,
                    command: piCmd,
                    env,
                    teamName: safeTeamName
                });
                await teams.updateMember(safeTeamName, 'team-lead', { windowId });
                return { content: [{ type: 'text', text: `Lead window spawned: ${windowId}` }], details: { windowId } };
            } catch (e) {
                throw new Error(`Failed: ${e}`);
            }
        }
    });

    pi.registerTool({
        name: 'send_message',
        label: 'Send Message',
        description: 'Send a message to a teammate.',
        parameters: Type.Object({
            team_name: Type.String(),
            recipient: Type.String(),
            content: Type.String(),
            summary: Type.String()
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            await messaging.sendPlainMessage(
                params.team_name,
                agentName,
                params.recipient,
                params.content,
                params.summary
            );
            return {
                content: [{ type: 'text', text: `Message sent to ${params.recipient}.` }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: 'broadcast_message',
        label: 'Broadcast Message',
        description:
            'Broadcast a message to all team members.  Do not use this just to respond to the team-lead.  Use send_message instead.',
        parameters: Type.Object({
            team_name: Type.String(),
            content: Type.String(),
            summary: Type.String(),
            color: Type.Optional(Type.String())
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            await messaging.broadcastMessage(params.team_name, agentName, params.content, params.summary, params.color);
            return {
                content: [{ type: 'text', text: `Message broadcasted to all team members.` }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: 'read_inbox',
        label: 'Read Inbox',
        description: "Read messages from an agent's inbox.",
        parameters: Type.Object({
            team_name: Type.String(),
            agent_name: Type.Optional(Type.String({ description: 'Whose inbox to read. Defaults to your own.' })),
            unread_only: Type.Optional(Type.Boolean({ default: true }))
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const targetAgent = params.agent_name || agentName;
            const msgs = await messaging.readInbox(params.team_name, targetAgent, params.unread_only);
            return {
                content: [{ type: 'text', text: JSON.stringify(msgs, null, 2) }],
                details: { messages: msgs }
            };
        }
    });

    pi.registerTool({
        name: 'team_shutdown',
        label: 'Shutdown Team',
        description: 'Shutdown the entire team and close all panes/windows.',
        parameters: Type.Object({
            team_name: Type.String()
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const teamName = params.team_name;
            try {
                const config = await teams.readConfig(teamName);
                for (const member of config.members) {
                    await killTeammate(teamName, member);
                }
                const dir = paths.teamDir(teamName);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
                return { content: [{ type: 'text', text: `Team ${teamName} shut down.` }], details: {} };
            } catch (e) {
                throw new Error(`Failed to shutdown team: ${e}`);
            }
        }
    });

    pi.registerTool({
        name: 'list_teammates',
        label: 'List Teammates',
        description: 'List all teammates in a team with their status.',
        parameters: Type.Object({
            team_name: Type.String()
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const config = await teams.readConfig(params.team_name);
            const teammates = await Promise.all(
                config.members.map(async (m) => {
                    let alive = false;
                    if (m.name === 'team-lead' && !isTeammate) {
                        alive = true;
                    } else if (m.windowId && terminal) {
                        alive = terminal.isWindowAlive(m.windowId);
                    } else if (m.tmuxPaneId && terminal) {
                        alive = terminal.isAlive(m.tmuxPaneId);
                    }
                    const unreadCount = (await messaging.readInbox(params.team_name, m.name, true, false)).length;
                    const active = isAgentActive(params.team_name, m.name);
                    return {
                        name: m.name,
                        agentType: m.agentType,
                        model: m.model,
                        alive,
                        active,
                        unreadCount
                    };
                })
            );
            return {
                content: [{ type: 'text', text: JSON.stringify(teammates, null, 2) }],
                details: { teammates }
            };
        }
    });

    pi.registerTool({
        name: 'process_shutdown_approved',
        label: 'Process Shutdown Approved',
        description: "Process a teammate's shutdown.",
        parameters: Type.Object({
            team_name: Type.String(),
            agent_name: Type.String()
        }),
        async execute(toolCallId, params: any, signal, onUpdate, ctx) {
            const config = await teams.readConfig(params.team_name);
            const member = config.members.find((m) => m.name === params.agent_name);
            if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

            await killTeammate(params.team_name, member);
            await teams.removeMember(params.team_name, params.agent_name);
            return {
                content: [{ type: 'text', text: `Teammate ${params.agent_name} has been shut down.` }],
                details: {}
            };
        }
    });
}
