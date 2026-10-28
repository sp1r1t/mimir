import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { buildServer } from './web/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel, config.logPretty);
  const app = createApp(config, log);
  const server = buildServer(app);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      await server.close();
      await app.stop();
      app.db.close();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));

  await server.listen({ host: config.host, port: config.port });
  app.start();
  log.info(
    {
      url: `http://${config.host}:${config.port}`,
      db: config.dbPath,
      classifier: app.classifier.isConfigured() ? 'configured' : 'not configured',
      summaries: app.summaries.isConfigured() ? `${app.summaries.name} ${app.summaries.model}` : 'not configured',
    },
    'mimir started',
  );
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
