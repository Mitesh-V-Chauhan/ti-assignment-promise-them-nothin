'use strict';

/**
 * app.js — Express application factory for RelayAPI.
 *
 * Separated from server.js so that:
 * - Tests can create an app instance without starting a listening server
 * - Multiple server instances (Node 1, 2, 3) share the same app logic
 */

const express = require('express');
const { resolveQuota } = require('./config');

/**
 * Create the Express application.
 *
 * @param {object} options
 * @param {object} options.rateLimiter - Rate limiter instance (from createRateLimiter)
 * @param {string} [options.nodeId='unknown'] - Identifier for this node (for observability)
 * @returns {express.Application}
 */
function createApp({ rateLimiter, nodeId = 'unknown' } = {}) {
  // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage - Stateless API authenticated via X-Customer-Id header; no browser cookies/sessions, so CSRF is not applicable.
  const app = express();

  // ─── Health endpoint ──────────────────────────────────────────────
  // Does NOT depend on the rate limiter or Redis.
  // Reason: health checks should reflect whether the HTTP server is alive,
  // not whether downstream dependencies are healthy. A separate /ready
  // endpoint could check Redis if needed for production use.
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      node: nodeId,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── API endpoint (mock resource) ─────────────────────────────────
  // This represents the actual API that customers call.
  // Rate limiting will be applied here (Phase 3).
  app.get('/api/v1/resource', async (req, res) => {
    const customerId = req.headers['x-customer-id'];

    // Validate customer identity
    if (!customerId) {
      return res.status(401).json({
        error: 'missing_customer_id',
        message: 'X-Customer-Id header is required.',
      });
    }

    const quota = resolveQuota(customerId);
    if (!quota) {
      return res.status(401).json({
        error: 'unknown_customer',
        message: `Unknown customer: ${customerId}`,
      });
    }

    // Rate limiting check (Phase 3 will make this real)
    try {
      const result = await rateLimiter.checkLimit(customerId, quota.rpm);

      // Set rate-limit headers on every response
      res.set('X-RateLimit-Limit', String(result.limit));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(result.resetAt));
      res.set('X-Served-By', nodeId);

      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
          retry_after: result.retryAfter,
          limit: result.limit,
          remaining: 0,
        });
      }

      // Success — return mock resource
      return res.status(200).json({
        data: 'ok',
        customer: customerId,
        node: nodeId,
        rate_limit: {
          limit: result.limit,
          remaining: result.remaining,
          reset: result.resetAt,
        },
      });
    } catch (err) {
      // Redis connection failure → fail closed with 503
      // (Phase 1 decision: CTO prefers over-reject over under-limit)
      console.error('[%s] Rate limiter error:', nodeId, err.message);
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Rate limiting service is temporarily unavailable.',
      });
    }
  });

  return app;
}

module.exports = { createApp };
