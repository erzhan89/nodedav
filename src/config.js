const truthy = (v) => /^(1|true|yes|on)$/i.test(v ?? '');

function normalizeBase(p) {
  let base = (p ?? '/dav').trim();
  if (!base.startsWith('/')) base = `/${base}`;
  return base.replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  const basePath = normalizeBase(env.BASE_PATH);
  const adminEnabled = env.ADMIN_UI === undefined || truthy(env.ADMIN_UI);
  const adminPath = adminEnabled ? normalizeBase(env.ADMIN_PATH ?? '/admin') : null;
  if (adminPath !== null && (adminPath === '' || adminPath === basePath)) {
    throw new Error('ADMIN_PATH must be non-empty and different from BASE_PATH');
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET must be at least 16 characters');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8800),
    databaseUrl: env.DATABASE_URL ?? 'postgres://nodedav:nodedav@127.0.0.1:5432/nodedav',
    dbSchema: env.DB_SCHEMA || null,
    dbPoolSize: Number(env.DB_POOL_SIZE ?? 10),
    // URL prefix the DAV tree is served under; '' serves it at the root.
    basePath,
    realm: env.AUTH_REALM ?? 'nodedav',
    maxResourceSize: Number(env.MAX_RESOURCE_SIZE ?? 10 * 1024 * 1024),
    // Per-user storage quota in bytes (RFC 4331); 0 means unlimited.
    quotaBytes: Number(env.QUOTA_BYTES ?? 0),
    // CalDAV resource limits (RFC 4791 5.2.6-5.2.9); 0 disables max-instances / max-attendees checks.
    minDateTime: env.MIN_DATE_TIME ?? '00010101T000000Z',
    maxDateTime: env.MAX_DATE_TIME ?? '99991231T235959Z',
    maxInstances: Number(env.MAX_INSTANCES ?? 0),
    maxAttendees: Number(env.MAX_ATTENDEES ?? 0),
    // WebDAV lock lifetime (RFC 4918): used when the client names none, and the upper bound.
    lockTimeoutDefault: Number(env.LOCK_TIMEOUT_DEFAULT ?? 3600),
    lockTimeoutMax: Number(env.LOCK_TIMEOUT_MAX ?? 86_400),
    // Use the right-most X-Forwarded-For entry as client IP (only behind a trusted reverse proxy).
    trustProxy: truthy(env.TRUST_PROXY),
    logRequests: env.LOG_REQUESTS === undefined ? true : truthy(env.LOG_REQUESTS),
    // Web UI for user management; null disables it.
    adminPath,
    // Signs admin session cookies. Unset means a random key per process start (sessions end on restart).
    sessionSecret: env.SESSION_SECRET || null,
    // Optional first-run bootstrap: creates this admin when the user table is empty.
    adminUsername: env.ADMIN_USERNAME || null,
    adminPassword: env.ADMIN_PASSWORD || null,
  };
}
