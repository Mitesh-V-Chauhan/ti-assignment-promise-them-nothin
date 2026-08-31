'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { createRateLimiter } = require('../src/rate-limiter');
const { createRedisClient } = require('../src/redis-client');

describe('HTTP Integration Tests', () => {
  let redisClient;
  let limiter;
  let app;
  let currentFakeTime = 1773588300; 
  
  const fakeClock = () => currentFakeTime;

  beforeAll(async () => {
    redisClient = createRedisClient({ port: 6380 });
    await redisClient.ping();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    currentFakeTime = 1773588300; 
    limiter = createRateLimiter({ redisClient, clock: fakeClock });
    app = createApp({ rateLimiter: limiter, nodeId: 'test-node' });
  });

  test('Valid request receives correct headers', async () => {
    const res = await request(app)
      .get('/api/v1/resource')
      .set('X-Customer-Id', 'customer-1'); // 60 RPM limit

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('59');
    expect(res.headers['x-ratelimit-reset']).toBe('1773588360');
  });

  test('Exceeding quota returns 429 with Retry-After', async () => {
    const limit = 60; // for customer-1
    for (let i = 0; i < limit; i++) {
      await request(app).get('/api/v1/resource').set('X-Customer-Id', 'customer-1');
    }

    const res = await request(app)
      .get('/api/v1/resource')
      .set('X-Customer-Id', 'customer-1');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60'); // since time is :00
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.body.error).toBe('rate_limit_exceeded');
  });

  test('Redis failure returns 503', async () => {
    const brokenRedisClient = createRedisClient({ port: 9999, maxRetriesPerRequest: 0 }); 
    brokenRedisClient.options.retryStrategy = () => null;

    const brokenLimiter = createRateLimiter({ redisClient: brokenRedisClient, clock: fakeClock });
    const brokenApp = createApp({ rateLimiter: brokenLimiter, nodeId: 'broken-node' });

    await new Promise(r => setTimeout(r, 100));

    const res = await request(brokenApp).get('/api/v1/resource').set('X-Customer-Id', 'customer-1');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');

    brokenRedisClient.disconnect();
  });
});

describe('Phase 5 — Stakeholder Conflict Resolution Tests', () => {
  let redisClient;
  let limiter;
  let app;
  const fakeClock = () => 1773588300; 

  beforeAll(async () => {
    redisClient = createRedisClient({ port: 6380 });
    await redisClient.ping();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    limiter = createRateLimiter({ redisClient, clock: fakeClock });
    app = createApp({ rateLimiter: limiter, nodeId: 'test-node' });
  });

  test('Test A: Northwind existing contract = 300 RPM. Traffic > 300 receives 429', async () => {
    const limit = 300;
    
    // Fill quota
    for (let i = 0; i < limit; i++) {
      await request(app).get('/api/v1/resource').set('X-Customer-Id', 'northwind');
    }

    // 301st request
    const res = await request(app).get('/api/v1/resource').set('X-Customer-Id', 'northwind');
    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });

  test('Test B: Another customer with the same 300 RPM quota behaves identically', async () => {
    const limit = 300;
    
    // Fill quota for customer-2 (growth tier = 300)
    for (let i = 0; i < limit; i++) {
      await request(app).get('/api/v1/resource').set('X-Customer-Id', 'customer-2');
    }

    const res = await request(app).get('/api/v1/resource').set('X-Customer-Id', 'customer-2');
    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });

  test('Test C: Configuration-driven increase for Northwind to 1200 RPM works transparently', async () => {
    const configModule = require('../src/config');
    
    // Temporarily change the config object directly (as if a config deployment happened)
    const originalRpm = configModule.customers['northwind'].rpm;
    configModule.customers['northwind'].rpm = 1200;

    // Fill the original 300
    for (let i = 0; i < 300; i++) {
      await request(app).get('/api/v1/resource').set('X-Customer-Id', 'northwind');
    }

    // 301st request should now be accepted because config quota is 1200
    const res = await request(app).get('/api/v1/resource').set('X-Customer-Id', 'northwind');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('1200');

    // Restore
    configModule.customers['northwind'].rpm = originalRpm;
  });

  test('Test D: No Northwind-specific production bypass exists in the system', () => {
    // We ensure the app has NO hardcoded bypass logic.
    // The only place 'northwind' should be mentioned is in src/config.js as data.
    const fs = require('fs');
    const path = require('path');
    const srcFiles = fs.readdirSync(path.join(__dirname, '../src')).filter(f => f.endsWith('.js'));
    
    let hasHardcodedNorthwind = false;
    for (const file of srcFiles) {
      if (file === 'config.js') continue; // config contains data
      const content = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
      if (content.toLowerCase().includes('northwind')) {
        hasHardcodedNorthwind = true;
      }
    }
    expect(hasHardcodedNorthwind).toBe(false);
  });
});

