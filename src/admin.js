import { Buffer } from 'node:buffer';
import { HttpError } from './errors.js';
import { hashPassword } from './auth.js';
import { Sessions } from './session.js';
import { USERNAME, EMAIL, CONTROL_CHARS, passwordProblem } from './validate.js';
import {
  CSS, loginPage, messagePage, usersPage, userFormPage, deletePage, accountPage,
} from './admin-views.js';

const COOKIE = 'nodedav_session';
const FORM_LIMIT = 16 * 1024;
const FLASH = new Map([
  ['created', 'User created.'],
  ['updated', 'Changes saved.'],
  ['deleted', 'User deleted.'],
  ['password', 'Password changed.'],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const lastOf = (header) => header?.split(',').at(-1).trim();

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, ...SECURITY_HEADERS, ...headers,
  });
  res.end(buf);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Content-Length': 0, ...SECURITY_HEADERS, ...headers });
  res.end();
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function readForm(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Unsupported Media Type');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FORM_LIMIT) throw new HttpError(413, 'Payload Too Large', { headers: { Connection: 'close' } });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function passwordErrors(password, confirm) {
  const errors = [];
  const problem = passwordProblem(password);
  if (problem) errors.push(problem);
  if (password !== confirm) errors.push('Passwords do not match.');
  return errors;
}

function profileErrors({ display_name: name, email }) {
  const errors = [];
  if (name.length > 128 || CONTROL_CHARS.test(name)) errors.push('Display name must be at most 128 characters with no control characters.');
  if (email && (email.length > 254 || !EMAIL.test(email) || CONTROL_CHARS.test(email))) errors.push('Email address is not valid.');
  return errors;
}

