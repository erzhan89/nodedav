import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createServer } from './server.js';
import { hashPassword } from './auth.js';
import { USERNAME, passwordProblem } from './validate.js';

const config = loadConfig();
const store = await Store.open(config.databaseUrl, { schema: config.dbSchema, poolSize: config.dbPoolSize }).catch((err) => {
  console.error(`Cannot connect to PostgreSQL: ${err.message}`);
  process.exit(1);
});

if (config.adminUsername && config.adminPassword && await store.countUsers() === 0) {
  const problem = !USERNAME.test(config.adminUsername) ? 'ADMIN_USERNAME is not a valid username' : passwordProblem(config.adminPassword);
  if (problem) {
    console.error(`Skipping admin bootstrap: ${problem}`);
  } else {
    try {
      await store.createUser({ username: config.adminUsername, passwordHash: await hashPassword(config.adminPassword), isAdmin: true });
      console.log(`Created initial admin user "${config.adminUsername.toLowerCase()}"`);
    } catch (err) {
      if (err.code !== '23505') throw err; // another instance created it first
    }
  }
}

const server = createServer({ store, config });

server.listen(config.port, config.host, () => {
  console.log(`nodedav listening on http://${config.host}:${config.port}${config.basePath}/ (PostgreSQL)`);
  if (config.adminPath) console.log(`Admin UI at http://${config.host}:${config.port}${config.adminPath}/`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await store.close().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
