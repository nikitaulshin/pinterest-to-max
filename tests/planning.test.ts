import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { planningConfiguration } from '../src/cli.ts';
import { PublicationSchedule } from '../src/core/planning.ts';

function times(schedule: PublicationSchedule, now: string, minimumLeadMs = 0): string[] {
  return [...schedule.futureSlots(new Date(now), minimumLeadMs)].map((date) => date.toISOString());
}

test('daily slots are chronological Moscow times across a month boundary', () => {
  const schedule = new PublicationSchedule(['21:00', '09:00', '15:00'], 1);
  assert.deepEqual(times(schedule, '2026-01-31T11:00:00Z'), [
    '2026-01-31T12:00:00.000Z', '2026-01-31T18:00:00.000Z', '2026-02-01T06:00:00.000Z',
  ], 'All future slots within the calendar horizon must be ordered in UTC');
});

test('default horizon ends at the same Moscow time fourteen calendar days later', () => {
  const schedule = planningConfiguration({ PUBLICATION_SLOTS: '09:00' });
  const slots = times(schedule, '2026-11-10T06:00:00Z');
  assert.equal(slots.length, 14, 'Current slot must be excluded and the inclusive final slot retained');
  assert.equal(slots[0], '2026-11-11T06:00:00.000Z', 'The first slot must be strictly future');
  assert.equal(slots.at(-1), '2026-11-24T06:00:00.000Z', 'The horizon boundary must be included');
});

test('horizon excludes a slot one millisecond beyond its boundary', () => {
  assert.deepEqual(times(new PublicationSchedule(['09:00'], 1), '2026-11-10T05:59:59.999Z'), [
    '2026-11-10T06:00:00.000Z',
  ], 'Slots after the exact horizon must be excluded');
});

test('Moscow midnight follows the local calendar across a year boundary', () => {
  assert.deepEqual(times(new PublicationSchedule(['00:00'], 1), '2026-12-31T20:59:59Z'), [
    '2026-12-31T21:00:00.000Z',
  ], 'Moscow midnight must use the next local date before UTC midnight');
});

test('leap day is retained in the Moscow calendar', () => {
  assert.deepEqual(times(new PublicationSchedule(['00:00'], 2), '2028-02-28T21:00:00Z'), [
    '2028-02-29T21:00:00.000Z', '2028-03-01T21:00:00.000Z',
  ], 'Leap year arithmetic must preserve both calendar days and the inclusive end');
});

test('restart recalculates future slots without replaying missed days', () => {
  const schedule = new PublicationSchedule(['09:00', '15:00'], 1);
  const before = times(schedule, '2026-11-01T06:00:00Z');
  const resumed = times(schedule, '2026-11-05T12:00:01Z');
  assert.equal(before[0], '2026-11-01T12:00:00.000Z', 'Original calculation must start at the next slot');
  assert.deepEqual(resumed, ['2026-11-06T06:00:00.000Z', '2026-11-06T12:00:00.000Z'], 'A fresh calculation must never replay old slots');
});

test('known minimum lead excludes close slots and includes its exact boundary', () => {
  assert.deepEqual(times(new PublicationSchedule(['09:00', '09:01', '09:02'], 1), '2026-11-10T06:00:00Z', 120_000), [
    '2026-11-10T06:02:00.000Z', '2026-11-11T06:00:00.000Z',
  ], 'Known lead must be enforced without excluding its exact boundary');
});

test('no implicit MAX lead excludes a valid near-future slot', () => {
  assert.equal(times(new PublicationSchedule(['09:00'], 1), '2026-11-10T05:59:59Z')[0], '2026-11-10T06:00:00.000Z', 'Unknown platform constraints must not invent a minimum lead');
});

test('lead longer than the horizon leaves no slots', () => {
  assert.deepEqual(times(new PublicationSchedule(['09:00'], 1), '2026-11-10T06:00:00Z', 86_400_001), [], 'No slot may exceed the horizon to satisfy lead');
});

test('host time zones do not change Moscow scheduling', () => {
  for (const zone of ['America/Los_Angeles', 'Asia/Tokyo']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { PublicationSchedule } from './src/core/planning.ts';
      console.log(JSON.stringify([...new PublicationSchedule(['00:00', '09:00'], 1)
        .futureSlots(new Date('2026-03-08T20:59:59Z'))].map(date => date.toISOString())));
    `], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Independent host-zone process must succeed');
    assert.deepEqual(JSON.parse(result.stdout), ['2026-03-08T21:00:00.000Z', '2026-03-09T06:00:00.000Z'], 'Host zone and DST must not affect Moscow slots');
  }
});

for (const slots of [undefined, '', ' ', '09:00,', ',09:00', '09:00,09:00', '24:00', '12:60', '9:00', '09:0', '09:00:00']) {
  test(`invalid publication slots are rejected: ${JSON.stringify(slots)}`, () => {
    assert.throws(() => planningConfiguration({ ...(slots === undefined ? {} : { PUBLICATION_SLOTS: slots }) }), /PUBLICATION_SLOTS/, 'Invalid slots must identify the setting');
  });
}

for (const horizon of ['', '0', '-1', '1.5', '1e2', 'Infinity', 'NaN', '9007199254740992']) {
  test(`invalid planning horizon is rejected: ${JSON.stringify(horizon)}`, () => {
    assert.throws(() => planningConfiguration({ PUBLICATION_SLOTS: '09:00', PLANNING_HORIZON_DAYS: horizon }), /PLANNING_HORIZON_DAYS/, 'Invalid horizon must identify the setting');
  });
}

test('schedule rejects empty direct slot configuration', () => {
  assert.throws(() => new PublicationSchedule([]), /PUBLICATION_SLOTS/, 'Empty direct configuration must fail');
});

test('schedule rejects non-finite direct horizon', () => {
  assert.throws(() => new PublicationSchedule(['09:00'], NaN), /PLANNING_HORIZON_DAYS/, 'Non-finite direct horizon must fail');
});

test('schedule rejects invalid clock', () => {
  assert.throws(() => [...new PublicationSchedule(['09:00']).futureSlots(new Date(NaN))], /датой/, 'Invalid clock must fail');
});

test('schedule rejects horizon beyond the supported date range', () => {
  assert.throws(() => [...new PublicationSchedule(['09:00'], Number.MAX_SAFE_INTEGER).futureSlots(new Date('2026-11-10T00:00:00Z'))], /PLANNING_HORIZON_DAYS/, 'Unrepresentable horizon must fail before iteration');
});

test('large representable horizon can return its first slot lazily', () => {
  const slots = planningConfiguration({ PUBLICATION_SLOTS: '09:00', PLANNING_HORIZON_DAYS: '1000000' })
    .futureSlots(new Date('2026-11-10T00:00:00Z'));
  assert.equal(slots.next().value?.toISOString(), '2026-11-10T06:00:00.000Z', 'A large horizon must not require materializing all slots');
});

for (const lead of [-1, 0.1, NaN, Infinity]) {
  test(`invalid minimum lead is rejected: ${String(lead)}`, () => {
    assert.throws(() => times(new PublicationSchedule(['09:00']), '2026-11-10T00:00:00Z', lead), /запас/, 'Invalid lead must fail before returning slots');
  });
}
