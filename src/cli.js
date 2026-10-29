import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { hashPassword } from './auth.js';
import { USERNAME, passwordProblem } from './validate.js';

const USAGE = `Usage: npm run admin -- <command> [options]

Commands:
  user:add <username> [--password P] [--name N] [--email E] [--admin]
  user:passwd <username> [--password P]
  user:list
  user:delete <username>

If --password is omitted, it is read from stdin (piped) or prompted.`;

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Password: ');
  } finally {
    rl.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      password: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      admin: { type: 'boolean', default: false },
    },
  });
  const [command, username] = positionals;
  if (!command) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  let store;
  try {
    store = await Store.open(config.databaseUrl, { schema: config.dbSchema, poolSize: 2 });
    const needUser = async () => {
      if (!username) throw new Error('username required');
      const user = await store.getUserByName(username);
      if (!user) throw new Error(`no such user: ${username}`);
      return user;
    };
    const getPassword = async () => {
      const password = values.password ?? await readPassword();
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      return password;
    };
    switch (command) {
      case 'user:add': {
        if (!username || !USERNAME.test(username)) throw new Error('valid username required');
        if (await store.getUserByName(username)) throw new Error(`user already exists: ${username}`);
        const passwordHash = await hashPassword(await getPassword());
        await store.createUser({ username, passwordHash, displayName: values.name, email: values.email, isAdmin: values.admin });
        console.log(`created user ${username.toLowerCase()}`);
        return 0;
      }
      case 'user:passwd': {
        const user = await needUser();
        await store.updateUser(user.id, { passwordHash: await hashPassword(await getPassword()) });
        console.log(`password updated for ${user.username}`);
        return 0;
      }
      case 'user:list':
        for (const u of await store.listUsers()) console.log(`${u.username}\t${u.display_name}\t${u.email ?? ''}\t${u.is_admin ? 'admin' : ''}`);
        return 0;
      case 'user:delete': {
        const user = await needUser();
        await store.deleteUser(user.id);
        console.log(`deleted user ${user.username}`);
        return 0;
      }
      default:
        console.error(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  } finally {
    await store?.close();
  }
}

process.exitCode = await main();
