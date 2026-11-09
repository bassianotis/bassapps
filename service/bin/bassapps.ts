// The sign-in service's commands, run on the server itself (access to it is the proof).
//   node bin/bassapps.ts reset-passphrase [username]   asks for the passphrase (hidden), twice;
//                                                       creates the login if it doesn't exist yet,
//                                                       and signs out every computer
//   node bin/bassapps.ts import-user <username> <app.sqlite> [mail login]
//                                                       moves the mail app's login over (same passphrase);
//                                                       names which one when the mail app has several
//   node bin/bassapps.ts apps <username> [* | mail,tasks]
//                                                       shows, or sets, which apps a login may use
//                                                       ('*': every app)
// DOOR_DATA_DIR as for bin/door.ts. tools/bassapps runs this as `bassapps …`.
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { DoorDb } from '../src/doorDb.ts';
import { Door } from '../src/door.ts';
import { loadOrCreateKey } from '../src/secrets.ts';

const dataDir = process.env.DOOR_DATA_DIR ?? path.resolve(import.meta.dirname, '../../data');
const [command, ...args] = process.argv.slice(2);

/** Reads a line; hides what's typed when `hidden` and attached to a terminal. */
function ask(prompt: string, hidden: boolean): Promise<string> {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
        if (process.stdin.isTTY) process.stdout.write(prompt);
        if (hidden && process.stdin.isTTY) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
        rl.question('', answer => {
            rl.close();
            if (hidden && process.stdin.isTTY) process.stdout.write('\n');
            resolve(answer);
        });
    });
}

const db = new DoorDb(path.join(dataDir, 'door.sqlite'));
const door = new Door(db, loadOrCreateKey(path.join(dataDir, 'door.key')));
try {
    if (command === 'reset-passphrase') {
        const username = (args[0] ?? await ask('Username: ', false)).trim();
        const first = await ask('New passphrase: ', true);
        const second = process.stdin.isTTY ? await ask('Again: ', true) : first;
        if (first !== second) throw new Error('The two entries differ; nothing changed.');
        const { created, signedOut } = await door.resetPassphrase(username, first);
        console.log(created ? `Created the login "${username}".` : `Passphrase changed for "${username}". ${signedOut} computer${signedOut === 1 ? '' : 's'} signed out.`);
    } else if (command === 'import-user') {
        const [username, from, login] = args;
        if (!username || !from) throw new Error('usage: bassapps import-user <username> <app.sqlite> [mail login]');
        if (door.user(username)) throw new Error(`"${username}" already exists here`);
        const source = new DatabaseSync(from, { readOnly: true });
        const rows = source.prepare('SELECT identifier, password_hash FROM users').all() as { identifier: string; password_hash: string }[];
        source.close();
        const row = login ? rows.find(r => r.identifier === login) : rows.length === 1 ? rows[0] : undefined;
        if (!row) throw new Error(login ? `no login "${login}" in ${from}` : rows.length ? `${from} has ${rows.length} logins; name the one to move: import-user ${username} ${from} <mail login>` : `no login in ${from}`);
        door.importUser(username, row.password_hash);
        console.log(`Moved the login over as "${username}" (the same passphrase signs in).`);
    } else if (command === 'apps') {
        const [username, list] = args;
        const user = username ? door.user(username) : null;
        if (!user) throw new Error(username ? `no login "${username}"` : 'usage: bassapps apps <username> [* | mail,tasks]');
        if (list) door.setApps(username, list.trim() === '*' ? '*' : list.split(','));
        const apps = door.appsOf(user.id);
        console.log(`"${user.username}" may use: ${apps === '*' ? 'every app' : apps.length ? apps.join(', ') : 'no apps'}`);
    } else {
        console.log('usage: bassapps reset-passphrase [username] | bassapps import-user <username> <app.sqlite> [mail login] | bassapps apps <username> [* | mail,tasks]');
        process.exitCode = 1;
    }
} catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
} finally {
    db.close();
}
