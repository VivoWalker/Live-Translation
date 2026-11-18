import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = vm.createContext({ setTimeout, clearTimeout, performance });
for (const file of ['caption-settings.js', 'caption-overlay.js']) {
  vm.runInContext(fs.readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8'), sandbox);
}
const { CaptionTimeline, captionReadingTime, captionPreferences } = sandbox.JLS;
function fixture() {
  let now = 0, next = 0;
  const timers = new Map();
  const timeline = new CaptionTimeline({ now: () => now,
    setTimer: (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; },
    clearTimer: id => timers.delete(id),
  });
  return { timeline, timers, jump(ms) { now += ms; }, advance(ms) {
    const end = now + ms;
    while (true) {
      const candidate = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!candidate) break;
      now = candidate[1].at; timers.delete(candidate[0]); candidate[1].fn();
    }
    now = end;
  } };
}
function complete(timeline, id, text) {
  timeline.start(id); timeline.text(id, 'final', '日本語 ' + id); timeline.translation(id, text, true);
}

test('reading time follows Unicode text length, with a practical minimum and maximum', () => {
  assert.equal(captionReadingTime('好'), 3000);
  assert(captionReadingTime('这是一段需要认真阅读的较长字幕。'.repeat(4)) > captionReadingTime('谢谢'));
  assert.equal(captionReadingTime('字'.repeat(10000)), 24000);
  assert(captionReadingTime('字'.repeat(60), 4) > captionReadingTime('字'.repeat(60), 10));
  assert.equal(captionReadingTime('字 '.repeat(30)), captionReadingTime('字'.repeat(30)));
});

test('several short sentences cannot evict a long translation before its reading deadline', () => {
  const { timeline, advance } = fixture();
  complete(timeline, 1, '这是一句需要留出阅读时间的长译文。'.repeat(5));
  const deadline = timeline.visible[0].deadline;
  complete(timeline, 2, '好'); complete(timeline, 3, '谢谢'); complete(timeline, 4, '再见');
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [1, 2]);
  assert.deepEqual(Array.from(timeline.pending, e => e.id), [3, 4]);
  advance(deadline - 1);
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [1, 2]);
  advance(2);
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [2, 3]);
  advance(598);
  assert(timeline.visible.some(e => e.id === 2), 'later short sentence must remain through the earlier exit');
  advance(2);
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [3, 4]);
});

test('a queued translation receives its full reading time when it becomes visible', () => {
  const { timeline, advance } = fixture();
  complete(timeline, 1, '好'); complete(timeline, 2, '好'); complete(timeline, 3, '稍后显示');
  advance(2999); assert.equal(timeline.entries.get(3).shownAt, undefined);
  advance(2); assert.equal(timeline.entries.get(3).shownAt, 3000);
  advance(2998); assert(timeline.visible.some(e => e.id === 3));
  advance(2); assert.equal(timeline.visible.length, 0);
});

test('hovering pauses all reading clocks, including translations arriving during the pause', () => {
  const { timeline, advance, timers } = fixture();
  complete(timeline, 1, '好'); advance(1000); timeline.pause(true);
  assert.equal(timers.size, 0);
  advance(10000); complete(timeline, 2, '新译文'); advance(5000);
  assert.equal(timeline.visible.length, 2);
  timeline.pause(false);
  assert.equal(timeline.entries.get(1).deadline, 18000);
  assert.equal(timeline.entries.get(2).deadline, 19000);
  advance(1999); assert.equal(timeline.visible.length, 2);
  advance(2); assert.deepEqual(Array.from(timeline.visible, e => e.id), [2]);
});

test('late translations do not rewind the live source or resurrect already retired captions', () => {
  const { timeline, advance } = fixture();
  timeline.text(1, 'final', '古い句'); timeline.text(2, 'partial', '新しい句');
  timeline.translation(1, '旧句译文', true);
  assert.equal(timeline.currentId, 2);
  advance(3001); timeline.translation(1, '旧句重试', true);
  assert.equal(timeline.visible.length, 0);
  assert.equal(timeline.currentId, 2);
});

test('identical duplicate results neither add rows nor reset their deadlines', () => {
  const { timeline, advance } = fixture();
  complete(timeline, 1, '好'); advance(1000); timeline.translation(1, '好', true);
  assert.equal(timeline.visible.length, 1);
  advance(2001); assert.equal(timeline.visible.length, 0);
});

test('out-of-order API responses preserve the sentence order without resetting reading clocks', () => {
  const { timeline, advance } = fixture();
  timeline.text(1, 'final', '最初の句');
  complete(timeline, 2, '第二句先到');
  const originalDeadline = timeline.entries.get(2).readUntil;
  advance(500); timeline.translation(1, '第一句后到', true);
  assert.deepEqual(Array.from(timeline.visible, entry => entry.id), [1, 2]);
  assert.equal(timeline.entries.get(2).readUntil, originalDeadline);
  assert(timeline.entries.get(2).deadline > timeline.entries.get(1).deadline);
  assert.equal(timeline.currentId, 2);
});

test('explicit return to live skips the queue and starts the latest translation with a fresh clock', () => {
  const { timeline, advance } = fixture();
  for (let id = 1; id <= 8; id++) complete(timeline, id, '最新译文 ' + id);
  advance(1000); timeline.catchUp();
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [8]);
  assert.equal(timeline.pending.length, 0);
  assert.equal(timeline.visible[0].shownAt, 1000);
});