/** Server-rendered user management UI. Returns { matches(url), handle(req, res) }; `auth` is shared with the DAV handler. */
export function createAdminHandler({ store, config, auth }) {
  const base = config.adminPath;
  const sessions = new Sessions(config.sessionSecret);

  const isHttps = (req) => Boolean(req.socket.encrypted) || (config.trustProxy && lastOf(req.headers['x-forwarded-proto']) === 'https');

  const serverInfo = (req) => {
    const secure = isHttps(req);
    const host = (config.trustProxy && lastOf(req.headers['x-forwarded-host'])) || req.headers.host || 'localhost';
    return { host, secure, url: `${secure ? 'https' : 'http'}://${host}${config.basePath}/` };
  };

  const sessionCookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  // Browsers always send Sec-Fetch-Site or Origin on cross-site form posts; non-browser clients send neither.
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'none';
    const { origin } = req.headers;
    if (!origin) return true;
    try {
      return new URL(origin).host === serverInfo(req).host;
    } catch {
      return false;
    }
  }

  async function getSession(req) {
    const value = readCookie(req, COOKIE);
    const parsed = value && sessions.parse(value);
    if (!parsed) return null;
    const user = await store.getUserById(parsed.userId);
    if (!user || !sessions.matches(parsed, user)) return null;
    return { user, value, csrf: sessions.csrfToken(value) };
  }

  const flashOf = (url) => FLASH.get(url.searchParams.get('ok')) ?? null;
  const notFound = (ctx) => send(ctx.res, 404, messagePage(ctx, 'Not found', 'No such user.'));

  // ---- handlers ------------------------------------------------------------

  async function login(req, res) {
    const form = await readForm(req);
    const username = form.get('username') ?? '';
    let user;
    try {
      user = await auth.verifyLogin(username, form.get('password') ?? '', auth.clientIp(req));
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        return send(res, 429, loginPage({ base }, { error: 'Too many failed attempts. Try again later.', username }), err.headers);
      }
      throw err;
    }
    if (!user) return send(res, 403, loginPage({ base }, { error: 'Wrong username or password.', username }));
    return redirect(res, `${base}/`, { 'Set-Cookie': sessionCookie(req, sessions.issue(user), sessions.maxAge) });
  }

  async function showUsers(ctx) {
    send(ctx.res, 200, usersPage(ctx, await store.listUsersWithStats(), flashOf(ctx.url)));
  }

  function showNewUser(ctx) {
    send(ctx.res, 200, userFormPage(ctx, { mode: 'new', values: { username: '', display_name: '', email: '', is_admin: false } }));
  }

  async function createUser(ctx) {
    const f = ctx.form;
    const values = {
      username: (f.get('username') ?? '').trim().toLowerCase(),
      display_name: (f.get('display_name') ?? '').trim(),
      email: (f.get('email') ?? '').trim(),
      is_admin: f.get('is_admin') === 'on',
    };
    const password = f.get('password') ?? '';
    const errors = [...profileErrors(values), ...passwordErrors(password, f.get('confirm') ?? '')];
    if (!USERNAME.test(values.username)) errors.push('Username must be 1-64 characters: letters, digits and . _ @ + -');
    else if (await store.getUserByName(values.username)) errors.push('That username is already taken.');
    if (errors.length) return send(ctx.res, 400, userFormPage(ctx, { mode: 'new', values, errors }));

    let user;
    try {
      user = await store.createUser({
        username: values.username,
        passwordHash: await hashPassword(password),
        displayName: values.display_name || values.username,
        email: values.email || null,
        isAdmin: values.is_admin,
      });
    } catch (err) {
      if (err.code !== '23505') throw err;
      return send(ctx.res, 400, userFormPage(ctx, { mode: 'new', values, errors: ['That username is already taken.'] }));
    }
    return redirect(ctx.res, `${base}/users/${user.id}?ok=created`);
  }

  async function showEdit(ctx, id) {
    const target = await store.getUserById(id);
    if (!target) return notFound(ctx);
    const values = { username: target.username, display_name: target.display_name, email: target.email ?? '', is_admin: target.is_admin };
    const collections = await store.listCollectionsWithCounts(id);
    return send(ctx.res, 200, userFormPage(ctx, { mode: 'edit', target, values, collections }, flashOf(ctx.url)));
  }

  async function updateUser(ctx, id) {
    const target = await store.getUserById(id);
    if (!target) return notFound(ctx);
    const f = ctx.form;
    const isSelf = id === ctx.user.id;
    const values = {
      username: target.username,
      display_name: (f.get('display_name') ?? '').trim(),
      email: (f.get('email') ?? '').trim(),
      is_admin: isSelf ? true : f.get('is_admin') === 'on',
    };
    const password = f.get('password') ?? '';
    const errors = [...profileErrors(values), ...(password ? passwordErrors(password, f.get('confirm') ?? '') : [])];
    if (errors.length) {
      const collections = await store.listCollectionsWithCounts(id);
      return send(ctx.res, 400, userFormPage(ctx, { mode: 'edit', target, values, errors, collections }));
    }

    const patch = {
      displayName: values.display_name || target.username,
      email: values.email || null,
      isAdmin: values.is_admin,
    };
    if (password) patch.passwordHash = await hashPassword(password);
    // Locking the admin rows serialises concurrent role changes, so the admin set can never become empty.
    await store.transaction(async (tx) => {
      if (!(await tx.lockAdmins()).includes(ctx.user.id)) throw new HttpError(403, 'Forbidden');
      await tx.updateUser(id, patch);
    });

    const headers = {};
    if (isSelf && password) {
      headers['Set-Cookie'] = sessionCookie(ctx.req, sessions.issue(await store.getUserById(id)), sessions.maxAge);
    }
    return redirect(ctx.res, `${base}/users/${id}?ok=updated`, headers);
  }

  async function showDelete(ctx, id) {
    const target = await store.getUserById(id);
    if (!target) return notFound(ctx);
    if (id === ctx.user.id) return send(ctx.res, 403, messagePage(ctx, 'Forbidden', 'You cannot delete your own account.'));
    return send(ctx.res, 200, deletePage(ctx, target, await store.listCollectionsWithCounts(id)));
  }

  async function deleteUser(ctx, id) {
    if (id === ctx.user.id) return send(ctx.res, 403, messagePage(ctx, 'Forbidden', 'You cannot delete your own account.'));
    const deleted = await store.transaction(async (tx) => {
      if (!(await tx.lockAdmins()).includes(ctx.user.id)) throw new HttpError(403, 'Forbidden');
      return tx.deleteUser(id);
    });
    if (!deleted) return notFound(ctx);
    return redirect(ctx.res, `${base}/?ok=deleted`);
  }

  const showAccount = (ctx, errors = [], status = 200) =>
    send(ctx.res, status, accountPage(ctx, { errors, server: serverInfo(ctx.req) }, status === 200 ? flashOf(ctx.url) : null));

  async function changePassword(ctx) {
    const f = ctx.form;
    const next = f.get('password') ?? '';
    const errors = passwordErrors(next, f.get('confirm') ?? '');
    // Goes through the shared limiter so a stolen session cannot be used to guess the current password.
    const verified = await auth.verifyLogin(ctx.user.username, f.get('current') ?? '', auth.clientIp(ctx.req));
    if (!verified) errors.unshift('Current password is incorrect.');
    if (errors.length) return showAccount(ctx, errors, 400);

    await store.updateUser(ctx.user.id, { passwordHash: await hashPassword(next) });
    const cookie = sessionCookie(ctx.req, sessions.issue(await store.getUserById(ctx.user.id)), sessions.maxAge);
    return redirect(ctx.res, `${base}/account?ok=password`, { 'Set-Cookie': cookie });
  }

  // ---- routing -------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.slice(base.length) || '/';
    const { method } = req;
    const posting = method === 'POST';

    if (path === '/static/admin.css') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed', { headers: { Allow: 'GET, HEAD' } });
      return send(res, 200, CSS, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    if (!posting && method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'Method Not Allowed', { headers: { Allow: 'GET, HEAD, POST' } });
    }
    if (posting && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin request rejected');

    const session = await getSession(req);
    if (path === '/login') {
      if (posting) return login(req, res);
      return session ? redirect(res, `${base}/`) : send(res, 200, loginPage({ base }));
    }
    if (!session) return redirect(res, `${base}/login`);

    const ctx = { req, res, url, base, user: session.user, csrf: session.csrf, form: null };
    if (posting) {
      ctx.form = await readForm(req);
      if (!sessions.checkCsrf(session.value, ctx.form.get('_csrf'))) throw new HttpError(403, 'Invalid or missing CSRF token');
    }

    if (path === '/logout') {
      if (!posting) throw new HttpError(405, 'Method Not Allowed', { headers: { Allow: 'POST' } });
      return redirect(res, `${base}/login`, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (path === '/account') return posting ? changePassword(ctx) : showAccount(ctx);
    if (path === '/') return ctx.user.is_admin ? showUsers(ctx) : redirect(res, `${base}/account`);

    if (!ctx.user.is_admin) return send(res, 403, messagePage(ctx, 'Forbidden', 'Administrator access is required.'));
    if (path === '/users') return posting ? createUser(ctx) : redirect(res, `${base}/`);
    if (path === '/users/new') return showNewUser(ctx);
    const m = /^\/users\/(\d{1,9})(\/delete)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      if (m[2]) return posting ? deleteUser(ctx, id) : showDelete(ctx, id);
      return posting ? updateUser(ctx, id) : showEdit(ctx, id);
    }
    throw new HttpError(404, 'Not Found');
  }

  function fail(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const plain = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (err instanceof HttpError) return send(res, err.status, `${err.message}\n`, { ...plain, ...err.headers });
    console.error(err);
    return send(res, 500, 'Internal Server Error\n', plain);
  }

  return {
    matches(requestUrl) {
      const pathname = requestUrl.split('?', 1)[0];
      return pathname === base || pathname.startsWith(`${base}/`);
    },
    async handle(req, res) {
      const started = performance.now();
      if (config.logRequests) {
        res.on('finish', () => {
          const ms = (performance.now() - started).toFixed(1);
          console.log(`${new Date().toISOString()} ${auth.clientIp(req)} admin ${req.method} ${JSON.stringify(req.url.split('?', 1)[0])} ${res.statusCode} ${ms}ms`);
        });
      }
      try {
        await route(req, res);
      } catch (err) {
        fail(res, err);
      }
    },
  };
}
