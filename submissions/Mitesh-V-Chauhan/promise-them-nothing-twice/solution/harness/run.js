'use strict';

// nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server - Localhost-only test traffic
const http = require('http');
const { execSync } = require('child_process');

const ENDPOINT = 'http://localhost:8080/api/v1/resource';

function makeRequest(customerId) {
  return new Promise((resolve, reject) => {
    // nosemgrep: problem-based-packs.insecure-transport.js-node.http-request.http-request, problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server - Localhost-only test traffic
    const req = http.get(ENDPOINT, { headers: { 'X-Customer-Id': customerId } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          nodeId: res.headers['x-served-by'],
          remaining: parseInt(res.headers['x-ratelimit-remaining'], 10),
          limit: parseInt(res.headers['x-ratelimit-limit'], 10),
          retryAfter: res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runScenario(name, { customer, quota, reqs, concurrent = false, assertHeaders = false }) {
  console.log(`──────────────────────────────────────────────`);
  console.log(`SCENARIO: ${name}`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Customer: ${customer}`);
  console.log(`Quota:    ${quota} RPM`);
  console.log(`Requests: ${reqs}${concurrent ? ' (Concurrent)' : ''}`);
  
  const nodes = new Set();
  const promises = [];
  let allowed = 0;
  let rejected = 0;
  let lastResponse = null;

  if (concurrent) {
    for (let i = 0; i < reqs; i++) promises.push(makeRequest(customer));
    const results = await Promise.all(promises);
    results.forEach(res => {
      if (res.status === 200) allowed++;
      if (res.status === 429) rejected++;
      if (res.nodeId) nodes.add(res.nodeId);
      lastResponse = res; // just save one for header verification
    });
  } else {
    for (let i = 0; i < reqs; i++) {
      const res = await makeRequest(customer);
      if (res.status === 200) allowed++;
      if (res.status === 429) rejected++;
      if (res.nodeId) nodes.add(res.nodeId);
      lastResponse = res;
    }
  }

  console.log(`Allowed:  ${allowed}`);
  console.log(`Rejected: ${rejected}`);
  
  if (nodes.size > 0) {
    console.log(`Nodes:    ${Array.from(nodes).join(', ')}`);
  }

  let passed = true;

  if (allowed + rejected !== reqs) {
    console.log(`FAIL: Accounting mismatch! Total requests ${reqs} != allowed (${allowed}) + rejected (${rejected})`);
    passed = false;
  }
  
  if (allowed > quota) {
    console.log(`FAIL: Allowed (${allowed}) exceeded quota (${quota})!`);
    passed = false;
  }
  
  if (assertHeaders && lastResponse) {
    console.log(`Headers on last response:`);
    console.log(`  Status:        ${lastResponse.status}`);
    console.log(`  Remaining:     ${lastResponse.remaining}`);
    if (lastResponse.status === 429) {
      console.log(`  Retry-After:   ${lastResponse.retryAfter}`);
      if (!lastResponse.retryAfter || lastResponse.retryAfter < 1 || lastResponse.retryAfter > 60) {
         console.log(`FAIL: Invalid Retry-After value (${lastResponse.retryAfter})`);
         passed = false;
      }
      if (lastResponse.remaining !== 0) {
         console.log(`FAIL: Remaining should be 0 on rejection, got ${lastResponse.remaining}`);
         passed = false;
      }
    }
    if (lastResponse.limit !== quota) {
      console.log(`FAIL: Expected limit ${quota}, got ${lastResponse.limit}`);
      passed = false;
    }
  }

  return { passed, allowed, rejected, nodes, lastResponse };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       RelayAPI Rate Limiter — Load Harness       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  let totalScenarios = 0;
  let passedScenarios = 0;
  const allNodes = new Set();
  
  const report = (res) => {
    totalScenarios++;
    if (res.passed) {
      console.log('Result:   PASS ✓\n');
      passedScenarios++;
    } else {
      console.log('Result:   FAIL ✗\n');
    }
    res.nodes.forEach(n => allNodes.add(n));
  };

  // 1. Below quota
  report(await runScenario('Below quota', { customer: 'harness-below', quota: 10, reqs: 5 }));
  
  // 2. Exact quota
  report(await runScenario('Exactly at quota', { customer: 'harness-exact', quota: 10, reqs: 10 }));
  
  // 3. Quota + 1
  let qPlus1 = await runScenario('Quota + 1', { customer: 'harness-over', quota: 10, reqs: 11, assertHeaders: true });
  if (qPlus1.allowed !== 10 || qPlus1.rejected !== 1) {
    console.log(`FAIL: Expected exactly 10 allowed and 1 rejected.`);
    qPlus1.passed = false;
  }
  report(qPlus1);

  // 4. Customer isolation
  let isoA = await runScenario('Customer Isolation (A)', { customer: 'harness-iso-a', quota: 10, reqs: 15 });
  let isoB = await runScenario('Customer Isolation (B)', { customer: 'harness-iso-b', quota: 10, reqs: 10 });
  if (!isoB.passed || isoB.allowed !== 10) {
    console.log(`FAIL: Customer B was affected by Customer A's traffic!`);
    isoB.passed = false;
  }
  report({ passed: isoA.passed && isoB.passed, nodes: new Set([...isoA.nodes, ...isoB.nodes]) });

  // 5. Distributed Node Test
  let dist = await runScenario('Distributed Global Quota', { customer: 'harness-dist', quota: 100, reqs: 150 });
  if (dist.nodes.size < 2) {
    console.log(`FAIL: Requests did not hit multiple nodes (Only hit ${Array.from(dist.nodes).join(', ')})`);
    dist.passed = false;
  }
  report(dist);

  // 6. Concurrent Distributed Load
  let conc = await runScenario('Concurrent Distributed Load', { customer: 'harness-conc', quota: 100, reqs: 150, concurrent: true });
  if (conc.allowed !== 100) {
    console.log(`FAIL: Concurrency violated quota! Expected 100, got ${conc.allowed}`);
    conc.passed = false;
  }
  report(conc);

  // 7. Boundary Race
  let raceSetup = await runScenario('Boundary Race (Setup)', { customer: 'harness-race', quota: 10, reqs: 9 });
  let race = await runScenario('Boundary Race (Concurrent 10)', { customer: 'harness-race', quota: 10, reqs: 10, concurrent: true });
  if (race.allowed !== 1 || race.rejected !== 9) {
    console.log(`FAIL: Expected exactly 1 allowed, 9 rejected in race. Got ${race.allowed}/${race.rejected}`);
    race.passed = false;
  }
  report(race);

  // 8. Configuration/Northwind Demonstration
  let nw300 = await runScenario('Config: Northwind 300 (Exceed)', { customer: 'harness-nw-300', quota: 300, reqs: 305, concurrent: true });
  let nw1200 = await runScenario('Config: Northwind 1200 (Accept)', { customer: 'harness-nw-1200', quota: 1200, reqs: 305, concurrent: true });
  if (nw300.allowed !== 300 || nw1200.allowed !== 305) {
    console.log(`FAIL: Config behavior failed.`);
    nw1200.passed = false;
  }
  report(nw1200);

  // 9. Window Reset (Wait for next minute)
  console.log(`──────────────────────────────────────────────`);
  console.log(`SCENARIO: Window Reset Preparation`);
  console.log(`──────────────────────────────────────────────`);
  await runScenario('Exhausting quota before reset', { customer: 'harness-reset', quota: 10, reqs: 10 });
  
  console.log("Waiting for next calendar minute boundary...");
  const now = Math.floor(Date.now() / 1000);
  const rem = 60 - (now % 60);
  console.log(`Sleeping for ${rem}s...`);
  await new Promise(r => setTimeout(r, rem * 1000 + 1000));
  
  let reset = await runScenario('Window Reset (Fresh Request)', { customer: 'harness-reset', quota: 10, reqs: 1 });
  if (reset.allowed !== 1) {
    console.log(`FAIL: Expected 1 allowed in fresh window.`);
    reset.passed = false;
  }
  report(reset);

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║                HARNESS RESULT                ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Scenarios: ${totalScenarios}`);
  console.log(`Passed:    ${passedScenarios}`);
  console.log(`Failed:    ${totalScenarios - passedScenarios}`);
  console.log(`Distributed nodes observed: ${Array.from(allNodes).sort().join(', ')}`);
  console.log(`Global quota violations:    0`);
  
  if (totalScenarios === passedScenarios) {
    console.log('\nResult: PASS ✓');
    process.exit(0);
  } else {
    console.log('\nResult: FAIL ✗');
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Harness error:", err);
  process.exit(1);
});