test('a long-running session keeps bounded state and clear cancels scheduled work', () => {
  const { timeline, timers, advance } = fixture();
  for (let id = 0; id < 1000; id++) complete(timeline, id, '译文 ' + id);
  assert(timeline.entries.size <= 64);
  assert(timeline.pending.length <= 32);
  assert.deepEqual(Array.from(timeline.visible, e => e.id), [0, 1]);
  timeline.clear();
  assert.equal(timers.size, 0); assert.equal(timeline.entries.size, 0);
  advance(100000); assert.equal(timeline.visible.length, 0);
});

test('public style preferences accept only known, bounded values', () => {
  const prefs = captionPreferences({ fontSize: 1000, width: -1, background: 100, cps: 0,
    color: 'url(https://bad.invalid)', position: { x: -100, y: 100 }, apiKey: 'private', showJa: false,
    anchor: 'top', align: 'left', theme: '__proto__', font: 'url(https://bad.invalid)',
    sourceColor: '#ABCDEF', focusBackground: 40, animations: false, minSeconds: 50 });
  assert.equal(prefs.fontSize, 40); assert.equal(prefs.width, 40); assert.equal(prefs.background, 70);
  assert.equal(prefs.cps, 4); assert.equal(prefs.color, '#f3f6ff'); assert.equal(prefs.showJa, false);
  assert.equal(prefs.position.x, 0); assert.equal(prefs.position.y, 1);
  assert.equal(prefs.apiKey, undefined);
  assert.equal(prefs.sourceSize, 28);
  assert.equal(prefs.sourceColor, '#abcdef');
  assert.equal(prefs.anchor, 'top');
  assert.equal(prefs.align, 'left');
  assert.equal(prefs.focusBackground, 75);
  assert.equal(prefs.font, 'system');
  assert.equal(prefs.theme, 'system');
  assert.equal(prefs.animations, false);
  assert.equal(prefs.minSeconds, 10);
  assert.equal(captionPreferences(null).fontSize, 24);
});

test('changing minimum reading time extends short captions without changing departure order', () => {
  const { timeline, advance } = fixture();
  complete(timeline, 1, '前一句较长，需要先读完。'.repeat(3));
  complete(timeline, 2, '好');
  timeline.speed(10, 7);
  assert.equal(timeline.visible[0].readUntil, 7000);
  assert.equal(timeline.visible[1].readUntil, 7000);
  advance(7001);
  assert.deepEqual(Array.from(timeline.visible, entry => entry.id), [2]);
  advance(600);
  assert.equal(timeline.visible.length, 0);
});

test('an overdue timer still dismisses the earlier sentence before the later short one', () => {
  const { timeline, advance, jump } = fixture();
  complete(timeline, 1, '前一句较长，需要先读完。'.repeat(3)); complete(timeline, 2, '好');
  jump(30000); timeline.tick();
  assert.deepEqual(Array.from(timeline.visible, entry => entry.id), [2]);
  advance(599); assert.equal(timeline.visible.length, 1);
  advance(2); assert.equal(timeline.visible.length, 0);
});

test('final Japanese survives the next sentence and reading begins only after translation arrives', () => {
  const { timeline, advance } = fixture();
  timeline.text(1, 'partial', '今日は東京の');
  timeline.text(1, 'final', '今日は東京の天気についてお話しします。');
  assert.equal(timeline.visible[0].ja, '今日は東京の天気についてお話しします。');
  advance(12000); timeline.start(2); timeline.text(2, 'partial', '午後から');
  assert.equal(timeline.visible[0].id, 1);
  timeline.text(1, 'partial', '古い下書き');
  assert.equal(timeline.visible[0].ja, '今日は東京の天気についてお話しします。');
  timeline.translation(1, '今天介绍东京的天气。', true);
  const deadline = timeline.entries.get(1).deadline;
  assert.equal(deadline, 12000 + captionReadingTime('今天介绍东京的天气。'));
  advance(captionReadingTime('今天介绍东京的天气。') - 1);
  assert.equal(timeline.visible[0].id, 1);
});

test('a queued final keeps the preview until it can display its translated row', () => {
  const { timeline, advance } = fixture();
  complete(timeline, 1, '好'); complete(timeline, 2, '好');
  timeline.text(3, 'final', '翻訳を待っています。'); timeline.start(4);
  assert.equal(timeline.preview().id, 3);
  timeline.translation(3, '正在等待翻译。', true);
  assert.equal(timeline.preview().id, 3);
  advance(3001);
  assert(timeline.visible.some(entry => entry.id === 3));
  assert.equal(timeline.preview(), null);
});

test('failed and missing responses cannot hold source-only rows forever', () => {
  const { timeline, advance, timers } = fixture();
  timeline.text(1, 'final', '翻訳に失敗しました。'); timeline.fail(1);
  advance(captionReadingTime('翻訳に失敗しました。') + 1);
  assert.equal(timeline.visible.length, 0);
  timeline.text(2, 'final', '返事がありません。');
  advance(60001); assert.equal(timeline.visible[0].failed, true);
  advance(captionReadingTime('返事がありません。') + 1);
  assert.equal(timeline.visible.length, 0);
  assert.equal(timers.size, 0);
});
