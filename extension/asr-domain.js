/* Local, deterministic ASR spelling correction. Data never becomes a regexp. */
(() => {
  'use strict';
  const PROFILES = ['off', 'anime', 'gakumas'];
  const MAX_ENTRIES = 500, MAX_TEXT = 8192, RADIUS = 24;
  const length = value => Array.from(value).length;
  function checkedString(value, minimum = 2) {
    return typeof value === 'string' && length(value) >= minimum && length(value) <= 80 &&
      value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function create(data, profile = 'gakumas') {
    if (!PROFILES.includes(profile)) throw new Error('未知的识别词表');
    if (!data || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES ||
        !data.cues || typeof data.cues !== 'object' || Array.isArray(data.cues)) throw new Error('识别词表格式错误');
    const cues = new Map();
    for (const [name, values] of Object.entries(data.cues)) {
      if (cues.size >= 16 || !Array.isArray(values) || values.length > 40 || !values.every(value => checkedString(value, 1))) throw new Error('识别词表上下文格式错误');
      cues.set(name, values);
    }
    const aliases = new Map(), terms = [];
    for (const entry of data.entries) {
      if (!entry || !checkedString(entry.term) || !['common', 'gakumas'].includes(entry.scope) ||
          !Array.isArray(entry.aliases) || entry.aliases.length > 12 || !entry.aliases.every(value => checkedString(value)) ||
          (entry.requires !== undefined && (!Array.isArray(entry.requires) || !entry.requires.length || entry.requires.length > 16 || !entry.requires.every(c => cues.has(c))))) {
        throw new Error('识别词表条目格式错误');
      }
      terms.push(entry.term);
      for (const alias of entry.aliases) {
        if (alias === entry.term || aliases.has(alias)) throw new Error('识别词表存在重复别名');
        aliases.set(alias, entry);
      }
    }
    if (terms.some(term => aliases.has(term))) throw new Error('识别词表不能级联替换');
    const rules = Array.from(aliases, ([alias, entry]) => ({ alias, term: entry.term, scope: entry.scope, requires: entry.requires }))
      .filter(rule => profile !== 'off' && (profile === 'gakumas' || rule.scope === 'common'))
      .sort((a, b) => length(b.alias) - length(a.alias));
    const canonical = Array.from(new Set(terms)).sort((a, b) => length(b) - length(a));
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
    return Object.freeze({ profile, correct(text) {
      if (typeof text !== 'string' || !rules.length || length(text) > MAX_TEXT) return text;
      // Scan only the original hypothesis, longest match first. A replacement
      // cannot trigger another replacement or corrupt an existing proper name.
      let result = '', offset = 0;
      while (offset < text.length) {
        const char = String.fromCodePoint(text.codePointAt(offset));
        const protectedTerm = (termIndex.get(char) || []).find(term => text.startsWith(term, offset));
        const rule = (ruleIndex.get(char) || []).find(rule => {
          if (!text.startsWith(rule.alias, offset) || !boundary(text, offset, rule.alias)) return false;
          if (!rule.requires) return true;
          const near = Array.from(text.slice(0, offset)).slice(-RADIUS).join('') +
            Array.from(text.slice(offset + rule.alias.length)).slice(0, RADIUS).join('');
          return rule.requires.some(name => cues.get(name).some(cue => near.includes(cue)));
        });
        if (protectedTerm && (!rule || protectedTerm.length >= rule.alias.length)) { result += protectedTerm; offset += protectedTerm.length; }
        else if (rule) { result += rule.term; offset += rule.alias.length; }
        else { result += char; offset += char.length; }
      }
      return result;
    } });
  }
  globalThis.JLSASRDomain = Object.freeze({ create, profiles: Object.freeze(PROFILES) });
})();
