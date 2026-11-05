import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('server smoke test without provider credentials or database', async t => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'orefyspace-smoke-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DATABASE_URL: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', AUTH_REQUIRED: 'false' },
    stdio: 'ignore'
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  let base = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited early with code ${child.exitCode}`);
    try { response = await fetch(`${base}/api/health`); break; }
    catch { await delay(150); }
  }
  assert.ok(response, 'server should start and respond');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  response = await fetch(`${base}/api/auth/config`);
  assert.deepEqual(await response.json(), { enabled: false, required: false, supabaseUrl: '', publicKey: '' });

  response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<html/i);
  assert.match(html, /id="auth-form"/);
  for (const provider of ['google', 'apple', 'azure']) assert.match(html, new RegExp(`data-auth-provider="${provider}"`));
  response = await fetch(`${base}/styles.css`);
  assert.equal(response.status, 200);
  const styles = await response.text();
  assert.match(styles, /--bg: #f7f7f8/);
  assert.match(styles, /html\[data-theme="dark"\]/);

  for (const path of ['/api/conversations', '/api/projects', '/api/prompts']) {
    response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} should respond successfully`);
    assert.ok(Array.isArray(await response.json()), `${path} should return a JSON array`);
  }

  response = await fetch(`${base}/api/route-that-does-not-exist`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
});

test('Supabase-authenticated accounts have isolated workspaces and protected APIs', async t => {
  const authServer = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const users = {
      'test-token-a': { id: 'smoke-user-a', email: 'a@example.test' },
      'test-token-b': { id: 'smoke-user-b', email: 'b@example.test' }
    };
    const user = request.url === '/auth/v1/user' ? users[token] : null;
    response.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(user || { message: 'Invalid token' }));
  });
  authServer.listen(0, '127.0.0.1');
  await once(authServer, 'listening');
  const authPort = authServer.address().port;
  t.after(() => new Promise(resolve => authServer.close(() => resolve())));

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'orefyspace-auth-smoke-'));
  writeFileSync(join(dataDir, 'prompts.json'), JSON.stringify([{ id: 'legacy-private', title: 'Private legacy prompt', category: 'Personal', content: 'This must never be copied to new accounts.' }]));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DATABASE_URL: '', SUPABASE_URL: `http://127.0.0.1:${authPort}`, SUPABASE_ANON_KEY: 'public-test-key', AUTH_REQUIRED: 'true' },
    stdio: 'ignore'
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited early with code ${child.exitCode}`);
    try { response = await fetch(`${base}/api/health`); break; }
    catch { await delay(150); }
  }
  assert.ok(response, 'authenticated server should start and respond');
  assert.equal(response.status, 200, 'health check remains public');

  response = await fetch(`${base}/api/auth/config`);
  assert.deepEqual(await response.json(), { enabled: true, required: true, supabaseUrl: `http://127.0.0.1:${authPort}`, publicKey: 'public-test-key' });

  response = await fetch(`${base}/api/conversations`);
  assert.equal(response.status, 401, 'workspace APIs reject anonymous requests');
  response = await fetch(`${base}/api/conversations`, { headers: { authorization: 'Bearer invalid' } });
  assert.equal(response.status, 401, 'workspace APIs reject invalid sessions');

  const accountA = { authorization: 'Bearer test-token-a', 'content-type': 'application/json' };
  const accountB = { authorization: 'Bearer test-token-b', 'content-type': 'application/json' };
  response = await fetch(`${base}/api/conversations`, { method: 'POST', headers: accountA, body: JSON.stringify({ title: 'Private conversation A', messages: [] }) });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/api/conversations`, { headers: accountB });
  assert.deepEqual(await response.json(), [], 'account B cannot see account A conversations');
  response = await fetch(`${base}/api/conversations`, { headers: accountA });
  assert.equal((await response.json())[0].title, 'Private conversation A');

  response = await fetch(`${base}/api/prompts`, { headers: accountA });
  const promptsA = await response.json();
  assert.ok(promptsA.some(prompt => prompt.title === 'Code review brief'), 'account A receives generic starter prompts');
  assert.ok(!promptsA.some(prompt => prompt.title === 'Private legacy prompt'), 'account A does not receive legacy private prompts');
  const starterId = promptsA[0].id;
  response = await fetch(`${base}/api/prompts`, { headers: accountA });
  assert.equal((await response.json())[0].id, starterId, 'starter prompt IDs remain stable across requests');
  response = await fetch(`${base}/api/prompts`, { headers: accountB });
  assert.ok(!(await response.json()).some(prompt => prompt.title === 'Private legacy prompt'), 'account B does not receive legacy private prompts');
});
