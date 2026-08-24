import { bus, EVENTS } from '../core/bus.js';
import { state } from '../core/store.js';
import { debouncedSave } from '../core/storage.js';

const DEFAULT_PREFIX = '（警告：已触发禁止词「{words}」，请更换表达方式）';

function normalizeEntry(entry) {
    if (typeof entry === 'string') return { word: entry.trim(), mode: 'contains', enabled: true, temporary: false, count: 0 };
    if (!entry || typeof entry !== 'object') return null;
    const word = typeof entry.word === 'string' ? entry.word.trim() : '';
    if (!word) return null;
    return {
        word,
        mode: entry.mode === 'wildcard' ? 'wildcard' : 'contains',
        enabled: entry.enabled !== false,
        temporary: entry.temporary === true,
        count: Number.isFinite(entry.count) ? entry.count : 0
    };
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+./-]/g, '\\$&');
}

function wildcardRegExp(pattern) {
    let source = '';
    for (const char of pattern) {
        if (char === '*') source += '.*';
        else if (char === '?') source += '.';
        else source += escapeRegExp(char);
    }
    return new RegExp(source, 'iu');
}

class ModeratorEngine {
    constructor() {
        this.words = [];
        this.prefixTemplate = DEFAULT_PREFIX;
        this._initListener();
    }

    load() {
        const saved = state.settings.moderator;
        if (!saved || typeof saved !== 'object') return;
        const entries = Array.isArray(saved.words) ? saved.words.map(normalizeEntry).filter(Boolean) : [];
        const seen = new Set();
        this.words = entries.filter((entry) => {
            const key = `${entry.mode}:${entry.word}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (typeof saved.prefixTemplate === 'string' && saved.prefixTemplate.trim()) this.prefixTemplate = saved.prefixTemplate;
    }

    save() {
        state.settings.moderator = { words: this.words, prefixTemplate: this.prefixTemplate };
        debouncedSave();
    }

    syncWordsByText(text, mode = 'contains') {
        const old = new Map(this.words.map((entry) => [`${entry.mode}:${entry.word}`, entry]));
        const items = String(text || '').split(/[,，\n\r、]/).map((item) => item.trim()).filter(Boolean);
        const seen = new Set();
        this.words = items.map((word) => {
            const key = `${mode}:${word}`;
            if (seen.has(key)) return null;
            seen.add(key);
            const previous = old.get(key);
            return previous ? { ...previous, word, mode } : { word, mode, enabled: true, temporary: false, count: 0 };
        }).filter(Boolean);
        this.save();
        return this.words;
    }

    addWord(word, mode = 'contains', temporary = false) {
        const entry = normalizeEntry({ word, mode, temporary });
        if (!entry) throw new Error('词条不能为空');
        const exists = this.words.find((item) => item.word === entry.word && item.mode === entry.mode);
        if (exists) return exists;
        this.words.push(entry);
        this.save();
        return entry;
    }

    removeWord(word, mode) {
        this.words = this.words.filter((entry) => !(entry.word === word && (!mode || entry.mode === mode)));
        this.save();
    }

    getWordsString() { return this.words.map((entry) => entry.word).join(', '); }

    matchEntry(entry, text) {
        if (!entry.enabled || !entry.word) return null;
        if (entry.mode === 'wildcard') {
            const match = wildcardRegExp(entry.word).exec(text);
            return match ? { start: match.index, end: match.index + match[0].length, value: match[0], reason: `通配符匹配：${entry.word}` } : null;
        }
        const index = text.toLocaleLowerCase().indexOf(entry.word.toLocaleLowerCase());
        return index >= 0 ? { start: index, end: index + entry.word.length, value: text.slice(index, index + entry.word.length), reason: '包含匹配' } : null;
    }

    checkText(text) {
        const safeText = String(text || '');
        const hits = [];
        this.words.forEach((entry) => {
            const match = this.matchEntry(entry, safeText);
            if (match) {
                entry.count += 1;
                hits.push({ ...entry, match });
            }
        });
        if (hits.length) this.save();
        return hits;
    }

    generatePrefix(hits, selectedWords = null) {
        const words = (selectedWords || hits).map((hit) => hit.word).join(' / ');
        return this.prefixTemplate.replace(/\{words\}/g, words);
    }

    _initListener() {
        bus.on(EVENTS.ASSISTANT_DONE, (text) => {
            const hits = this.checkText(text);
            if (hits.length) bus.emit(EVENTS.MODERATOR_HIT, hits);
        });
    }
}

export const moderator = new ModeratorEngine();
export { DEFAULT_PREFIX, wildcardRegExp };
