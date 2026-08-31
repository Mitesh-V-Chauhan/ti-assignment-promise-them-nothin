'use strict';

const { createRedisClient } = require('../src/redis-client');
const { createRateLimiter } = require('../src/rate-limiter');

describe('Core Rate Limiter', () => {
  let redisClient;
  let limiter;
  let currentFakeTime = 1773588300; // 2026-03-14T10:05:00Z (a clean minute boundary)
  
  const fakeClock = () => currentFakeTime;

  beforeAll(async () => {
    // Connecting to the local redis running on 6380
    redisClient = createRedisClient({ port: 6380 });
    // Verify connection
    await redisClient.ping();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    // Clear redis before each test to ensure clean state
    await redisClient.flushdb();
    currentFakeTime = 1773588300; 
    limiter = createRateLimiter({ redisClient, clock: fakeClock });
  });

  // Test 1 & 2: Below quota and Exactly quota
  test('Below quota & Exactly quota: all accepted', async () => {
    const customerId = 'customer-A';
    const limit = 100;
    
    // Send 100 requests (Exactly quota)
    for (let i = 1; i <= limit; i++) {
      const result = await limiter.checkLimit(customerId, limit);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(i);
      expect(result.remaining).toBe(limit - i);
      expect(result.retryAfter).toBeNull();
    }
  });

  // Test 3: Quota + 1
  test('Quota + 1: 101st request is rejected with 429', async () => {
    const customerId = 'customer-B';
    const limit = 100;
    
    // Fill quota
    for (let i = 0; i < limit; i++) {
      await limiter.checkLimit(customerId, limit);
    }
    
    // 101st request
    const result = await limiter.checkLimit(customerId, limit);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    // At timestamp :00, the retry_after should be 60.
    expect(result.retryAfter).toBe(60); 
  });

  // Test 4: Rejected request does not increment count
  test('Rejected requests do not increment accepted count', async () => {
    const customerId = 'customer-C';
    const limit = 10;
    
    // Fill quota
    for (let i = 0; i < limit; i++) {
      await limiter.checkLimit(customerId, limit);
    }
    
    // Send 5 more requests (all should be rejected)
    for (let i = 0; i < 5; i++) {
      const result = await limiter.checkLimit(customerId, limit);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(10); // Still 10!
    }
  });

  // Test 5: Customer isolation
  test('Customer isolation: one customer exhausting quota does not affect another', async () => {
    const limitA = 100;
    const limitB = 60;
    
    // Exhaust A
    for (let i = 0; i < limitA; i++) {
      await limiter.checkLimit('cust-A', limitA);
    }
    const resultA = await limiter.checkLimit('cust-A', limitA);
    expect(resultA.allowed).toBe(false);

    // Verify B is untouched and can use full budget
    for (let i = 1; i <= limitB; i++) {
      const resultB = await limiter.checkLimit('cust-B', limitB);
      expect(resultB.allowed).toBe(true);
      expect(resultB.current).toBe(i);
    }
  });

  // Test 6 & Test 10: Window boundary & New window gets new key
  test('Window boundary: quota resets in the next calendar minute', async () => {
    const customerId = 'customer-D';
    const limit = 10;
    
    currentFakeTime = 1773588359; // 10:05:59 (1 second left in minute)
    
    // Exhaust quota in current window
    for (let i = 0; i < limit; i++) {
      await limiter.checkLimit(customerId, limit);
    }
    expect((await limiter.checkLimit(customerId, limit)).allowed).toBe(false);

    // Advance clock to next window (10:06:00)
    currentFakeTime = 1773588360; 

    // Should have fresh budget
    const resultNewWindow = await limiter.checkLimit(customerId, limit);
    expect(resultNewWindow.allowed).toBe(true);
    expect(resultNewWindow.current).toBe(1); // Fresh start
  });

  // Test 7: Retry-After calculations
  test('Retry-After values are calculated correctly', async () => {
    const customerId = 'customer-E';
    const limit = 0; // instantly reject to test Retry-After
    
    // at :00 (start of minute)
    currentFakeTime = 1773588300; 
    let res = await limiter.checkLimit(customerId, limit);
    expect(res.retryAfter).toBe(60);

    // at :30
    currentFakeTime = 1773588330;
    res = await limiter.checkLimit(customerId, limit);
    expect(res.retryAfter).toBe(30);

    // at :58
    currentFakeTime = 1773588358;
    res = await limiter.checkLimit(customerId, limit);
    expect(res.retryAfter).toBe(2);

    // at :59
    currentFakeTime = 1773588359;
    res = await limiter.checkLimit(customerId, limit);
    expect(res.retryAfter).toBe(1);
  });

  // Test 8: Remaining count
  test('Remaining count calculates correctly', async () => {
    const customerId = 'customer-F';
    const limit = 100;

    let res = await limiter.checkLimit(customerId, limit);
    expect(res.remaining).toBe(99); // 1 accepted
    
    for(let i = 0; i < 36; i++) { await limiter.checkLimit(customerId, limit); }
    res = await limiter.checkLimit(customerId, limit);
    expect(res.current).toBe(38);
    expect(res.remaining).toBe(62);

    for(let i = 0; i < 62; i++) { await limiter.checkLimit(customerId, limit); }
    res = await limiter.checkLimit(customerId, limit);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0); // Exhausted
  });

  // Test 9: First request TTL (window-aligned TTL + 1s safety margin)
  test('First request sets window-aligned TTL', async () => {
    const customerId = 'customer-G';
    const limit = 100;
    
    // Request at :00 (60s remaining in minute)
    currentFakeTime = 1773588300; 
    await limiter.checkLimit(customerId, limit);
    
    let windowId = Math.floor(currentFakeTime / 60);
    let key = `rl:${customerId}:${windowId}`;
    let ttl = await redisClient.ttl(key);
    expect(ttl).toBe(61); // 60s remaining + 1s safety

    // Different window: Request at :45 (15s remaining in minute)
    currentFakeTime = 1773588405; // 10:06:45
    await limiter.checkLimit(customerId, limit);
    
    windowId = Math.floor(currentFakeTime / 60);
    key = `rl:${customerId}:${windowId}`;
    ttl = await redisClient.ttl(key);
    expect(ttl).toBe(16); // 15s remaining + 1s safety
  });

  // Test 11: Concurrency 
  test('Concurrency: Exactly `limit` requests allowed under concurrent load', async () => {
    const customerId = 'customer-H';
    const limit = 100;
    const concurrentRequests = 150;

    // Fire 150 requests simultaneously
    const promises = [];
    for (let i = 0; i < concurrentRequests; i++) {
      promises.push(limiter.checkLimit(customerId, limit));
    }
    
    const results = await Promise.all(promises);
    
    const allowed = results.filter(r => r.allowed === true).length;
    const rejected = results.filter(r => r.allowed === false).length;

    expect(allowed).toBe(limit);
    expect(rejected).toBe(concurrentRequests - limit);

    // Verify counter in Redis is exactly limit
    const windowId = Math.floor(currentFakeTime / 60);
    const key = `rl:${customerId}:${windowId}`;
    const countInRedis = await redisClient.get(key);
    expect(parseInt(countInRedis)).toBe(limit);
  });
});
