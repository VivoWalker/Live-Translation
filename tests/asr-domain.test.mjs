import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const cases = JSON.parse(fs.readFileSync(new URL('tests/fixtures/asr_domain_cases.json', root), 'utf8'));
const sandbox = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(new URL('extension/asr-domain.js', root), 'utf8'), sandbox);
const create = (...args) => sandbox.JLSASRDomain.create(...args);
const packs = Object.fromEntries(sandbox.JLSASRDomain.packs.map(id =>
  [id, JSON.parse(fs.readFileSync(new URL(`extension/asr-terms/${id}.json`, root), 'utf8'))]));
const select = sandbox.JLSASRDomain.loadPacks(packs);
const data = packs.mashiro;

test('episode metadata selects the most specific pack and audits only trusted aliases', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('extension/asr-terms/episodes.json', root), 'utf8'));
  const catalog = sandbox.JLSASRDomain.loadEpisodes(raw);
  assert.equal(catalog('【学マス】初星学園ＨＲ #10').episode, '初星学園HR');
  assert.equal(catalog('その他の雑談'), null);
  raw.episodes[0].terms.push(
    { canonical: '夏空太郎', aliases: ['なつぞら太郎'], verified: true, source: 'https://example.test/cast' },
    { canonical: '秋空あき', aliases: ['あきぞらあき'], verified: false },
  );
  const episode = sandbox.JLSASRDomain.loadEpisodes(raw)('初星学園HR');
  const transcript = '夏空太郎、なつぞら太郎とあきぞらあき';
  const result = select([episode.pack], episode).explain(transcript);
  assert.equal(result.text, '夏空太郎、夏空太郎とあきぞらあき');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].source, 'https://example.test/cast');
});

test('domain spelling corrects target livestream vocabulary while preserving ordinary Japanese', () => {
  const corrector = select();
  for (const [raw, expected] of cases) {
    assert.equal(corrector.correct(raw), expected, raw);
    assert.equal(corrector.correct(expected), expected, 'correction must be idempotent');
  }
});

test('independent packs and legacy selections work', () => {
  const off = select([]), anime = select('anime');
  for (const [raw] of cases) assert.equal(off.correct(raw), raw);
  assert.equal(anime.correct('秦谷みすずの曲キャンパスモード'), '秦谷みすずの曲キャンパスモード');
  assert.equal(anime.correct('日高真白さんと羊宮ひなさん'), '陽高真白さんと羊宮妃那さん');
  const sample = '日高真白と十王せな、秦谷みすず、羊宮ひな、逢田りかこ、みなせいのり';
  assert.equal(select(['mashiro']).correct(sample), '陽高真白と十王星南、秦谷みすず、羊宮ひな、逢田りかこ、みなせいのり');
  assert.equal(select(['gakumas']).correct(sample), '日高真白と十王星南、秦谷美鈴、羊宮ひな、逢田りかこ、みなせいのり');
  assert.equal(select(['lovelive', 'bandori']).correct(sample), '日高真白と十王せな、秦谷みすず、羊宮妃那、逢田梨香子、みなせいのり');
  assert.equal(select(['general']).correct(sample), '日高真白と十王せな、秦谷みすず、羊宮ひな、逢田りかこ、水瀬いのり');
  assert.throws(() => select(['unknown']));
});

test('every curated full alias has one canonical output and guarded aliases require evidence', () => {
  for (const [id, pack] of Object.entries(packs)) {
    const corrector = select([id]);
    for (const entry of pack.entries) for (const alias of entry.aliases) {
      const { text, requires = entry.requires } = typeof alias === 'string' ? { text: alias } : alias;
      const cue = requires ? pack.cues[requires[0]][0] + '、' : '';
      assert.equal(corrector.correct(cue + text), cue + entry.term, `${id}: ${text}`);
    }
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
    { version: 1, cues: { cue: ['話題'] }, entries: [{ term: '名前', aliases: [{ text: 'ABC', requires: ['cue'], katakanaBoundary: true }] }] },
    { version: 1, cues: {}, entries: [{ term: '名前', aliases: [{ text: '別名' }] }] },
    { version: 1, cues: {}, entries: [{ term: '名前', scope: 'common', aliases: ['誤名'], requires: ['missing'] }] }]) assert.throws(() => create(invalid));
  const pattern = create({ version: 1, cues: {}, entries: [{ term: '正しい名前', scope: 'common', aliases: ['(a+)+$'] }] });
  assert.equal(pattern.correct('a'.repeat(8000)), 'a'.repeat(8000));
  assert.equal(pattern.correct('(a+)+$'), '正しい名前');
});

test('an alias can override the entry context without allowing a cue across the match or sentence', () => {
  const corrector = create({ version: 1, cues: { default: ['話題'], narrow: ['特集'] }, entries: [
    { term: '標準名', aliases: ['別名', { text: '略名', requires: ['narrow'] }], requires: ['default'] },
  ] });
  assert.equal(corrector.correct('話題は別名、略名です。'), '話題は標準名、略名です。');
  assert.equal(corrector.correct('略名の特集'), '標準名の特集');
  assert.equal(corrector.correct('特略名集。特集。略名です。'), '特略名集。特集。略名です。');
});

test('long input and repeated sessions keep correction stateless and bounded', () => {
  const corrector = create(data), huge = '日高真白'.repeat(3000);
  assert.equal(corrector.correct(huge), huge);
  for (let i = 0; i < 2000; i++) assert.equal(corrector.correct('日高真白さん'), '陽高真白さん');
  assert(Object.isFrozen(corrector));
  assert.deepEqual(Object.keys(corrector).sort(), ['correct', 'explain', 'profile']);
});
