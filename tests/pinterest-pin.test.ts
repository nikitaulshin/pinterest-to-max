import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { imageCandidates, readFirstBoardPin } from '../src/integrations/pinterest/pin.ts';

const signature = 'c6c5d3974290d1bff2e2f72626f49add';
const small = `https://i.pinimg.com/736x/c6/c5/d3/${signature}.jpg`;
const large = `https://i.pinimg.com/1200x/c6/c5/d3/${signature}.jpg`;

test('image candidates preserve observed URLs without inventing originals', () => {
  const actual = imageCandidates([{ src: small, currentSrc: large, srcset: `${small} 736w, ${large} 1200w` }], signature);
  assert.deepEqual(actual, [small, large], 'Only observed image URLs must be returned');
});

test('image from another pin is rejected', () => {
  assert.throws(() => imageCandidates([{ src: 'https://i.pinimg.com/236x/other.jpg', currentSrc: '', srcset: '' }], signature), /Pinterest:/, 'Unrelated images must not become candidates');
});

test('malformed srcset stops extraction', () => {
  assert.throws(() => imageCandidates([{ src: small, currentSrc: '', srcset: `${large} unknown` }], signature), /Pinterest:/, 'Unknown source descriptors must stop extraction');
});

test('changed board structure stops without reading unrelated pin links', async () => {
  const selectors: string[] = [];
  const page = { locator(selector: string) { selectors.push(selector); return { count: async () => 0 }; } } as unknown as Page;
  await assert.rejects(readFirstBoardPin(page), /Pinterest:/, 'Missing board grid must stop extraction');
  assert.deepEqual(selectors, ['[data-test-id="board-feed"] [data-test-id="base-board-pin-grid"] [data-test-id="pin"][data-test-pin-slot-index="0"]'], 'Missing structure must not trigger fallback selectors');
});

test('ambiguous first card stops extraction', async () => {
  const page = { locator() { return { count: async () => 2 }; } } as unknown as Page;
  await assert.rejects(readFirstBoardPin(page), /Pinterest:/, 'Ambiguous cards must stop extraction');
});
