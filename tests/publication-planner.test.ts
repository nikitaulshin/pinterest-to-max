import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicationPlanner, PublicationSchedule } from '../src/core/planning.ts';
import type { QueueState } from '../src/core/queue.ts';

const channelUrl = 'https://web.max.ru/-123';
const now = new Date('2026-11-10T05:00:00Z');
const schedule = new PublicationSchedule(['09:00', '15:00', '21:00'], 1);
function job(id: number, overrides: Partial<QueueState & { scheduled_at: string | null }> = {}) {
  return { id, added_at: '2026-11-09T00:00:00Z', status: 'ready', next_attempt_at: null, max_post_url: null, scheduled_at: null, ...overrides };
}
function plan(queue = [job(1)], posts: { scheduledAt: string }[] = [], limit = 100, platformLimit: number | null = 100) {
  return new PublicationPlanner(schedule, limit, platformLimit).plan({ queue, snapshot: { channelUrl, posts }, channelUrl, now });
}

test('manual post seconds occupy the entire planned minute', () => {
  const result = plan([job(1)], [{ scheduledAt: '2026-11-10T06:00:59Z' }]);
  assert.deepEqual(result.assignments, [{ jobId: 1, scheduledAt: '2026-11-10T12:00:00.000Z' }], 'A manual post must block the whole minute');
  assert.deepEqual(result.occupiedSlots, ['2026-11-10T06:00:00.000Z'], 'Occupied minutes must be normalized to UTC');
});

test('due safe ready jobs use FIFO with stable ID tie breaking', () => {
  const queue = [job(9), job(5), job(1, { added_at: '2026-11-08T00:00:00Z', next_attempt_at: '2026-11-11T00:00:00Z' }),
    job(2, { next_attempt_at: now.toISOString() }), job(3, { max_post_url: 'https://max.ru/post' }), job(4, { status: 'failed' })];
  const before = structuredClone(queue);
  assert.deepEqual(plan(queue).assignments.map((item) => item.jobId), [2, 5, 9], 'Deferred and unsafe jobs must not block FIFO');
  assert.deepEqual(queue, before, 'Planning must not reorder or mutate queue data');
});

test('every manual post outside the horizon consumes capacity', () => {
  const result = plan([job(1)], [{ scheduledAt: '2027-01-01T00:00:00Z' }], 1);
  assert.deepEqual(result.assignments, [], 'Out-of-horizon posts must exhaust the common limit');
  assert.equal(result.availableCapacity, 0, 'Capacity must count the full snapshot');
  assert.equal(result.remainingReadyCount, 1, 'Unassigned jobs must remain ready');
});

test('two posts in one minute consume two capacity units', () => {
  const result = plan([job(1), job(2)], [{ scheduledAt: '2026-11-10T06:00:01Z' }, { scheduledAt: '2026-11-10T06:00:59Z' }], 3);
  assert.equal(result.assignments.length, 1, 'Occupancy deduplication must not deduplicate post counts');
  assert.equal(result.remainingCapacity, 0, 'Every snapshot post must consume capacity');
});

test('fresh snapshot frees capacity after a confirmed post leaves the scheduler', () => {
  const queue = [job(1, { status: 'scheduled', scheduled_at: '2026-11-10T06:00:00Z' }), job(2)];
  assert.equal(plan(queue, [{ scheduledAt: '2026-11-10T06:00:00Z' }], 1).assignments.length, 0, 'Current scheduled post must consume capacity');
  const afterPublication = new PublicationPlanner(schedule, 1).plan({ queue, snapshot: { channelUrl, posts: [] }, channelUrl, now: new Date('2026-11-10T06:01:00Z') });
  assert.deepEqual(afterPublication.assignments, [{ jobId: 2, scheduledAt: '2026-11-10T12:00:00.000Z' }], 'Local completed history must not reserve snapshot capacity or time');
});

test('confirmed own posts are counted once through the actual snapshot', () => {
  const result = plan([job(1, { status: 'scheduled', scheduled_at: '2026-11-10T06:00:00Z' }), job(2)], [{ scheduledAt: '2026-11-10T06:00:00Z' }], 2);
  assert.equal(result.assignments.length, 1, 'Completed queue entries must not count twice');
  assert.equal(result.reservationCount, 0, 'Only unfinished jobs must reserve extra capacity');
});

for (const status of ['preparing', 'submitting', 'uncertain']) {
  test(`${status} reserves its minute and capacity without being reassigned`, () => {
    const result = plan([job(1, { status, scheduled_at: '2026-11-10T06:00:45Z' }), job(2), job(3)], [], 2);
    assert.deepEqual(result.assignments, [{ jobId: 2, scheduledAt: '2026-11-10T12:00:00.000Z' }], 'An unfinished job must protect both its minute and a capacity unit');
    assert.equal(result.reservationCount, 1, 'One unfinished job must reserve one capacity unit');
  });
}

