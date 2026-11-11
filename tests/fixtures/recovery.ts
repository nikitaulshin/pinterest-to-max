import { registerHooks } from 'node:module';
import { chromium } from 'playwright';

// Подменяет внешние интеграции CLI; очередь, планировщик, ownership и сигналы остаются настоящими.
registerHooks({
  load(url, context, nextLoad) {
    const replacement = (source: string) => ({ format: 'module', shortCircuit: true, source });
    if (url.endsWith('/dist/integrations/pinterest/sync.js')) return replacement(`
      export async function syncPinterest(config, command, storage, signal) {
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      }
    `);
    if (url.endsWith('/dist/integrations/max/session.js')) return replacement('export async function openMaxChannel() {} export async function authenticateMax() {}');
    if (url.endsWith('/dist/integrations/max/scheduled.js')) return replacement(`
      export async function assertMaxAccess() {}
      export async function readScheduledPosts(page, channelUrl) { return { channelUrl, posts: [] }; }
    `);
    if (url.endsWith('/dist/integrations/max/reconcile.js')) return replacement(`
      import { appendFileSync } from 'node:fs';
      export async function reconcileMaxPost({ storage, jobId, channelUrl, dataDirectory }) {
        storage.maxReconciliation(jobId, channelUrl);
        appendFileSync(process.env.DATA_DIR + '/recovery-audit', 'reconcile\\n');
        return { status: 'uncertain', reason: 'Controlled missing external proof' };
      }
    `);
    if (url.endsWith('/dist/integrations/max/submit.js')) return replacement(`
      import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
      export async function submitMaxPost({ storage, jobId, channelUrl, scheduledAt, signal }) {
        const root = process.env.DATA_DIR;
        const audit = value => appendFileSync(root + '/recovery-audit', value + '\\n');
        const image = storage.prepareMax(jobId, channelUrl, scheduledAt);
        audit('prepare:' + jobId + ':' + scheduledAt);
        let attempt;
        const scenario = process.env.RECOVERY_SCENARIO;
        const pause = async () => {
          audit('pending');
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          storage.finishMax(jobId, attempt ? 'uncertain' : 'ready', 'Controlled interrupted operation', attempt);
          return { status: attempt ? 'uncertain' : 'ready', reason: 'Controlled interruption' };
        };
        if (scenario === 'before-intent') return pause();
        attempt = storage.beginMaxAttempt(jobId, channelUrl, image.sha256, scheduledAt);
        const path = root + '/external-count';
        writeFileSync(path, String((existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0) + 1));
        audit('create:' + jobId);
        if (scenario === 'after-create') return pause();
        storage.finishMax(jobId, 'scheduled', null, attempt, 'Controlled positive external proof');
        audit('scheduled:' + jobId);
        if (scenario === 'after-success') {
          audit('pending');
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        }
        return { status: 'scheduled', reason: null };
      }
    `);
    return nextLoad(url, context);
  },
});
chromium.launchPersistentContext = async () => {
  const keepAlive = setInterval(() => {}, 1000);
  const page = { url: () => 'https://web.max.ru/-123', goto: async () => {}, reload: async () => {},
    getByRole: () => ({ waitFor: async () => {} }), close: async () => {}, context: () => context };
  const context = { pages: () => [page], newPage: async () => page, close: async () => { clearInterval(keepAlive); } };
  return context as unknown as Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
};
