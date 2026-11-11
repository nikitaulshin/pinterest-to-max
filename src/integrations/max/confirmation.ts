import { request, type Page } from 'playwright';
import type { ScheduledPost } from './scheduled.ts';

type ImageProof = { decodedPixels: string; width: number; height: number; cells: number[]; opaque: boolean };

/** Проверяет декодированные пиксели, не выдавая URL или хеш перекодированного файла за идентичность. */
export async function pixels(page: Page, url: string): Promise<ImageProof> {
  const decode = (url: string) => page.evaluate(async (source) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = source;
    await Promise.race([image.decode(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Image decoding timed out')), 5_000))]);
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > 40_000_000) throw new Error('Image dimensions cannot be verified');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas decoding unavailable');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    const digest = await crypto.subtle.digest('SHA-256', data);

    const cells = new Array<number>(32 * 32 * 3).fill(0);
    const counts = new Array<number>(32 * 32).fill(0);
    let opaque = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = Math.floor(y * 32 / height) * 32 + Math.floor(x * 32 / width);
        counts[cell]!++;
        const offset = (y * width + x) * 4;
        opaque &&= data[offset + 3] === 255;
        for (let channel = 0; channel < 3; channel++) cells[cell * 3 + channel]! += data[offset + channel]!;
      }
    }

    return { decodedPixels: `${width}x${height}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      width, height, opaque, cells: cells.map((sum, index) => sum / (counts[Math.floor(index / 3)] || 1)) };
  }, url);

  try {
    return await decode(url);
  } catch {
    // Загружаем только наблюдённый адрес фото: CDN не всегда разрешает canvas CORS.
    let source: URL;
    try { source = new URL(url); } catch { throw new Error('MAX: адрес изображения не подтверждён.'); }
    if (source.protocol !== 'https:' || source.hostname !== 'i.oneme.ru' || source.username || source.password || source.port) {
      throw new Error('MAX: пиксели изображения нельзя достоверно проверить: декодирование, CORS или canvas недоступны.');
    }
    const client = await request.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const response = await client.get(source.href, { maxRedirects: 0, timeout: 10_000 });
      const mime = response.headers()['content-type']?.split(';')[0]?.trim();
      const length = Number(response.headers()['content-length']);
      if (response.status() !== 200 || !mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)
        || !Number.isSafeInteger(length) || length < 1 || length > 20_000_000) throw new Error('Image response cannot be verified');
      const bytes = await response.body();
      if (bytes.length !== length) throw new Error('Image response size cannot be verified');

      return await decode(`data:${mime};base64,${bytes.toString('base64')}`);
    } catch {
      throw new Error('MAX: наблюдённое фото CDN нельзя достоверно загрузить и декодировать.');
    } finally { await client.dispose(); }
  }
}

// shortcut: усреднение не различает тонкие изменения внутри ячейки; пограничные фото требуют ручного разбора.
function visualMatch(expected: ImageProof, candidate: ImageProof) {
  const differences = expected.cells.map((value, index) => Math.abs(value - candidate.cells[index]!));
  const mae = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const rmse = Math.sqrt(differences.reduce((sum, value) => sum + value * value, 0) / differences.length);
  const maxCell = Math.max(...differences);
  const aspectError = Math.abs((expected.width / expected.height) / (candidate.width / candidate.height) - 1);
  const contrast = (proof: ImageProof) => {
    const luminance = Array.from({ length: 1024 }, (_, index) => proof.cells[index * 3]! * 0.2126 + proof.cells[index * 3 + 1]! * 0.7152 + proof.cells[index * 3 + 2]! * 0.0722);
    const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;

    return Math.sqrt(luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminance.length);
  };
  const luminanceStd = Math.min(contrast(expected), contrast(candidate));
  const matches = expected.opaque && candidate.opaque && Math.min(expected.width, expected.height, candidate.width, candidate.height) >= 32
    && aspectError <= 0.002 && mae <= 2 && rmse <= 3 && maxCell <= 8 && luminanceStd >= 10;

  return { algorithm: 'area-rgb-32-v1', aspectError, mae, rmse, maxCell, luminanceStd, matches };
}

async function verifyImage(page: Page, post: ScheduledPost, index: number, expected: ImageProof): Promise<{ method: string; metrics?: ReturnType<typeof visualMatch> }> {
  if (post.imageUrls.length !== 1) throw new Error('MAX: у совпадения отсутствует единственное фото.');
  try {
    const candidate = await pixels(page, post.imageUrls[0]!);
    if (candidate.decodedPixels === expected.decodedPixels) return { method: 'scheduled-image-decoded-rgba' };
    const metrics = visualMatch(expected, candidate);
    if (metrics.matches) return { method: 'scheduled-image-area-rgb-v1', metrics };
  } catch { /* Миниатюра может быть недоступна для canvas; проверяем наблюдаемый viewer. */ }

  // shortcut: проверяем один видимый оригинал viewer, неизвестную структуру оставляем для ручного разбора.
  const item = page.locator('div.delayedChat').getByRole('listitem').nth(index);
  await item.locator('img').click({ timeout: 5_000 });
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  await close.waitFor({ state: 'visible', timeout: 5_000 });
  try {
    const download = page.getByRole('button', { name: 'Скачать', exact: true });
    if (await download.count() !== 1 || !await download.isVisible()) throw new Error('MAX: структура оригинала viewer не подтверждена.');
    const sources = await close.evaluate((button, download) => {
      let root = button.parentElement;
      while (root && root !== document.body && root !== document.documentElement) {
        if (download && root.contains(download) && root.querySelector('img')) {
          if (root.querySelector('div.delayedChat, [data-testid="composer"]')) break;

          return [...root.querySelectorAll('img')].filter((image) => image.getClientRects().length > 0)
            .map((image) => image.currentSrc || image.src);
        }
        root = root.parentElement;
      }
      throw new Error('Viewer root cannot be verified');
    }, await download.elementHandle());
    if (sources.length !== 1) throw new Error('MAX: единственное изображение viewer не подтверждено.');
    const candidate = await pixels(page, sources[0]!);
    if (candidate.decodedPixels === expected.decodedPixels) return { method: 'viewer-image-decoded-rgba' };
    const metrics = visualMatch(expected, candidate);
    if (!metrics.matches) throw new Error('MAX: изображение оригинала не соответствует локальному файлу.');

    return { method: 'viewer-image-area-rgb-v1', metrics };
  } finally { await close.click({ timeout: 5_000 }); }
}

/** Подтверждает единственный будущий пост по каналу, точной минуте и декодированному фото. */
export async function confirmMaxPost(page: Page, result: { channelUrl: string; posts: ScheduledPost[] }, intended: {
  channelUrl: string; scheduledAt: string; sha256: string;
}, expected: ImageProof): Promise<string> {
  const instant = Date.parse(intended.scheduledAt);
  if (!Number.isFinite(instant) || instant <= Date.now()) throw new Error('MAX: время прошло до подтверждения, требуется ручной разбор.');
  if (result.channelUrl !== intended.channelUrl) throw new Error('MAX: канал совпадения не подтверждён.');
  const matches = result.posts.map((post, index) => ({ post, index })).filter(({ post }) => post.scheduledAt === intended.scheduledAt);
  if (matches.length !== 1) throw new Error('MAX: нет единственного совпадения запрошенного времени.');
  const match = matches[0]!;
  if (match.post.hasText) throw new Error('MAX: совпадение содержит текст, требуется ручной разбор.');
  const confirmation = await verifyImage(page, match.post, match.index, expected);
  if (instant <= Date.now()) throw new Error('MAX: время прошло до сохранения подтверждения.');

  return JSON.stringify({ channelUrl: result.channelUrl, scheduledAt: intended.scheduledAt, imageSha256: intended.sha256, decodedPixels: expected.decodedPixels, ...confirmation, matches: 1, confirmedAt: new Date().toISOString() });
}
