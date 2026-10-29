import { randomBytes } from 'node:crypto';
import { MemoryStore } from './memory-store.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/auth.js';

export async function startServer(env = {}) {
  const config = loadConfig({ LOG_REQUESTS: 'false', ...env });
  // Set TEST_DATABASE_URL to run the suite against PostgreSQL; otherwise an in-memory store is used.
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const store = databaseUrl
    ? await (await import('../src/store.js')).Store.open(databaseUrl, { schema, poolSize: 8 })
    : new MemoryStore();
  for (const name of ['alice', 'bob']) {
    await store.createUser({ username: name, passwordHash: await hashPassword(`${name}-password`) });
  }
  const server = createServer({ store, config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const basic = (u) => `Basic ${Buffer.from(`${u}:${u}-password`).toString('base64')}`;
  const request = (method, path, { user = 'alice', headers = {}, body, auth = true } = {}) =>
    fetch(origin + path, {
      method,
      redirect: 'manual',
      body,
      headers: { ...(auth ? { Authorization: basic(user) } : {}), ...headers },
    });
  return {
    origin, store, request, isPostgres: Boolean(databaseUrl),
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (databaseUrl) await store.query(`DROP SCHEMA "${schema}" CASCADE`);
      await store.close();
    },
  };
}

export { ics, vcf } from './fixtures.js';
