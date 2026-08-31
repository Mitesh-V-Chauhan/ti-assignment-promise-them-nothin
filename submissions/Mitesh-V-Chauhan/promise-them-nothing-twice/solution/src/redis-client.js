'use strict';

/**
 * redis-client.js — Redis connection module for RelayAPI.
 *
 * Design decisions:
 * - Single reusable Redis client module (not scattered through the app)
 * - The rate limiter receives the Redis client, not the connection details
 * - Connection failure is surfaced cleanly (not swallowed)
 * - The eventual rate limiter will use this client to execute Lua scripts atomically
 *
 * IMPORTANT ARCHITECTURAL NOTE:
 * The rate limiter must NOT implement:
 *     GET from Redis → decide in Node.js → INCR in Redis
 * That pattern reintroduces the race condition we designed away in Phase 1.
 * All rate-limit logic (GET + compare + conditional INCR + EXPIRE) MUST happen
 * inside a single atomic Redis Lua script.
 */

const Redis = require('ioredis');

/**
 * Create a Redis client connected to the specified host/port.
 *
 * @param {object} [options]
 * @param {string} [options.host='127.0.0.1']
 * @param {number} [options.port=6379]
 * @param {boolean} [options.lazyConnect=false] - If true, won't connect until first command
 * @returns {Redis} ioredis client instance
 */
function createRedisClient(options = {}) {
  const host = options.host || process.env.REDIS_HOST || '127.0.0.1';
  const port = options.port || parseInt(process.env.REDIS_PORT, 10) || 6379;
  const lazyConnect = options.lazyConnect || false;

  const client = new Redis({
    host,
    port,
    lazyConnect,
    maxRetriesPerRequest: 1,         // fail fast on connection issues
    retryStrategy(times) {
      // Retry with exponential backoff, max 3 seconds
      if (times > 5) return null;    // stop retrying after 5 attempts
      return Math.min(times * 200, 3000);
    },
    enableReadyCheck: true,
  });

  return client;
}

module.exports = { createRedisClient };
