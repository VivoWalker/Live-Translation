import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('extension/asr-terms.json', root), 'utf8'));
const cases = JSON.parse(fs.readFileSync(new URL('tests/fixtures/asr_domain_cases.json', root), 'utf8'));
const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('extension/asr-domain.js', root), 'utf8'), sandbox);
const create = (...args) => sandbox.JLSASRDomain.create(...args);

test('domain spelling corrects target livestream vocabulary while preserving ordinary Japanese', () => {
  const corrector = create(data);
  for (const [raw, expected] of cases) {
    assert.equal(corrector.correct(raw), expected, raw);
    assert.equal(corrector.correct(expected), expected, 'correction must be idempotent');
  }
});

test('disabled/general profiles keep Gakumas character and song rules isolated', () => {
  const off = create(data, 'off'), anime = create(data, 'anime');
  for (const [raw] of cases) assert.equal(off.correct(raw), raw);
  assert.equal(anime.correct('秦谷みすずの曲キャンパスモード'), '秦谷みすずの曲キャンパスモード');
  assert.equal(anime.correct('日高真白さんと羊宮ひなさん'), '陽高真白さんと羊宮妃那さん');
});

test('every curated full alias has one canonical output and guarded aliases require evidence', () => {
  const corrector = create(data);
  for (const entry of data.entries) for (const alias of entry.aliases) {
    const cue = entry.requires ? data.cues[entry.requires[0]][0] + '、' : '';
    assert.equal(corrector.correct(cue + alias), cue + entry.term, alias);
  }
});

test('literal matching respects English word boundaries, longest aliases and existing names', () => {
  const corrector = create({ version: 1, cues: {}, entries: [
    { term: '正式名', scope: 'common', aliases: ['ABC', 'ABC DEF'] },
    { term: '別名表記', scope: 'common', aliases: ['正式'] },
  ] });
  assert.equal(corrector.correct('ABC DEF、ABCDとXABC、ABCです。正式名'), '正式名、ABCDとXABC、正式名です。正式名');
});

test('malformed or oversized lexicons fail before use; no supplied pattern is evaluated', () => {
  assert.throws(() => create(data, 'unknown'));
  for (const invalid of [null, { ...data, version: 2 }, { ...data, entries: Array(501).fill(data.entries[0]) },
    { version: 1, cues: {}, entries: [{ term: '名前', scope: 'common', aliases: ['短'] }] },
    { version: 1, cues: {}, entries: [{ term: '名前', scope: 'common', aliases: ['誤名'], requires: ['missing'] }] }]) assert.throws(() => create(invalid));
  const pattern = create({ version: 1, cues: {}, entries: [{ term: '正しい名前', scope: 'common', aliases: ['(a+)+$'] }] });
  assert.equal(pattern.correct('a'.repeat(8000)), 'a'.repeat(8000));
  assert.equal(pattern.correct('(a+)+$'), '正しい名前');
});

test('long input and repeated sessions keep correction stateless and bounded', () => {
  const corrector = create(data), huge = '日高真白'.repeat(3000);
  assert.equal(corrector.correct(huge), huge);
  for (let i = 0; i < 2000; i++) assert.equal(corrector.correct('日高真白さん'), '陽高真白さん');
  assert(Object.isFrozen(corrector));
  assert.deepEqual(Object.keys(corrector).sort(), ['correct', 'profile']);
});
