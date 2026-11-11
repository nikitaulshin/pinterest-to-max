import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const audit = (event: string) => appendFileSync(join(process.env.DATA_DIR!, 'run-audit'), `${event}\n`);
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/dist/integrations/pinterest/sync.ts') || url.endsWith('/dist/integrations/pinterest/sync.js')) return {
      format: 'module', shortCircuit: true, source: `
        export async function syncPinterest(config, command, storage, signal) {
          const { appendFileSync } = await import('node:fs');
          const audit = event => appendFileSync(config.dataDirectory + '/run-audit', event + '\\n');
          audit('import');
          if (process.env.RUN_SCENARIO === 'pinterest-error') throw new Error('Controlled Pinterest failure');
          if (process.env.RUN_SCENARIO === 'pinterest-empty') return { status: 'complete' };
          if (process.env.RUN_SCENARIO?.startsWith('pinterest-pause-')) return { status: 'incomplete', browserStop: process.env.RUN_SCENARIO.slice('pinterest-pause-'.length), diagnostics: '/private/diagnostics/pinterest' };
          if (process.env.RUN_SCENARIO === 'pinterest-hang') {
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            return;
          }
          const id = String(Date.now());
          storage.sources([{ id, url: 'https://ru.pinterest.com/pin/' + id + '/' }]);
          storage.image({ status: 'ready', id, imageUrl: 'https://i.pinimg.com/a.png', path: config.dataDirectory + '/images/a.png', sha256: id.padEnd(64, '0'), mime: 'image/png', bytes: 1, width: 1, height: 1 });
          return { status: 'complete' };
        }`,
    };
    if (url.endsWith('/dist/integrations/max/batch.js')) return {
      format: 'module', shortCircuit: true, source: `
        export async function scheduleMaxBatch({ storage, dataDirectory }) {
          const { appendFileSync } = await import('node:fs');
          appendFileSync(dataDirectory + '/run-audit', 'batch\\n');
          if (process.env.RUN_SCENARIO === 'max-network') throw new Error('net::ERR_CONNECTION_RESET https://cdn.test/image?token=secret');
          if (process.env.RUN_SCENARIO === 'max-error') throw new Error('Controlled MAX failure');
          return { results: [] };
        }`,
    };
    if (url.endsWith('/dist/integrations/max/session.js')) return { format: 'module', shortCircuit: true, source: 'export async function openMaxChannel() {} export async function authenticateMax() {} export async function readChannelAccess() { return true; }' };
    return nextLoad(url, context);
  },
});
chromium.launchPersistentContext = async (directory, options) => {
  if (!String(directory).endsWith('/profiles/max') || options?.timezoneId !== 'Europe/Moscow' || options.handleSIGINT !== false || options.handleSIGTERM !== false) throw new Error('Worker must control its separate Moscow MAX context');
  audit('max-open');
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  const page = { locator: () => ({ count: async () => process.env.RUN_SCENARIO === 'max-captcha' ? 1 : 0 }), getByRole: (_role: string, options: { name: string | RegExp }) => ({ isVisible: async () => options.name === 'Войти по номеру телефона' && process.env.RUN_SCENARIO === 'max-auth', waitFor: async () => {
    if (process.env.RUN_SCENARIO === 'max-hang') await closed;
  } }) };
  return { pages: () => [page], close: async () => { audit('max-close'); close(); } } as unknown as Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
};
