import { setTimeout } from 'node:timers/promises';
import type { Page } from 'playwright';
import { boardPinIdentity, imageCandidates } from './pin.ts';
import { readBoardAccess } from './session.ts';

/** Подтверждённый источник без предположений о пригодности изображения. */
export interface BoardPin {
  id: string;
  url: string;
  signature?: string;
  imageUrls?: string[];
  imageError?: string;
}

/** Незавершённый обход сохраняет уже прочитанные источники и причину остановки. */
export interface BoardTraversal {
  status: 'complete' | 'partial';
  pins: BoardPin[];
  expectedCount: number | null;
  reason: string;
}

/** Обходит всю доску по значениям карточек, не удерживая виртуализируемые DOM-узлы. */
export async function traverseBoard(page: Page, boardUrl: string, options: { timeoutMs?: number; pollMs?: number; onProgress?: (progress: BoardTraversal) => void } = {}): Promise<BoardTraversal> {
  const pins = new Map<string, BoardPin>();
  const slots = new Map<number, string>();
  let expectedCount: number | null = null;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const result = (status: BoardTraversal['status'], reason: string): BoardTraversal => ({ status, pins: [...slots].sort(([left], [right]) => left - right).map(([, id]) => pins.get(id)!), expectedCount, reason });

  try {
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(30_000, Math.max(1, deadline - Date.now())) });
    await page.evaluate(() => scrollTo(0, 0));
    while (Date.now() < deadline) {
      const access = await readBoardAccess(page, boardUrl);
      if (access === 'captcha') return result('partial', 'captcha');
      if (access === 'auth-required') return result('partial', 'auth-required');
      const actual = new URL(page.url());
      const expected = new URL(boardUrl);
      if (actual.origin !== expected.origin || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return result('partial', 'board-changed');
      if (access !== 'ready') {
        if (pins.size > 0) return result('partial', 'structure-changed');
        await setTimeout(Math.min(options.pollMs ?? 500, Math.max(0, deadline - Date.now())));
        continue;
      }

      const snapshot = await page.evaluate(() => {
        const roots = document.querySelectorAll('[data-test-id="board-feed"] [data-test-id="base-board-pin-grid"]');
        const counts = document.querySelectorAll('[data-test-id="board-header"] [data-test-id="board-count-info"] [data-test-id="pin-count"]');
        if (roots.length !== 1 || counts.length !== 1) return null;
        const root = roots[0]!;
        const masonry = [...root.querySelectorAll('[data-test-id="masonry-container"]')].filter((element) => !element.closest('[data-test-id="more-ideas-feed"]'));
        if (masonry.length !== 1) return null;
        const grid = masonry[0]!;

        return {
          count: counts[0]!.textContent,
          busy: grid.getAttribute('aria-busy'),
          end: root.querySelectorAll('[data-test-id="more-ideas-feed"]').length === 1,
          cards: [...grid.querySelectorAll('[data-test-id="pin"]')].filter((element) => !element.closest('[data-test-id="more-ideas-feed"]')).map((element) => {
            const links = element.querySelectorAll<HTMLAnchorElement>('[data-test-id="pinWrapper"] > a[href]');

            const images = element.querySelectorAll<HTMLImageElement>('[data-test-image-signature] [data-test-id="non-story-pin-image"] img');
            const signature = element.querySelector('[data-test-image-signature]')?.getAttribute('data-test-image-signature');
            const image = images.length === 1 ? images[0] : undefined;

            return { signature, source: image ? { src: image.src, currentSrc: image.currentSrc, srcset: image.srcset } : null, id: element.getAttribute('data-test-pin-id'), dragId: element.getAttribute('data-pin-drag-id'), slot: element.getAttribute('data-test-pin-slot-index'), url: links.length === 1 ? links[0]!.href : '' };
          }),
        };
      });
      if (!snapshot) {
        if (pins.size > 0) return result('partial', 'structure-changed');
      } else {
        const count = /^([\d\s\u00a0]+)\s+пин(?:ов|а)?$/.exec(snapshot.count?.trim() ?? '');
        if (!count) return result('partial', 'unknown-count');
        const total = Number(count[1]!.replace(/\s/g, ''));
        if (!Number.isSafeInteger(total) || total < 1) return result('partial', 'unknown-count');
        if (expectedCount !== null && expectedCount !== total) return result('partial', 'count-changed');
        expectedCount = total;

        for (const card of snapshot.cards) {
          const pin = boardPinIdentity(card, page.url());
          if (!/^(0|[1-9]\d*)$/.test(card.slot ?? '')) return result('partial', 'unknown-slot');
          const slot = Number(card.slot);
          if (slot >= total || (slots.has(slot) && slots.get(slot) !== pin.id)
            || (pins.has(pin.id) && slots.get(slot) !== pin.id)) return result('partial', 'membership-changed');
          slots.set(slot, pin.id);
          const observed: BoardPin = { ...pin };
          try {
            if (!card.signature || !card.source) throw new Error('Pinterest: неподдерживаемый материал или изображение карточки не подтверждено.');
            observed.signature = card.signature;
            observed.imageUrls = imageCandidates([card.source], card.signature);
          } catch (error) {
            observed.imageError = error instanceof Error ? error.message : 'Pinterest: изображение не подтверждено.';
          }
          const previous = pins.get(pin.id);
          if (previous?.imageUrls && observed.imageUrls) observed.imageUrls = [...new Set([...previous.imageUrls, ...observed.imageUrls])];
          pins.set(pin.id, previous?.imageUrls && observed.imageError ? previous : observed);
        }

        options.onProgress?.(result('partial', 'in-progress'));

        if (snapshot.end && snapshot.busy === 'false' && slots.size === total && pins.size === total) return result('complete', 'count-and-end-confirmed');
        // Не перескакиваем начальную загрузку; одинаковые экраны не доказывают конец.
        if (pins.size > 0) await page.evaluate(() => scrollBy(0, Math.floor(innerHeight * 0.6)));
      }

      await setTimeout(Math.min(options.pollMs ?? 500, Math.max(0, deadline - Date.now())));
    }

    return result('partial', 'timeout');
  } catch (error) {
    return result('partial', error instanceof Error && error.message.startsWith('Pinterest:') ? 'structure-changed' : 'browser-error');
  }
}
