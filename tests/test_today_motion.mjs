import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../cloud/frontend/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function travelToToday(){');
const end = source.indexOf('\nfunction renderMini()', start);
assert.ok(start >= 0 && end > start, '오늘 이동 함수를 찾을 수 있어야 합니다.');
const implementation = source.slice(start, end);

function dateAtOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function scenario(before, target, options = {}) {
  let clock = 0, nextId = 0;
  const pending = new Map(), shown = [], destinations = [];
  const state = { selected: before, travelFrame: null, calendarAnimation: null };
  const context = {
    state,
    document: { hidden: Boolean(options.hidden) },
    performance: { now: () => clock },
    window: { matchMedia: () => ({ matches: Boolean(options.reduced) }) },
    todayKst: () => target,
    asDate: day => new Date(`${day}T00:00:00.000Z`),
    addDays: dateAtOffset,
    paintTravelDay: day => shown.push(day),
    $: () => ({ classList: { add() {} } }),
    requestAnimationFrame(callback) { const id = ++nextId; pending.set(id, callback); return id; },
    cancelTimeTravel() { if (state.travelFrame !== null) pending.delete(state.travelFrame); state.travelFrame = null; },
    selectDay(day) { context.cancelTimeTravel(); state.selected = day; destinations.push(day); },
  };
  vm.createContext(context);
  vm.runInContext(implementation, context);
  function frame(delta) {
    clock += delta;
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach(callback => callback(clock));
  }
  function finish(delta = 16.67) {
    for (let i = 0; i < 500 && pending.size; i++) frame(delta);
    assert.equal(pending.size, 0, '이동은 제한된 시간에 끝나야 합니다.');
  }
  return { context, state, shown, destinations, pending, frame, finish, now: () => clock };
}

test('가까운 날짜는 같은 날을 거치지 않고 하루씩 정확히 오늘에 도착한다', () => {
  for (const before of ['2026-11-05', '2026-11-25', '2026-12-01']) {
    const s = scenario(before, '2026-11-10');
    s.context.travelToToday();
    s.finish();
    const direction = before < '2026-11-10' ? 1 : -1;
    const distance = Math.abs((Date.parse(`${before}T00:00:00Z`) - Date.parse('2026-11-10T00:00:00Z')) / 86400000);
    assert.deepEqual(s.shown, Array.from({ length: distance + 1 }, (_, i) => dateAtOffset(before, i * direction)));
    assert.equal(s.state.selected, '2026-11-10');
  }
});

test('먼 날짜일수록 하루당 걸리는 시간이 줄어든다', () => {
  const near = scenario('2026-11-05', '2026-11-10');
  const far = scenario('2026-10-11', '2026-11-10');
  near.context.travelToToday(); far.context.travelToToday();
  near.finish(); far.finish();
  assert.ok(far.now() / 30 < near.now() / 5);
  assert.ok(far.now() <= 1300);
});

test('가까운 날짜도 빠르고 먼 날짜의 하루당 속도 차이가 뚜렷하다', () => {
  const near = scenario('2026-11-05', '2026-11-10');
  const far = scenario('2026-10-11', '2026-11-10');
  near.context.travelToToday(); far.context.travelToToday();
  near.finish(); far.finish();
  assert.ok(near.now() <= 230, `5일 이동이 너무 느립니다: ${near.now()}ms`);
  assert.ok(far.now() <= 700, `30일 이동이 너무 느립니다: ${far.now()}ms`);
  assert.ok(far.now() / 30 < (near.now() / 5) * .65);
});

test('45일 이내는 재생하고 46일 이상은 즉시 이동한다', () => {
  const limit = scenario(dateAtOffset('2026-11-10', -45), '2026-11-10');
  limit.context.travelToToday();
  assert.equal(limit.pending.size, 1);
  limit.finish();
  assert.equal(limit.shown.length, 46);
  const distant = scenario(dateAtOffset('2026-11-10', -46), '2026-11-10');
  distant.context.travelToToday();
  assert.equal(distant.pending.size, 0);
  assert.deepEqual(distant.destinations, ['2026-11-10']);
});

test('프레임이 지연되어도 날짜를 순서대로 보여주고 장시간 멈추면 도착한다', () => {
  const slower = scenario('2026-11-20', '2026-11-10');
  slower.context.travelToToday(); slower.finish(80);
  assert.deepEqual(slower.shown, Array.from({ length: 11 }, (_, i) => dateAtOffset('2026-11-20', -i)));
  const stalled = scenario('2026-10-15', '2026-11-10');
  stalled.context.travelToToday(); stalled.frame(1800);
  assert.equal(stalled.pending.size, 0);
  assert.equal(stalled.state.selected, '2026-11-10');
});

test('동작 줄이기, 숨긴 화면, 반복 클릭에서는 바로 오늘로 이동한다', () => {
  for (const options of [{ reduced: true }, { hidden: true }]) {
    const s = scenario('2026-11-25', '2026-11-10', options);
    s.context.travelToToday();
    assert.equal(s.pending.size, 0);
    assert.equal(s.state.selected, '2026-11-10');
  }
  const repeated = scenario('2026-11-25', '2026-11-10');
  repeated.context.travelToToday(); repeated.frame(100); repeated.context.travelToToday();
  assert.equal(repeated.pending.size, 0);
  assert.equal(repeated.state.selected, '2026-11-10');
});
