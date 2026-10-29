import { html, raw, toString } from './html.js';

export const CSS = `
:root{--bg:#f6f7f9;--fg:#1b1f24;--muted:#5b6672;--card:#fff;--line:#d9dee4;--accent:#2457d6;--accent-fg:#fff;--danger:#c0392b;--ok:#1f7a3d;--warn-bg:#fdecea;--ok-bg:#e6f4ea}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ed;--muted:#9aa5b1;--card:#1c2025;--line:#2d343b;--accent:#6f9bff;--accent-fg:#0b1220;--danger:#ff7b6b;--ok:#4cc27a;--warn-bg:#3a1d1a;--ok-bg:#16301f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem;padding:.75rem 16px;background:var(--card);border-bottom:1px solid var(--line)}
.top nav{display:flex;gap:1rem;flex:1}
.brand{font-weight:700;color:var(--fg);text-decoration:none}
.who{color:var(--muted);margin-right:.5rem}
main{max-width:56rem;margin:0 auto;padding:1.5rem 16px 3rem}
h1{font-size:1.5rem;margin:0 0 1rem}
h2{font-size:1.15rem;margin:2rem 0 .75rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem 1.25rem}
.head{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
.head h1{margin:0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto}
.num{text-align:right}
.badge{display:inline-block;padding:0 .5rem;border-radius:999px;background:var(--accent);color:var(--accent-fg);font-size:.75rem}
label{display:block;font-weight:600;margin:1rem 0 .25rem}
label.check{display:flex;gap:.5rem;align-items:center;font-weight:400}
input[type=text],input[type=email],input[type=password]{width:100%;max-width:28rem;padding:.5rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
input[readonly]{opacity:.7}
.hint{color:var(--muted);font-size:.875rem;margin:.25rem 0 0}
.btn,button{font:inherit;cursor:pointer}
.btn{display:inline-block;padding:.45rem .9rem;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.link{background:none;border:0;color:var(--accent);padding:0;text-decoration:underline}
form.inline{display:flex;align-items:center}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;flex-wrap:wrap}
.flash,.errors{border-radius:6px;padding:.6rem .9rem;margin:0 0 1rem}
.flash{background:var(--ok-bg);color:var(--ok)}
.errors{background:var(--warn-bg);color:var(--danger)}
.errors ul{margin:0;padding-left:1.1rem}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);padding:.1rem .3rem;border-radius:4px;word-break:break-all}
.narrow{max-width:24rem;margin:3rem auto}
.danger-zone{border-color:var(--danger)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0}
dt{color:var(--muted)}
dd{margin:0}
`;

const layout = ({ base, user, csrf }, title, body, flash = null) => toString(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - nodedav</title>
<link rel="stylesheet" href="${base}/static/admin.css">
</head>
<body>
<header class="top">
<a class="brand" href="${base}/">nodedav</a>
${user ? html`<nav>${user.is_admin ? html`<a href="${base}/">Users</a>` : ''}<a href="${base}/account">Account</a></nav>
<form class="inline" method="post" action="${base}/logout"><input type="hidden" name="_csrf" value="${csrf}"><span class="who">${user.username}</span><button class="link">Sign out</button></form>` : ''}
</header>
<main>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${body}
</main>
</body>
</html>
`);

const errorList = (errors) => (errors?.length
  ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`
  : '');

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;
const formatDate = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function loginPage({ base }, { error = null, username = '' } = {}) {
  return layout({ base }, 'Sign in', html`
<div class="narrow card">
<h1>Sign in</h1>
${errorList(error ? [error] : [])}
<form method="post" action="${base}/login">
<label for="username">Username</label>
<input id="username" name="username" type="text" value="${username}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="actions"><button class="btn primary">Sign in</button></div>
</form>
</div>`);
}

export function messagePage(ctx, title, message) {
  return layout(ctx, title, html`<h1>${title}</h1><p>${message}</p><p><a href="${ctx.base}/">Back</a></p>`);
}

export function usersPage(ctx, users, flash) {
  const { base } = ctx;
  return layout(ctx, 'Users', html`
<div class="head"><h1>Users</h1><a class="btn primary" href="${base}/users/new">Add user</a></div>
<div class="table-wrap"><table>
<thead><tr><th>Username</th><th>Name</th><th>Email</th><th class="num">Calendars</th><th class="num">Address books</th><th>Created</th><th></th></tr></thead>
<tbody>${users.map((u) => html`<tr>
<td><a href="${base}/users/${u.id}">${u.username}</a> ${u.is_admin ? html`<span class="badge">admin</span>` : ''}</td>
<td>${u.display_name}</td>
<td>${u.email ?? ''}</td>
<td class="num">${u.calendars}</td>
<td class="num">${u.addressbooks}</td>
<td>${formatDate(u.created_at)}</td>
<td><a href="${base}/users/${u.id}">Edit</a></td>
</tr>`)}</tbody>
</table></div>`, flash);
}

