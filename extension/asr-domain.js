/* Local, deterministic ASR spelling correction. Data never becomes a regexp. */
(() => {
  'use strict';
  const PACKS = ['mashiro', 'gakumas', 'bandori', 'lovelive', 'general'];
  const PROFILES = ['off', 'anime', 'gakumas'];
  const MAX_ENTRIES = 500, MAX_TEXT = 8192, RADIUS = 24;
  const SENTENCE_BREAK = /[。？?\r\n]|(?<![A-Za-z!！])[!！]+/;
  const length = value => Array.from(value).length;
  const katakana = char => !!char && /[ァ-ヺーヽヾ]/.test(char);
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
  function read(data, profile = 'gakumas', source = 'custom') {
    if (!data || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES ||
        !data.cues || typeof data.cues !== 'object' || Array.isArray(data.cues)) throw new Error('识别词表格式错误');
    const cues = new Map();
    for (const [name, values] of Object.entries(data.cues)) {
      if (cues.size >= 16 || !Array.isArray(values) || values.length > 40 || !values.every(value => checkedString(value, 1))) throw new Error('识别词表上下文格式错误');
      cues.set(name, values);
    }
    function context(requires) {
      if (requires === undefined) return undefined;
      if (!Array.isArray(requires) || !requires.length || requires.length > 16 || !requires.every(name => cues.has(name))) {
        throw new Error('识别词表上下文格式错误');
      }
      return requires.flatMap(name => cues.get(name));
    }
    const aliases = new Set(), terms = new Set(), rules = [];
    for (const entry of data.entries) {
      if (!entry || !checkedString(entry.term) || (entry.scope !== undefined && !['common', 'gakumas'].includes(entry.scope)) ||
          !Array.isArray(entry.aliases) || entry.aliases.length > 12) {
        throw new Error('识别词表条目格式错误');
      }
      const entryCues = context(entry.requires);
      const { verified = true, candidate = false } = entry;
      if (typeof verified !== 'boolean' || typeof candidate !== 'boolean') throw new Error('识别词表证据格式错误');
      if (verified) terms.add(entry.term);
      for (const value of entry.aliases) {
        const plain = typeof value === 'string';
        const { text: alias, requires, katakanaBoundary = false, verified: aliasVerified = true,
          candidate: aliasCandidate = false } = plain ? { text: value } : value || {};
        if (!checkedString(alias) || (!plain && !['requires', 'katakanaBoundary', 'verified', 'candidate'].some(key => Object.hasOwn(value, key))) ||
            typeof katakanaBoundary !== 'boolean' || typeof aliasVerified !== 'boolean' || typeof aliasCandidate !== 'boolean' ||
            (katakanaBoundary && !Array.from(alias).every(katakana))) {
          throw new Error('识别词表别名格式错误');
        }
        const aliasCues = requires === undefined ? entryCues : context(requires);
        if (alias === entry.term || aliases.has(alias)) throw new Error('识别词表存在重复别名');
        aliases.add(alias);
        if (profile !== 'off' && (profile === 'gakumas' || entry.scope !== 'gakumas')) {
          const trusted = verified && aliasVerified;
          const level = candidate || aliasCandidate || !trusted ? 3 : aliasCues ? 2 : 1;
          const trigger = ['', 'curated_alias', 'sentence_cue', 'candidate_only'][level];
          rules.push({ alias, term: entry.term, cues: aliasCues, katakanaBoundary, source, verified: trusted, level, trigger });
        }
      }
    }
    if (rules.some(rule => rule.level < 3 && terms.has(rule.alias))) throw new Error('识别词表不能级联替换');
    return { terms, rules };
  }
  function compile(packs) {
    const canonical = new Set(packs.flatMap(pack => [...pack.terms]));
    const groups = new Map();
    for (const rule of packs.flatMap(pack => pack.rules)) {
      if (canonical.has(rule.alias)) continue;
      if (!groups.has(rule.alias)) groups.set(rule.alias, []);
      groups.get(rule.alias).push(rule);
    }
    const resolved = [...groups.values()].flatMap(group => {
      const verified = group.filter(rule => rule.verified);
      if (new Set(verified.map(rule => rule.term)).size > 1) {
        return group.map(rule => ({ ...rule, level: 3, trigger: 'conflicting_alias' }));
      }
      return verified.some(rule => rule.level === 3) ? group.filter(rule => rule.level === 3) : group;
    });
    const rules = [...new Map(resolved.map(rule => [JSON.stringify(rule), rule])).values()]
      .sort((a, b) => length(b.alias) - length(a.alias) || a.level - b.level);
    const index = (values, key) => {
      const map = new Map();
      for (const value of values) {
        const first = Array.from(key(value))[0];
        if (!map.has(first)) map.set(first, []);
        map.get(first).push(value);
      }
      return map;
    };
    const ruleIndex = index(rules, rule => rule.alias);
    const termIndex = index([...canonical].sort((a, b) => length(b) - length(a)), term => term);
    const latin = char => !!char && /[A-Za-z0-9_]/.test(char);
    const boundary = (text, offset, alias) => {
      return !(latin(alias[0]) && latin(text[offset - 1])) && !(latin(alias.at(-1)) && latin(text[offset + alias.length]));
    };
    function explain(text) {
      const changes = [], candidates = [];
      if (typeof text !== 'string' || !rules.length || length(text) > MAX_TEXT) return { text, changes, candidates };
      // Scan only the original hypothesis, longest match first. A replacement
      // cannot trigger another replacement or corrupt an existing proper name.
      let result = '', offset = 0, position = 0;
      while (offset < text.length) {
        const char = String.fromCodePoint(text.codePointAt(offset));
        const protectedTerm = (termIndex.get(char) || []).find(term => text.startsWith(term, offset));
        const evidence = rule => ({ alias: rule.alias, canonical: rule.term, start: position, end: position + length(rule.alias),
          source: rule.source, verified: rule.verified, independent_asr: false, rule: rule.trigger,
          decision: rule.level === 3 ? 'suggested' : 'accepted', level: rule.level });
        const rule = (ruleIndex.get(char) || []).find(rule => {
          if (!text.startsWith(rule.alias, offset) || !boundary(text, offset, rule.alias) ||
              (protectedTerm && length(protectedTerm) >= length(rule.alias))) return false;
          const end = offset + rule.alias.length;
          if (rule.katakanaBoundary && (katakana(text[offset - 1]) || katakana(text[end]))) return false;
          if (rule.cues) {
            const before = Array.from(text.slice(Math.max(0, offset - RADIUS * 2), offset)).slice(-RADIUS).join('').split(SENTENCE_BREAK).at(-1);
            const after = Array.from(text.slice(end, end + RADIUS * 2)).slice(0, RADIUS).join('').split(SENTENCE_BREAK, 1)[0];
            if (!rule.cues.some(cue => before.includes(cue) || after.includes(cue))) return false;
          }
          if (rule.level === 3) {
            if (candidates.length < 32) candidates.push(evidence(rule));
            return false;
          }
          return true;
        });
        if (rule) {
          changes.push(evidence(rule));
          result += rule.term;
          offset += rule.alias.length;
          position += length(rule.alias);
        } else {
          const chunk = protectedTerm || char;
          result += chunk;
          offset += chunk.length;
          position += length(chunk);
        }
      }
      return { text: result, changes, candidates };
    }
    return Object.freeze({ explain, correct: text => explain(text).text });
  }
  function create(data, profile = 'gakumas') {
    if (!PROFILES.includes(profile)) throw new Error('未知的识别词表');
    return Object.freeze({ profile, ...compile([read(data, profile)]) });
  }
  function loadPacks(data) {
    const packs = new Map(PACKS.map(id => [id, read(data[id], 'gakumas', 'pack:' + id)]));
    return (selection, episode) => {
      const selected = normalizePacks(selection).map(id => packs.get(id));
      return compile(episode ? selected.concat(episode.lexicon) : selected);
    };
  }
  function loadEpisodes(data) {
    if (data?.version !== 1 || !Array.isArray(data.episodes) || data.episodes.length > 64) throw new Error('节目词表格式错误');
    const source = value => {
      if (typeof value !== 'string' || value.length > 300) throw new Error('节目词表缺少来源');
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('节目词表来源无效');
      return value;
    };
    const fold = text => text.normalize('NFKC').toLowerCase();
    const rules = [];
    for (const { episode = '', franchise, pack, title_contains: titles, terms = [], source: url } of data.episodes) {
      if ((episode !== '' && !checkedString(episode)) || !checkedString(franchise) || !PACKS.includes(pack) ||
          !Array.isArray(titles) || !titles.length || titles.length > 8 || !titles.every(t => checkedString(t, 3)) ||
          !Array.isArray(terms) || terms.length > 32) throw new Error('节目词条格式错误');
      const verifiedSource = source(url);
      const lexicon = [];
      for (const { canonical, reading = '', verified = false, aliases = [], source: origin = verifiedSource } of terms) {
        if (!checkedString(canonical) || typeof verified !== 'boolean' || !Array.isArray(aliases) ||
            aliases.length > 8 || !aliases.every(alias => checkedString(alias, 3)) ||
            (reading !== '' && !checkedString(reading))) throw new Error('节目专名格式错误');
        const termSource = source(origin);
        const rules = aliases.filter(alias => alias !== canonical).map(alias => ({
          alias, term: canonical, source: termSource, verified, level: verified ? 2 : 3,
          trigger: verified ? 'episode_scope' : 'candidate_only',
        }));
        if (reading && reading !== canonical && !aliases.includes(reading)) rules.push({
          alias: reading, term: canonical, source: termSource, verified, level: 3,
          trigger: verified ? 'episode_candidate' : 'candidate_only',
        });
        lexicon.push({ terms: new Set(verified ? [canonical] : []), rules });
      }
      const selection = { episode, franchise, pack, source: verifiedSource, lexicon };
      rules.push(...titles.map(title => [fold(title), selection]));
    }
    rules.sort((a, b) => length(b[0]) - length(a[0]));
    return title => {
      const normalized = fold(typeof title === 'string' ? title.slice(0, 240) : '');
      return rules.find(([match]) => normalized.includes(match))?.[1] || null;
    };
  }
  globalThis.JLSASRDomain = Object.freeze({ create, loadPacks, loadEpisodes, normalizePacks, packs: Object.freeze(PACKS) });
})();
