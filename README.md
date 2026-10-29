# nodedav

A small CalDAV / CardDAV server for Node.js 24+, in the spirit of sabre/dav and Baïkal.
Stores data in PostgreSQL 18. The only runtime dependency is the `pg` driver; HTTP, XML parsing, iCalendar/vCard handling and password hashing use Node built-ins and in-repo code.

## Quick start

```sh
docker compose up -d db        # PostgreSQL 18 on 127.0.0.1:5432 (or point DATABASE_URL at your own server)
npm install
npm run admin -- user:add alice --name "Alice" --email alice@example.com   # prompts for a password
npm start                                                                    # http://127.0.0.1:8800/dav/
npm test                                                                     # needs the database above (TEST_DATABASE_URL to override)
```

Each new user gets a `default` calendar and a `default` address book.

Users can be managed in the web UI at `http://127.0.0.1:8800/admin/` (see [Admin UI](#admin-ui)). To get the first admin without the CLI, start with `ADMIN_USERNAME` and `ADMIN_PASSWORD` set.

### Client URLs

| Client             | URL                                               |
| ------------------ | ------------------------------------------------- |
| Auto-discovery     | `https://host/` (`/.well-known/caldav`, `/.well-known/carddav` redirect to `/dav/`) |
| Principal          | `/dav/principals/<user>/`                         |
| Calendars          | `/dav/calendars/<user>/<calendar>/`               |
| Address books      | `/dav/addressbooks/<user>/<book>/`                |

Run it behind a TLS-terminating reverse proxy: HTTP Basic credentials are sent on every request.

## Configuration (environment variables)

| Variable            | Default                | Meaning                                                    |
| ------------------- | ---------------------- | ---------------------------------------------------------- |
| `HOST`              | `127.0.0.1`            | Bind address (`0.0.0.0` in Docker)                         |
| `PORT`              | `8800`                 | Port                                                       |
| `DATABASE_URL`      | `postgres://nodedav:nodedav@127.0.0.1:5432/nodedav` | PostgreSQL connection string        |
| `DB_SCHEMA`         | (server default)       | Optional schema to keep the tables in (created if missing) |
| `DB_POOL_SIZE`      | `10`                   | Max PostgreSQL connections                                 |
| `BASE_PATH`         | `/dav`                 | URL prefix of the DAV tree (`/` to serve at the root)      |
| `AUTH_REALM`        | `nodedav`              | Basic auth realm                                           |
| `MAX_RESOURCE_SIZE` | `10485760`             | Max size of one calendar object / vCard in bytes           |
| `QUOTA_BYTES`       | `0` (unlimited)        | Per-user storage quota (RFC 4331); writes beyond it get 507 |
| `LOCK_TIMEOUT_DEFAULT` / `LOCK_TIMEOUT_MAX` | `3600` / `86400` | WebDAV lock timeout in seconds (default and ceiling) |
| `MIN_DATE_TIME` / `MAX_DATE_TIME` | `00010101T000000Z` / `99991231T235959Z` | Range advertised and enforced for calendar objects |
| `MAX_INSTANCES` / `MAX_ATTENDEES` | `0` (unlimited) | Limits per calendar object (`max-instances`, `max-attendees-per-instance`) |
| `TRUST_PROXY`       | `false`                | Use the right-most `X-Forwarded-For` for rate limiting     |
| `LOG_REQUESTS`      | `true`                 | Access log on stdout                                       |
| `ADMIN_UI`          | `true`                 | Set to `false` to disable the web admin UI                 |
| `ADMIN_PATH`        | `/admin`               | URL prefix of the admin UI (must differ from `BASE_PATH`)  |
| `SESSION_SECRET`    | (random per start)     | Signs admin session cookies, min. 16 characters. Set it to keep logins across restarts and across several instances |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | (unset) | If both are set and there are no users yet, an admin is created on startup |

## Admin UI

Open `/admin/` and sign in as an administrator. Administrators can list, create, edit (name, email, password, admin role) and delete users, and see each user's calendars and address books with item counts. Every user, admin or not, gets an Account page with a password change form and connection instructions for iPhone/iPad, macOS and DAVx5.

- Server-rendered HTML, no JavaScript. Sessions are signed, HttpOnly, SameSite=Strict cookies valid for 8 hours; changing a password signs out that user's other sessions.
- Forms carry a CSRF token and cross-site POSTs are rejected. Logins share the per-IP throttling used for DAV.
- You cannot delete yourself or remove your own admin role, and concurrent changes can never leave the system without an admin.
- The CLI below stays available for scripting and recovery.

## iPhone, iPad and macOS

The server implements what Apple's Calendar and Contacts clients use: `/.well-known/caldav` and `/.well-known/carddav` discovery, principal and home-set properties, `calendar-query`, `calendar-multiget`, `sync-collection`, ETags and MKCALENDAR. On iOS add a CalDAV account (Settings, Calendar, Accounts, Add Account, Other, Add CalDAV Account) and a CardDAV account for contacts, entering your host, username and password.

Caveats:

- iOS wants HTTPS on a standard port for account setup; run nodedav behind a TLS reverse proxy (and set `TRUST_PROXY=true` there).
- No scheduling: you cannot invite people or receive invitations through the server, and there is no sharing or push notification. Clients poll.
- This has been tested against the protocol (automated tests) but not yet on physical Apple devices.

## Admin CLI

```
npm run admin -- user:add <name> [--password P] [--name N] [--email E] [--admin]
npm run admin -- user:passwd <name>
npm run admin -- user:list
npm run admin -- user:delete <name>
```

Passwords are stored as scrypt hashes. Failed logins are limited to 10 per 10 minutes per client IP.

## RFC support

Tests: `node --test test/` (in-memory store) or `TEST_DATABASE_URL=postgres://... npm test` (PostgreSQL).

| RFC | Subject | Status |
| --- | ------- | ------ |
| 4918 | WebDAV class 1, 2, 3 (PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, `If`) | implemented |
| 5689 | Extended MKCOL | implemented |
| 9110 / 7232 | Conditional requests, `Range` | implemented |
| 7240 / 8144 | `Prefer` (`return=minimal`) | implemented |
| 4331 | Quota properties | implemented |
| 5995 | POST to add members | implemented |
| 3744 | ACL: ACL properties, `ACL` method, `principal-match`, `principal-property-search`, `principal-search-property-set`, `acl-principal-prop-set` | read-only: the ACL is fixed (owner), `ACL` requests are refused |
| 5397 | `current-user-principal` | implemented |
| 6578 | `sync-collection` | implemented |
| 4791 | CalDAV: MKCALENDAR, `calendar-query`, `calendar-multiget`, `free-busy-query`, `expand`, `limit-recurrence-set`, `limit-freebusy-set` (accepted, validated, not applied), partial data, all preconditions, collations | implemented |
| 6352 | CardDAV: `addressbook-query`, `addressbook-multiget`, vCard 3.0/4.0, `limit`, partial data | implemented |
| 6638 | CalDAV scheduling between users of this server: inbox/outbox, implicit scheduling, iTIP auto-processing, free-busy lookup, `SCHEDULE-STATUS` | implemented for local users |
| 6764 | Service discovery (`/.well-known/caldav`, `/.well-known/carddav`) | implemented |
| 7265 / 7095 | jCal / jCard: `Accept`, request bodies and `content-type` on `calendar-data` / `address-data` | implemented |
| 7809 | `CalDAV-Timezones: F`, `calendar-no-timezone`, `timezone-service-set` (empty) | implemented |
| 7953 | `calendar-availability` on the inbox, applied as `BUSY-UNAVAILABLE` in free-busy lookups | implemented (priority-ordered VAVAILABILITY, AVAILABLE recurrence) |

## Not implemented

- Scheduling with external users: attendees outside this server get `SCHEDULE-STATUS=5.3`, there is no iMIP (email) transport
- COPY/MOVE do not trigger implicit scheduling; there is no size cap on the scheduling inbox
- No group or resource calendar users (`calendar-user-type` is always `INDIVIDUAL`)
- ACL is fixed and read-only; principal searches only ever return the caller (users cannot see each other)
- Sharing (BIND RFC 5842, calendarserver sharing drafts), push notifications, subscriptions
- Managed attachments (RFC 8607), timezone service (RFC 7808), DeltaV (3253), SEARCH (5323), WebDAV Redirectrefs (4437), Ordered collections (3648)
- `VTODO`/`VJOURNAL` recurrence is stored but not expanded
- JSON and timezone-stripped representations share the stored ETag
- Floating times and all-day values are evaluated as UTC; unknown (non-IANA) TZIDs are treated as UTC
- RRULEs using BYHOUR/BYMINUTE/BYSECOND/BYWEEKNO/BYYEARDAY or HOURLY and finer are matched conservatively (the event is returned for any overlapping range)
- Per-IP login throttling and the credential cache are in-memory per process; admin sessions are stateless and cannot be revoked individually (change the password to sign a user out)

## Verification status

The PostgreSQL store (`src/store.js`, schema migrations, `getUserByEmail`) has not been run: `pg` was not installed and no PostgreSQL server was available while this was written. The test suite was run against the in-memory store only; the PostgreSQL-backed tests are skipped without `TEST_DATABASE_URL`.
