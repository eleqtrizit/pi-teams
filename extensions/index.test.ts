import { describe, expect, it, beforeEach } from 'vitest';
import { getTopModelMatches, clearModelsCache, resolveModelWithProvider } from './index';

describe('getTopModelMatches', () => {
    beforeEach(() => {
        clearModelsCache();
    });

    it('returns qwen3-coder-480b for "qwen 480b" queries', () => {
        const modelRegistry = {
            getAvailable: () => [
                { provider: 'abuntu', id: 'Qwen35Coder-122B' },
                { provider: 'abuntu', id: 'qwen3-coder-480b' },
                { provider: 'openai', id: 'o1' },
                { provider: 'openai', id: 'o3' },
                { provider: 'openrouter', id: 'openai/o1' },
                { provider: 'openrouter', id: 'openai/o3' },
                { provider: 'openrouter', id: 'qwen/qwq-32b' },
                { provider: 'openrouter', id: 'qwen/qwen3-coder-480b' }
            ]
        };

        const matches = getTopModelMatches('qwen 480b', modelRegistry, 5);
        const models = matches.map((match) => match.model);

        expect(models[0]).toBe('abuntu/qwen3-coder-480b');
        expect(models).toContain('abuntu/qwen3-coder-480b');
        expect(models).toContain('openrouter/qwen/qwen3-coder-480b');
        expect(models.indexOf('openrouter/qwen/qwen3-coder-480b')).toBeLessThan(models.indexOf('openrouter/qwen/qwq-32b'));
    });

    describe('bighank/Qwen35Coder-35B-NoThinking matching', () => {
        const modelRegistry = {
            getAvailable: () => [
                { provider: 'bighank', id: 'Qwen35Coder-35B-NoThinking' },
                { provider: 'bighank', id: 'Qwen35Coder-122B' },
                { provider: 'openrouter', id: 'qwen/qwen3-coder-480b' },
                { provider: 'abuntu', id: 'some-other-model' }
            ]
        };

        it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen3 35b"', () => {
            const matches = getTopModelMatches('bighank qwen3 35b', modelRegistry, 5);
            expect(matches[0].model).toBe('bighank/Qwen35Coder-35B-NoThinking');
        });

        it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen 35b"', () => {
            const matches = getTopModelMatches('bighank qwen 35b', modelRegistry, 5);
            expect(matches[0].model).toBe('bighank/Qwen35Coder-35B-NoThinking');
        });

        it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen35b on bighank"', () => {
            const matches = getTopModelMatches('qwen35b on bighank', modelRegistry, 5);
            expect(matches[0].model).toBe('bighank/Qwen35Coder-35B-NoThinking');
        });

        it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen 35b bighank"', () => {
            const matches = getTopModelMatches('qwen 35b bighank', modelRegistry, 5);
            expect(matches[0].model).toBe('bighank/Qwen35Coder-35B-NoThinking');
        });
    });
});

describe('resolveModelWithProvider', () => {
    beforeEach(() => {
        clearModelsCache();
    });

    it('returns alternative provider when provider/model not in registry', () => {
        const modelRegistry = {
            getAvailable: () => [
                { provider: 'openrouter', id: 'qwen3coder-35b' },
                { provider: 'abuntu', id: 'qwen3-coder-480b' }
            ]
        };
        const resolved = resolveModelWithProvider('bighank/qwen3coder-35b', modelRegistry);
        expect(resolved).toBe('openrouter/qwen3coder-35b');
    });

    it('resolves "bighank/Qwen35 35b" to bighank/qwen3coder-35b via composite token matching', () => {
        const modelRegistry = {
            getAvailable: () => [
                { provider: 'bighank', id: 'qwen3coder-35b' },
                { provider: 'bighank', id: 'Qwen35Coder-122B' },
                { provider: 'openrouter', id: 'qwen/qwen3-coder-480b' }
            ]
        };
        const resolved = resolveModelWithProvider('bighank/Qwen35 35b', modelRegistry);
        expect(resolved).toBe('bighank/qwen3coder-35b');
    });

    it('returns as-is when provider/model exists in registry', () => {
        const modelRegistry = {
            getAvailable: () => [
                { provider: 'bighank', id: 'qwen3coder-35b' },
                { provider: 'openrouter', id: 'qwen3coder-35b' }
            ]
        };
        const resolved = resolveModelWithProvider('bighank/qwen3coder-35b', modelRegistry);
        expect(resolved).toBe('bighank/qwen3coder-35b');
    });
});
