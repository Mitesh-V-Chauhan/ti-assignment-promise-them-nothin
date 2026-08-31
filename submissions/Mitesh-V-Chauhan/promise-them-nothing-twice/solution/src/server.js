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
  console.log(`[${NODE_ID}] Starting RelayAPI rate-limiter service...`);

  // Connect to Redis
  const redisClient = createRedisClient();

  redisClient.on('connect', () => {
    console.log(`[${NODE_ID}] Connected to Redis at ${redisClient.options.host}:${redisClient.options.port}`);
  });

  redisClient.on('error', (err) => {
    console.error(`[${NODE_ID}] Redis error:`, err.message);
  });

  // Create rate limiter (Phase 3 will implement the real logic)
  const rateLimiter = createRateLimiter({ redisClient });

  // Create and start Express app
  const app = createApp({ rateLimiter, nodeId: NODE_ID });

  const server = app.listen(PORT, () => {
    console.log(`[${NODE_ID}] Listening on port ${PORT}`);
    console.log(`[${NODE_ID}] Health: http://localhost:${PORT}/health`);
    console.log(`[${NODE_ID}] API:    http://localhost:${PORT}/api/v1/resource`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`[${NODE_ID}] Received ${signal}, shutting down...`);
    server.close(() => {
      redisClient.disconnect();
      console.log(`[${NODE_ID}] Shut down cleanly.`);
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
