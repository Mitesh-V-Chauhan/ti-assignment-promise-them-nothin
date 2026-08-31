'use strict';

/**
 * health.test.js — Verify the service skeleton works.
 *
 * These tests validate the project infrastructure (Express app, routing,
 * configuration) WITHOUT requiring Redis. The rate limiter is stubbed.
 */

const request = require('supertest');
const { createApp } = require('../src/app');

// Stub rate limiter — always allows (Phase 3 will test real limiting)
const stubRateLimiter = {
  async checkLimit(customerId, limit) {
    return {
      allowed: true,
      current: 1,
      limit,
      remaining: limit - 1,
      retryAfter: null,
      resetAt: Math.floor(Date.now() / 1000 / 60 + 1) * 60,
    };
  },
};

const app = createApp({ rateLimiter: stubRateLimiter, nodeId: 'test-node' });

describe('Health endpoint', () => {
  test('GET /health returns 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.node).toBe('test-node');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('API endpoint — customer validation', () => {
  test('Missing X-Customer-Id returns 401', async () => {
    const res = await request(app).get('/api/v1/resource');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_customer_id');
  });

  test('Unknown customer returns 401', async () => {
    const res = await request(app)
      .get('/api/v1/resource')
      .set('X-Customer-Id', 'nonexistent-customer');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unknown_customer');
  });

  test('Valid customer returns 200 with rate-limit headers', async () => {
    const res = await request(app)
      .get('/api/v1/resource')
      .set('X-Customer-Id', 'customer-1');

    expect(res.status).toBe(200);
    expect(res.body.customer).toBe('customer-1');
    expect(res.body.node).toBe('test-node');
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['x-served-by']).toBe('test-node');
  });

  test('Northwind resolves to enterprise tier (300 RPM)', async () => {
    const res = await request(app)
      .get('/api/v1/resource')
      .set('X-Customer-Id', 'northwind');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });
});

describe('Configuration', () => {
  const { resolveQuota } = require('../src/config');

  test('customer-1 resolves to starter tier (60 RPM)', () => {
    const q = resolveQuota('customer-1');
    expect(q).not.toBeNull();
    expect(q.tier).toBe('starter');
    expect(q.rpm).toBe(60);
  });

  test('customer-2 resolves to growth tier (300 RPM)', () => {
    const q = resolveQuota('customer-2');
    expect(q).not.toBeNull();
    expect(q.tier).toBe('growth');
    expect(q.rpm).toBe(300);
  });

  test('northwind resolves to enterprise tier (300 RPM)', () => {
    const q = resolveQuota('northwind');
    expect(q).not.toBeNull();
    expect(q.tier).toBe('enterprise');
    expect(q.rpm).toBe(300);
  });

  test('unknown customer returns null', () => {
    const q = resolveQuota('nobody');
    expect(q).toBeNull();
  });
});
