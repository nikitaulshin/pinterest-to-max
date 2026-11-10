import { setTimeout } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { BoardPin } from './board.ts';
import { readBoardAccess } from './session.ts';

const structureError = 'Pinterest: структура пина или его принадлежность доске не подтверждены. Операция остановлена.';

/** Адреса одного изображения, прочитанные из DOM, без конструирования вариантов. */
export interface ImageSources {
  src: string;
  currentSrc: string;
  srcset: string;
}

/** Проверяет наблюдённые адреса одного изображения; рекомендации и чужие CDN не принимаются. */
export function imageCandidates(sources: ImageSources[], signature: string): string[] {
  if (!/^[a-f0-9]{32}$/.test(signature)) throw new Error(structureError);

  const candidates = new Set<string>();
  for (const source of sources) {
    const urls = [source.src, source.currentSrc];
    for (const entry of source.srcset.split(',').filter((entry) => entry.trim())) {
      const match = /^(https:\/\/\S+)\s+(\d+(?:\.\d+)?[wx])$/.exec(entry.trim());
      if (!match || Number.parseFloat(match[2]!) <= 0) throw new Error(structureError);
      urls.push(match[1]!);
    }
    for (const value of urls.filter(Boolean)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(structureError);
      }
      if (url.protocol !== 'https:' || url.hostname !== 'i.pinimg.com' || url.port
        || url.username || url.password || url.search || url.hash
        || !new RegExp(`/${signature}\\.[a-zA-Z0-9]+$`).test(url.pathname)) {
        throw new Error(structureError);
      }
      candidates.add(value);
    }
  }
  if (candidates.size === 0) throw new Error(structureError);

  return [...candidates];
}

/** Проверяет идентичность карточки; пригодность её материала проверяется отдельно. */
export function boardPinIdentity(card: { id: string | null; dragId: string | null; url: string } | null, pageUrl: string) {
  if (!card?.id || !/^\d+$/.test(card.id) || card.dragId !== card.id) throw new Error(structureError);

  const url = new URL(card.url);
  if (url.origin !== new URL(pageUrl).origin || url.pathname !== `/pin/${card.id}/` || url.search || url.hash) throw new Error(structureError);

  return { id: card.id, url: card.url };
}

/** Читает только первую карточку подтверждённой сетки доски; неизвестная разметка останавливает чтение. */
export async function readFirstBoardPin(page: Page) {
  const cards = page.locator('[data-test-id="board-feed"] [data-test-id="base-board-pin-grid"] [data-test-id="pin"][data-test-pin-slot-index="0"]');
  if (await cards.count() !== 1) throw new Error(structureError);

  const card = await cards.evaluate((element) => {
    const links = element.querySelectorAll<HTMLAnchorElement>('[data-test-id="pinWrapper"] > a[href]');
    const images = element.querySelectorAll<HTMLImageElement>('[data-test-image-signature] [data-test-id="non-story-pin-image"] img');
    const signature = element.querySelector('[data-test-image-signature]')?.getAttribute('data-test-image-signature');
    if (links.length !== 1 || images.length !== 1) return null;
    const image = images[0]!;

    return {
      id: element.getAttribute('data-test-pin-id'), dragId: element.getAttribute('data-pin-drag-id'),
      url: links[0]!.href, signature,
      source: { src: image.src, currentSrc: image.currentSrc, srcset: image.srcset },
    };
  });
  const identity = boardPinIdentity(card, page.url());
  if (!card?.signature) throw new Error(structureError);

  return { ...identity, signature: card.signature, imageUrls: imageCandidates([card.source], card.signature) };
}

/** Извлекает один пин с доски и его подтверждённые варианты, не обходит доску и не скачивает файл. */
export async function extractOnePin(page: Page, boardUrl: string) {
  await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const access = await readBoardAccess(page, boardUrl);
    if (access === 'captcha') throw new Error('Pinterest: CAPTCHA или блокировка. Восстановите доступ вручную.');
    if (access === 'auth-required') throw new Error('Pinterest: требуется ручной вход через auth pinterest.');
    if (access === 'ready') break;
    if (Date.now() >= deadline) throw new Error(structureError);
    await setTimeout(250);
  }

  return extractPin(page, await readFirstBoardPin(page), boardUrl);
}

/** Открывает уже подтверждённый источник без повторного обхода доски. */
export async function extractPin(page: Page, pin: BoardPin, boardUrl: string) {
  if (pin.imageError) throw new Error(pin.imageError);
  if (!pin.signature || !pin.imageUrls?.length) throw new Error('Pinterest: неподдерживаемый материал или изображение карточки не подтверждено.');
  boardPinIdentity({ ...pin, dragId: pin.id }, boardUrl);
  imageCandidates(pin.imageUrls.map((src) => ({ src, currentSrc: '', srcset: '' })), pin.signature);

  await page.goto(pin.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const access = await readBoardAccess(page, boardUrl);
  if (access === 'captcha') throw new Error('Pinterest: CAPTCHA или блокировка. Восстановите доступ вручную.');
  if (access === 'auth-required') throw new Error('Pinterest: требуется ручной вход через auth pinterest.');

  const image = page.locator(`[data-test-id="closeup-image"][data-pin-drag-id="${pin.id}"] [data-test-id="closeup-image-main"] img, [data-test-id="closeup-body-image-container"] [data-test-id="story-pin-page-drag-surface"][data-pin-drag-id="${pin.id}"] [data-test-id="story-pin-image-block"] img`);
  await image.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => { throw new Error(structureError); });
  if (page.url() !== pin.url || await image.count() !== 1) throw new Error(structureError);
  const source = await image.evaluate((element: HTMLImageElement) => ({ src: element.src, currentSrc: element.currentSrc, srcset: element.srcset }));

  return { id: pin.id, url: pin.url, signature: pin.signature, imageUrls: [...new Set([...pin.imageUrls, ...imageCandidates([source], pin.signature)])] };
}
