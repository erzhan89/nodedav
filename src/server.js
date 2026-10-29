import { createServer as createHttpServer } from 'node:http';
import { Authenticator } from './auth.js';
import { createHandler } from './dav.js';
import { createAdminHandler } from './admin.js';

export function createServer({ store, config }) {
  const auth = new Authenticator(store, { realm: config.realm, trustProxy: config.trustProxy });
  const dav = createHandler({ store, config, auth });
  const admin = config.adminPath ? createAdminHandler({ store, config, auth }) : null;
  // When BASE_PATH is '' the DAV tree sits at the root, so the admin check must come first.
  const server = createHttpServer((req, res) => (admin?.matches(req.url) ? admin.handle(req, res) : dav(req, res)));
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}