test('time coincidence does not prove an uncertain post matches a snapshot post', () => {
  const result = plan([job(1, { status: 'uncertain', scheduled_at: '2026-11-10T06:00:00Z' }), job(2)], [{ scheduledAt: '2026-11-10T06:00:00Z' }], 2);
  assert.deepEqual(result.assignments, [], 'Without image proof possible duplicate counts must remain conservative');
  assert.equal(result.reservationCount, 1, 'Time coincidence must not remove an unknown reservation');
});

test('past uncertainty still reserves capacity after its possible post disappears', () => {
  const result = plan([job(1, { status: 'uncertain', scheduled_at: '2026-11-09T06:00:00Z' }), job(2)], [], 1);
  assert.deepEqual(result.assignments, [], 'Elapsed time must not prove that an unknown send failed');
});

test('documented MAX cap clamps a higher configured limit', () => {
  const result = plan([job(1), job(2)], Array.from({ length: 99 }, () => ({ scheduledAt: '2027-01-01T00:00:00Z' })), 200);
  assert.equal(result.effectiveLimit, 100, 'Configuration must not exceed the documented platform cap');
  assert.equal(result.assignments.length, 1, 'Only remaining platform capacity may be allocated');
});

test('a stricter confirmed platform limit reduces the batch', () => {
  const result = plan([job(1), job(2), job(3)], [], 50, 2);
  assert.equal(result.effectiveLimit, 2, 'A stricter confirmed platform limit must win');
  assert.equal(result.assignments.length, 2, 'Batch size must honor the stricter limit');
});

test('unknown mandatory platform limit blocks planning', () => {
  assert.throws(() => plan([job(1)], [], 10, null), /лимит.*не подтверждён/, 'Unknown platform limits must block assignments');
});

for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid configured limit is rejected: ${String(limit)}`, () => {
    assert.throws(() => plan([job(1)], [], limit), /MAX_SCHEDULED_LIMIT/, 'Invalid capacity must identify its setting');
  });
}

test('empty queue produces no assignments', () => {
  const result = plan([]);
  assert.deepEqual(result.assignments, [], 'Empty queues must not create fake jobs');
  assert.equal(result.readyCount, 0, 'Empty queues must have no ready jobs');
});

test('queue with only unavailable jobs produces no assignments', () => {
  const result = plan([job(1, { status: 'skipped' }), job(2, { status: 'failed' }), job(3, { next_attempt_at: '2026-11-11T00:00:00Z' }),
    job(4, { status: 'uncertain', scheduled_at: '2026-11-10T06:00:00Z' }), job(5, { status: 'scheduled' })]);
  assert.deepEqual(result.assignments, [], 'Unavailable jobs must not be reassigned');
});

test('horizon leaves excess ready jobs for the next cycle', () => {
  const result = plan([job(1), job(2), job(3), job(4)]);
  assert.equal(result.assignments.length, 3, 'Only slots inside the horizon may be assigned');
  assert.equal(result.remainingReadyCount, 1, 'Horizon overflow must remain queued');
  assert.equal(result.horizonExhausted, true, 'Dry run must expose the horizon limitation');
});

test('planner enforces known minimum lead', () => {
  const result = new PublicationPlanner(schedule, 100).plan({ queue: [job(1)], snapshot: { channelUrl, posts: [] }, channelUrl, now, minimumLeadMs: 3_600_001 });
  assert.equal(result.assignments[0]?.scheduledAt, '2026-11-10T12:00:00.000Z', 'Planner must reuse the schedule minimum lead');
});

test('wrong channel snapshot cannot assign jobs', () => {
  assert.throws(() => new PublicationPlanner(schedule, 100).plan({ queue: [job(1)], snapshot: { channelUrl: 'other', posts: [] }, channelUrl, now }), /другому каналу/, 'Foreign snapshots must fail closed');
});

test('invalid snapshot time fails closed', () => {
  assert.throws(() => plan([job(1)], [{ scheduledAt: 'invalid' }]), /время.*не подтверждено/, 'Unverified occupancy must block planning');
});

test('unfinished job without a known time fails closed', () => {
  assert.throws(() => plan([job(1, { status: 'submitting' }), job(2)]), /время.*не подтверждено/, 'Unknown reservation time must not allow a collision');
});

test('invalid clock is rejected even without ready jobs', () => {
  assert.throws(() => new PublicationPlanner(schedule, 100).plan({ queue: [], snapshot: { channelUrl, posts: [] }, channelUrl, now: new Date(NaN) }), /датой/, 'Invalid clock must fail even with an empty queue');
});
