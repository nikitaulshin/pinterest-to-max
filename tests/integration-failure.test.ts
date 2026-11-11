import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetryDelay } from '../src/core/retry.ts';
import { IntegrationFailure, integrationFailure } from '../src/integrations/failure.ts';

test('network retry delays grow and stop after five retries', () => {
  const retry = new RetryDelay(20);
  assert.deepEqual(Array.from({ length: 6 }, () => retry.next()), [5000, 10000, 20000, 40000, 80000, null], 'Retries must grow, avoid fast spinning and stop at a finite bound');
});
test('successful operation resets the network failure series', () => {
  const retry = new RetryDelay(20);
  retry.next(); retry.next(); retry.success();
  assert.equal(retry.next(), 5000, 'Success must restore the initial retry delay');
});
test('network retry delay never shortens the configured period', () => {
  const retry = new RetryDelay(900000);
  assert.equal(retry.next(), 900000, 'Configured intervals above the backoff cap must remain intact');
});
test('network retry delay respects the Node timer limit', () => {
  const retry = new RetryDelay(2147483647);
  assert.equal(retry.next(), 2147483647, 'The maximum accepted interval must not overflow');
});
test('network retry delay is capped for growing failures', () => {
  const retry = new RetryDelay(200000);
  assert.deepEqual([retry.next(), retry.next(), retry.next()], [200000, 400000, 800000], 'Exponential delay must have a finite cap');
});
test('nested network causes retain only the safe network code', () => {
  const error = integrationFailure(new Error('MAX: wrapper', { cause: new Error('page.goto: net::ERR_CONNECTION_RESET https://cdn.test/a?token=secret') }));
  assert.equal(error.code, 'network', 'Known network failures must survive wrappers');
  assert.match(error.message, /ERR_CONNECTION_RESET/, 'Safe cause code must be retained');
  assert.doesNotMatch(error.message, /secret|cdn.test/, 'Raw request URLs must not enter public reasons');
});
test('DOM timeouts do not qualify for network retry', () => {
  assert.equal(integrationFailure(new Error('locator.click: Timeout 5000ms exceeded')).code, 'unknown', 'Missing UI elements must fail closed');
});
test('file failures do not qualify for network retry', () => {
  assert.equal(integrationFailure(new Error('ENOENT: missing image')).code, 'unknown', 'Local data errors must not be treated as temporary network failures');
});
test('known session failures survive diagnostic wrappers', () => {
  const failure = new IntegrationFailure('auth-required', 'MAX: требуется auth max.', '/private/diagnostics');
  assert.equal(integrationFailure(new Error('wrapper', { cause: failure })), failure, 'Session code, cause and diagnostics must survive wrappers');
});

test('the default five-minute period still has increasing retry delays', () => {
  const retry = new RetryDelay(300000);
  assert.deepEqual([retry.next(), retry.next(), retry.next()], [300000, 600000, 1200000], 'Default periods must not flatten the exponential retry delay');
});
