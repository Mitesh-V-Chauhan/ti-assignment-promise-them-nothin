'use strict';

/**
 * rate-limiter.js — Rate limiter implementation for RelayAPI.
 *
 * DESIGN:
 * - Algorithm: Fixed Window Counter (calendar-minute buckets, UTC)
 * - Counter: counts ACCEPTED requests only
 * - Atomicity: ALL rate-limit logic runs inside a single Redis Lua script
 * - TTL: aligned with calendar-minute boundary + 1s safety margin
 * - Clock: injectable for deterministic testing
 */

const { systemClock } = require('./clock');

// The Lua script executes atomically. No other Redis commands can interleave.
const LUA_SCRIPT = `
  local key   = KEYS[1]
  local limit = tonumber(ARGV[1])
  local now   = tonumber(ARGV[2])

  -- Read current accepted count. Missing key treated as "0".
  local current = tonumber(redis.call('GET', key) or "0")

  -- Reject if quota is reached. Do NOT increment.
  if current >= limit then
      return { 0, current, limit }
  end

  -- Below limit: increment accepted count
  local new_count = redis.call('INCR', key)
  
  -- If this is the first accepted request, set TTL
  if new_count == 1 then
      -- TTL is time remaining in current minute + 1 second safety margin
      local ttl = 60 - (now % 60) + 1
      redis.call('EXPIRE', key, ttl)
  end

  return { 1, new_count, limit }
`;

/**
 * Create a rate limiter instance.
 *
 * @param {object} options
 * @param {Redis}  options.redisClient - ioredis client instance
 * @param {Function} [options.clock=systemClock] - Returns current Unix timestamp (seconds)
 * @returns {object} Rate limiter with checkLimit() method
 */
function createRateLimiter({ redisClient, clock = systemClock } = {}) {
  // Register the Lua script with ioredis so we can call it easily.
  // ioredis handles script loading/caching via EVALSHA automatically.
  redisClient.defineCommand('rateLimitCheck', {
    numberOfKeys: 1,
    lua: LUA_SCRIPT,
  });

  return {
    /**
     * Check whether a request from the given customer should be allowed.
     *
     * @param {string} customerId
     * @param {number} limit - RPM quota for this customer
     * @returns {Promise<{allowed: boolean, current: number, limit: number, remaining: number, retryAfter: number|null, resetAt: number}>}
     */
    async checkLimit(customerId, limit) {
      const now = clock();
      const windowId = Math.floor(now / 60);
      const key = `rl:${customerId}:${windowId}`;
      const windowEnd = (windowId + 1) * 60;

      // Execute the atomic Lua script
      // result is an array: [ allowed_flag, current_count, limit ]
      const result = await redisClient.rateLimitCheck(key, limit, now);
      
      const isAllowed = result[0] === 1;
      const currentCount = result[1];
      const appliedLimit = result[2];

      const remaining = Math.max(0, appliedLimit - currentCount);
      let retryAfter = null;

      if (!isAllowed) {
        // Calculate Retry-After: seconds until the next calendar minute
        retryAfter = 60 - (now % 60);
        // Minimum 1 second just in case of edge timing
        if (retryAfter < 1) retryAfter = 1;
      }

      return {
        allowed: isAllowed,
        current: currentCount,
        limit: appliedLimit,
        remaining: remaining,
        retryAfter: retryAfter,
        resetAt: windowEnd,
      };
    },
  };
}

module.exports = { createRateLimiter };
