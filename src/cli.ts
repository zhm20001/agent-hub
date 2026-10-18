#!/usr/bin/env node
import { startServer } from './server.ts';

try {
  const runtime = await startServer();
  const shutdown = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    void runtime.close().catch(error => {
      console.error('[Agent Hub] Shutdown failed:', error);
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`[Agent Hub] http://${runtime.address.address}:${runtime.address.port}`);
} catch (error) {
  console.error('[Agent Hub] Startup failed:', error);
  process.exitCode = 1;
}
