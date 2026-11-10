import { chromium } from 'playwright';

// Запрещает браузерную границу в конкурирующей команде: отказ должен произойти раньше.
chromium.launchPersistentContext = async () => {
  if (process.env.OWNERSHIP_WAIT === '1') {
    console.log(JSON.stringify({ event: 'browser-starting' }));
    setInterval(() => {}, 2_147_483_647);
    return await new Promise<never>(() => {});
  }

  throw new Error('Browser must not launch before storage ownership');
};
