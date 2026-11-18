/* Local, deterministic ASR spelling correction. Data never becomes a regexp. */
(() => {
  'use strict';
  const PACKS = ['mashiro', 'gakumas', 'bandori', 'lovelive', 'general'];
  const PROFILES = ['off', 'anime', 'gakumas'];
  const MAX_ENTRIES = 500, MAX_TEXT = 8192, RADIUS = 24;
  const length = value => Array.from(value).length;
  function checkedString(value, minimum = 2) {
    return typeof value === 'string' && length(value) >= minimum && length(value) <= 80 &&
      value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function normalizePacks(selection = 'gakumas') {
    if (selection === 'gakumas') return PACKS.slice();
    if (selection === 'off') return [];
    if (selection === 'anime') return PACKS.filter(pack => pack !== 'gakumas');
    if (!Array.isArray(selection) || selection.length > PACKS.length || !selection.every(pack => PACKS.includes(pack))) {
      throw new Error('未知的识别词表');
    }
    return PACKS.filter(pack => selection.includes(pack));
  }
  function read(data, profile = 'gakumas') {
    if (!data || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES ||
        !data.cues || typeof data.cues !== 'object' || Array.isArray(data.cues)) throw new Error('识别词表格式错误');
    const cues = new Map();
    for (const [name, values] of Object.entries(data.cues)) {
      if (cues.size >= 16 || !Array.isArray(values) || values.length > 40 || !values.every(value => checkedString(value, 1))) throw new Error('识别词表上下文格式错误');
      cues.set(name, values);
    }
    const aliases = new Set(), terms = new Set(), rules = [];
    for (const entry of data.entries) {
      if (!entry || !checkedString(entry.term) || (entry.scope !== undefined && !['common', 'gakumas'].includes(entry.scope)) ||
          !Array.isArray(entry.aliases) || entry.aliases.length > 12 || !entry.aliases.every(value => checkedString(value)) ||
          (entry.requires !== undefined && (!Array.isArray(entry.requires) || !entry.requires.length || entry.requires.length > 16 || !entry.requires.every(c => cues.has(c))))) {
        throw new Error('识别词表条目格式错误');
      }
      terms.add(entry.term);
      for (const alias of entry.aliases) {
        if (alias === entry.term || aliases.has(alias)) throw new Error('识别词表存在重复别名');
        aliases.add(alias);
        if (profile !== 'off' && (profile === 'gakumas' || entry.scope !== 'gakumas')) {
          rules.push({ alias, term: entry.term, cues: entry.requires?.flatMap(name => cues.get(name)) });
        }
      }
    }
    if ([...terms].some(term => aliases.has(term))) throw new Error('识别词表不能级联替换');
    return { terms, rules };
  }
  function compile(packs) {
    const rules = packs.flatMap(pack => pack.rules).sort((a, b) => length(b.alias) - length(a.alias));
    const canonical = [...new Set(packs.flatMap(pack => [...pack.terms]))].sort((a, b) => length(b) - length(a));
    const aliases = new Map();
    for (const { alias, term } of rules) {
      if (aliases.has(alias) && aliases.get(alias) !== term) throw new Error('不同识别词表的别名冲突');
      aliases.set(alias, term);
    }
    if (canonical.some(term => aliases.has(term))) throw new Error('识别词表不能级联替换');
    const index = (values, key) => {
      const map = new Map();
      for (const value of values) {
        const first = Array.from(key(value))[0];
        if (!map.has(first)) map.set(first, []);
        map.get(first).push(value);
      }
      return map;
    };
    const ruleIndex = index(rules, rule => rule.alias), termIndex = index(canonical, term => term);
    const latin = char => !!char && /[A-Za-z0-9_]/.test(char);
    const boundary = (text, offset, alias) => {
      const before = Array.from(text.slice(0, offset)).at(-1), after = Array.from(text.slice(offset + alias.length))[0];
      return !(latin(alias[0]) && latin(before)) && !(latin(alias.at(-1)) && latin(after));
    };
    return Object.freeze({ correct(text) {
      if (typeof text !== 'string' || !rules.length || length(text) > MAX_TEXT) return text;
      // Scan only the original hypothesis, longest match first. A replacement
      // cannot trigger another replacement or corrupt an existing proper name.
      let result = '', offset = 0;
      while (offset < text.length) {
        const char = String.fromCodePoint(text.codePointAt(offset));
        const protectedTerm = (termIndex.get(char) || []).find(term => text.startsWith(term, offset));
        const rule = (ruleIndex.get(char) || []).find(rule => {
          if (!text.startsWith(rule.alias, offset) || !boundary(text, offset, rule.alias)) return false;
          if (!rule.cues) return true;
          const before = Array.from(text.slice(Math.max(0, offset - RADIUS * 2), offset)).slice(-RADIUS).join('');
          const after = Array.from(text.slice(offset + rule.alias.length, offset + rule.alias.length + RADIUS * 2)).slice(0, RADIUS).join('');
          return rule.cues.some(cue => before.includes(cue) || after.includes(cue));
        });
        if (protectedTerm && (!rule || protectedTerm.length >= rule.alias.length)) { result += protectedTerm; offset += protectedTerm.length; }
        else if (rule) { result += rule.term; offset += rule.alias.length; }
        else { result += char; offset += char.length; }
      }
      return result;
    } });
  }
  function create(data, profile = 'gakumas') {
    if (!PROFILES.includes(profile)) throw new Error('未知的识别词表');
    return Object.freeze({ profile, ...compile([read(data, profile)]) });
  }
  function loadPacks(data) {
    const packs = new Map(PACKS.map(id => [id, read(data[id])]));
    return selection => compile(normalizePacks(selection).map(id => packs.get(id)));
  }
  globalThis.JLSASRDomain = Object.freeze({ create, loadPacks, normalizePacks, packs: Object.freeze(PACKS) });
})();
