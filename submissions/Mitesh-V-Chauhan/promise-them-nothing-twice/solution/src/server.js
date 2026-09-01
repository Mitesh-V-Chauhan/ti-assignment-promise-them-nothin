'use strict';

/**
 * server.js — Entry point for the RelayAPI rate-limiter service.
 *
 * Starts an Express HTTP server connected to Redis.
 * Designed to run as multiple independent instances behind a load balancer.
 *
 * Environment variables:
 *   PORT       — HTTP port (default: 3000)
 *   NODE_ID    — Identifier for this node (default: node-{PORT})
 *   REDIS_HOST — Redis hostname (default: 127.0.0.1)
 *   REDIS_PORT — Redis port (default: 6379)
 */

const { createApp } = require('./app');
const { createRedisClient } = require('./redis-client');
const { createRateLimiter } = require('./rate-limiter');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;

async function main() {
  console.log('[%s] Starting RelayAPI rate-limiter service...', NODE_ID);

  // Connect to Redis
  const redisClient = createRedisClient();

  redisClient.on('connect', () => {
    console.log('[%s] Connected to Redis at %s:%s', NODE_ID, redisClient.options.host, redisClient.options.port);
  });

  redisClient.on('error', (err) => {
    console.error('[%s] Redis error:', NODE_ID, err.message);
  });

  // Create rate limiter (Phase 3 will implement the real logic)
  const rateLimiter = createRateLimiter({ redisClient });

  // Create and start Express app
  const app = createApp({ rateLimiter, nodeId: NODE_ID });

  const server = app.listen(PORT, () => {
    console.log('[%s] Listening on port %s', NODE_ID, PORT);
    console.log('[%s] Health: http://localhost:%s/health', NODE_ID, PORT);
    console.log('[%s] API:    http://localhost:%s/api/v1/resource', NODE_ID, PORT);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log('[%s] Received %s, shutting down...', NODE_ID, signal);
    server.close(() => {
      redisClient.disconnect();
      console.log('[%s] Shut down cleanly.', NODE_ID);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
