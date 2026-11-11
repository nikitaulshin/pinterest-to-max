import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { BoardPin } from './board.ts';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { extractPin, imageCandidates } from './pin.ts';

/** Файл готов только после проверки всех наблюдённых вариантов и атомарного сохранения. */
export interface PreparedImage {
  status: 'ready';
  id: string;
  url: string;
  imageUrl: string;
  path: string;
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  variants: { url: string; width: number; height: number }[];
}

/** Отказ сохраняет источник и причину, не выдавая частичный файл за готовый. */
export interface ImageFailure {
  status: 'failed';
  id: string;
  url: string;
  imageUrl: string | null;
  reason: string;
  code?: string;
}

/** Проверяет контейнер, чтобы терпимый декодер не принимал оборванное изображение. */
function imageFormat(bytes: Buffer, mime: string): string {
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) return 'jpg';
  if (mime === 'image/png' && bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) return 'png';
  if (mime === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';

  throw new Error('Pinterest: неподдерживаемый формат или нарушена целостность изображения.');
}

/** Скачивает только наблюдённые CDN-адреса; перенаправления не разрешаются. */
export async function downloadPinImage(page: Page, pin: { id: string; url: string; signature: string; imageUrls: string[] }, dataDirectory: string): Promise<PreparedImage | ImageFailure> {
  let imageUrl: string | null = null;
  let temporary: string | undefined;
  try {
    const urls = imageCandidates(pin.imageUrls.map((src) => ({ src, currentSrc: '', srcset: '' })), pin.signature);
    const variants: PreparedImage['variants'] = [];
    let best: { url: string; bytes: Buffer; mime: string; extension: string; width: number; height: number } | undefined;
    for (const url of urls) {
      imageUrl = url;
      const response = await page.context().request.get(url, { maxRedirects: 0, timeout: 30_000 });
      try {
        if ([408, 429, 500, 502, 503, 504].includes(response.status())) throw new IntegrationFailure('network', `Pinterest: временный отказ CDN HTTP ${response.status()}.`);
        if (response.status() !== 200 || response.url() !== url) throw new Error('Pinterest: CDN вернул отказ или перенаправление.');
        const headers = response.headers();
        const mime = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const bytes = await response.body();
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== bytes.length)) throw new Error('Pinterest: изображение скачано не полностью.');
        const extension = imageFormat(bytes, mime);
        const dimensions = await page.evaluate(async ({ encoded, mime }) => {
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();

          return size;
        }, { encoded: bytes.toString('base64'), mime });
        if (dimensions.width < 1 || dimensions.height < 1) throw new Error('Pinterest: изображение не декодируется.');
        variants.push({ url, ...dimensions });
        if (!best || dimensions.width * dimensions.height > best.width * best.height) best = { url, bytes, mime, extension, ...dimensions };
      } finally {
        await response.dispose();
      }
    }
    if (!best) throw new Error('Pinterest: изображение не подтверждено.');
    imageUrl = best.url;

    const directory = join(dataDirectory, 'images');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sha256 = createHash('sha256').update(best.bytes).digest('hex');
    const path = join(directory, `${sha256}.${best.extension}`);
    temporary = join(directory, `${randomUUID()}.part`);
    await writeFile(temporary, best.bytes, { mode: 0o600, flag: 'wx' });
    const saved = await readFile(temporary);
    if (createHash('sha256').update(saved).digest('hex') !== sha256) throw new Error('Pinterest: целостность сохранённого файла не подтверждена.');
    await rename(temporary, path);

    return { status: 'ready', id: pin.id, url: pin.url, imageUrl, path, sha256, mime: best.mime, bytes: best.bytes.length, width: best.width, height: best.height, variants };
  } catch (error) {
    return { status: 'failed', code: integrationFailure(error).code, id: pin.id, url: pin.url, imageUrl, reason: integrationFailure(error).code === 'network' ? integrationFailure(error).message : error instanceof Error && error.message.startsWith('Pinterest:') ? error.message : 'Pinterest: загрузка, декодирование или сохранение изображения не завершены.' };
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => { /* Ошибка уборки не скрывает исходный отказ; .part не считается готовым. */ });
  }
}

/** Готовит произвольный источник обхода; ошибка одного материала остаётся отдельным результатом. */
export async function preparePinImage(page: Page, pin: BoardPin, boardUrl: string, dataDirectory: string): Promise<PreparedImage | ImageFailure> {
  try {
    return await downloadPinImage(page, await extractPin(page, pin, boardUrl), dataDirectory);
  } catch (error) {
    return { status: 'failed', code: integrationFailure(error).code, id: pin.id, url: pin.url, imageUrl: null, reason: integrationFailure(error).code === 'network' ? integrationFailure(error).message : error instanceof Error && error.message.startsWith('Pinterest:') ? error.message : 'Pinterest: представление пина не подтверждено.' };
  }
}