/** mode: 'new' | 'edit'. values: { username, display_name, email, is_admin }. */
export function userFormPage(ctx, { mode, target = null, values, errors = [], collections = [] }, flash) {
  const { base, csrf } = ctx;
  const editing = mode === 'edit';
  const isSelf = editing && target.id === ctx.user.id;
  const action = editing ? `${base}/users/${target.id}` : `${base}/users`;
  return layout(ctx, editing ? target.username : 'Add user', html`
<div class="head"><h1>${editing ? target.username : 'Add user'}</h1><a href="${base}/">All users</a></div>
${errorList(errors)}
<form class="card" method="post" action="${action}">
${csrfField(csrf)}
<label for="username">Username</label>
<input id="username" name="username" type="text" value="${values.username}" autocapitalize="none" spellcheck="false" maxlength="64" pattern="[A-Za-z0-9._@+\\-]{1,64}" ${editing ? raw('readonly') : raw('required autofocus')}>
${editing ? '' : html`<p class="hint">Letters, digits and . _ @ + - only. Stored in lower case.</p>`}
<label for="display_name">Display name</label>
<input id="display_name" name="display_name" type="text" value="${values.display_name}" maxlength="128">
<label for="email">Email</label>
<input id="email" name="email" type="email" value="${values.email}" maxlength="254">
<label for="password">${editing ? 'New password' : 'Password'}</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" ${editing ? '' : raw('required')}>
${editing ? html`<p class="hint">Leave blank to keep the current password.</p>` : ''}
<label for="confirm">Confirm password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" ${editing ? '' : raw('required')}>
<label class="check"><input type="checkbox" name="is_admin" ${values.is_admin ? raw('checked') : ''} ${isSelf ? raw('disabled') : ''}> Administrator</label>
${isSelf ? html`<p class="hint">You cannot remove your own administrator role.</p>` : ''}
<div class="actions"><button class="btn primary">${editing ? 'Save changes' : 'Create user'}</button><a class="btn" href="${base}/">Cancel</a></div>
</form>
${editing ? html`
<h2>Calendars and address books</h2>
${collections.length ? html`<div class="table-wrap"><table>
<thead><tr><th>Type</th><th>Name</th><th>URI</th><th class="num">Items</th></tr></thead>
<tbody>${collections.map((c) => html`<tr><td>${c.type === 'calendar' ? 'Calendar' : 'Address book'}</td><td>${c.displayname ?? ''}</td><td><code>${c.uri}</code></td><td class="num">${c.object_count}</td></tr>`)}</tbody>
</table></div>` : html`<p class="hint">None.</p>`}
${isSelf ? '' : html`<h2>Delete user</h2>
<div class="card danger-zone"><p>Permanently removes the user together with all of their calendars, address books and items.</p>
<a class="btn danger" href="${base}/users/${target.id}/delete">Delete user...</a></div>`}` : ''}`, flash);
}

export function deletePage(ctx, target, collections) {
  const { base, csrf } = ctx;
  const items = collections.reduce((sum, c) => sum + c.object_count, 0);
  return layout(ctx, `Delete ${target.username}`, html`
<h1>Delete ${target.username}?</h1>
<div class="card danger-zone">
<p>This permanently deletes the user and ${plural(collections.length, 'calendar or address book', 'calendars and address books')} holding ${plural(items, 'item', 'items')}. It cannot be undone.</p>
<form method="post" action="${base}/users/${target.id}/delete">
${csrfField(csrf)}
<div class="actions"><button class="btn danger">Delete ${target.username}</button><a class="btn" href="${base}/users/${target.id}">Cancel</a></div>
</form>
</div>`);
}

export function accountPage(ctx, { errors = [], server }, flash) {
  const { base, csrf, user } = ctx;
  return layout(ctx, 'Account', html`
<h1>Account</h1>
<dl class="card">
<dt>Username</dt><dd>${user.username}</dd>
<dt>Name</dt><dd>${user.display_name}</dd>
<dt>Email</dt><dd>${user.email ?? '-'}</dd>
</dl>
<h2>Change password</h2>
${errorList(errors)}
<form class="card" method="post" action="${base}/account">
${csrfField(csrf)}
<label for="current">Current password</label>
<input id="current" name="current" type="password" autocomplete="current-password" required>
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required>
<label for="confirm">Confirm new password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required>
<div class="actions"><button class="btn primary">Change password</button></div>
</form>
<h2>Connect a device</h2>
<div class="card">
<dl>
<dt>Server</dt><dd><code>${server.host}</code></dd>
<dt>Full URL</dt><dd><code>${server.url}</code></dd>
<dt>Username</dt><dd><code>${user.username}</code></dd>
</dl>
<p><strong>iPhone / iPad:</strong> Settings, Calendar, Accounts, Add Account, Other, <em>Add CalDAV Account</em>. Enter the server, your username and password. For contacts use Settings, Contacts, Accounts, Add Account, Other, <em>Add CardDAV Account</em>.</p>
<p><strong>macOS:</strong> System Settings, Internet Accounts, Add Other Account, <em>CalDAV</em> or <em>CardDAV</em>, account type Manual, and use the full URL.</p>
<p><strong>Android (DAVx5) and others:</strong> use the full URL as the base URL.</p>
${server.secure ? '' : html`<p class="hint">This connection is not encrypted. iPhones and iPads expect HTTPS, so put nodedav behind a TLS-terminating reverse proxy.</p>`}
</div>`, flash);
}
