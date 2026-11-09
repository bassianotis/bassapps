// Runs the Bassapps sign-in service (one sign-in for a family of apps).
//   node bin/door.ts
// Environment:
//   DOOR_DATA_DIR      where door.sqlite, door.key (signs the "known computer" mark) and internal.key
//                      (the secret apps send) live. Back them up together. Default ./data (this repo)
//   DOOR_HOST, DOOR_PORT   where it listens (default 127.0.0.1:3102)
//   DOOR_PUBLIC_URL    its own address, as browsers see it (default http://localhost:5175); live,
//                      https://account.bassapps.net (also the link in the new sign-in email)
//   DOOR_APPS          the apps, as JSON: [{"id":"mail","name":"Mail","url":"https://mail.bassapps.net"}]
//   DOOR_COOKIE, DOOR_KNOWN_COOKIE   cookie names (two copies on one machine need different ones)
//   SECURE_COOKIES=1   when served over HTTPS
//   TRUST_PROXY=1      believe X-Forwarded-For (only behind your own proxy)
//   DOOR_STATIC        the built pages (dist-door), served in production
//   MAIL_INTERNAL_URL  where Mail listens (it sends the new sign-in email for the service)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DoorDb } from '../src/doorDb.ts';
import { Door } from '../src/door.ts';
import { createDoorServer, type DoorApp } from '../src/server.ts';
import { loadOrCreateKey } from '../src/secrets.ts';

const dataDir = process.env.DOOR_DATA_DIR ?? path.resolve(import.meta.dirname, '../../data');
const host = process.env.DOOR_HOST ?? '127.0.0.1';
const port = Number(process.env.DOOR_PORT ?? 3102);
const publicUrl = (process.env.DOOR_PUBLIC_URL ?? 'http://localhost:5175').replace(/\/$/, '');
const apps = JSON.parse(process.env.DOOR_APPS ?? '[{"id":"mail","name":"Mail","url":"http://localhost:5174"}]') as DoorApp[];
const mailInternal = process.env.MAIL_INTERNAL_URL ?? null;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
// Served over HTTPS (live), its address must be too: it's the link the new sign-in email gives
if (process.env.SECURE_COOKIES === '1' && !publicUrl.startsWith('https://')) {
    console.error(`DOOR_PUBLIC_URL must be the https:// address when SECURE_COOKIES=1 (got ${publicUrl})`);
    process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const db = new DoorDb(path.join(dataDir, 'door.sqlite'));
const door = new Door(db, loadOrCreateKey(path.join(dataDir, 'door.key')));
const internalSecret = internalKey(path.join(dataDir, 'internal.key'));
if (!door.hasUsers()) log('no one can sign in yet: run `bassapps reset-passphrase` to create the login');

/** The secret apps send to /internal (a file both can read; created on first run). */
function internalKey(file: string): string {
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    return fs.readFileSync(file, 'utf8').trim();
}

/** "Nov 7, 2026, 3:42 PM (Eastern Time)", in the server's time zone. */
function spelledOut(at: Date): string {
    const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longGeneric' }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
    return `${day}, ${time}${zone ? ` (${zone})` : ''}`;
}

const server = createDoorServer({
    door, apps, publicUrl,
    cookieName: process.env.DOOR_COOKIE ?? 'bassapps_door',
    knownCookieName: process.env.DOOR_KNOWN_COOKIE ?? 'bassapps_known',
    secureCookies: process.env.SECURE_COOKIES === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
    internalSecret,
    staticDir: process.env.DOOR_STATIC ? path.resolve(process.env.DOOR_STATIC) : undefined,
    log,
    // The new sign-in email (plain text; design: SignInEmail). Mail sends it, from your own account.
    notifyNewComputer: mailInternal ? async ({ at, computer, ip }) => {
        const text = [
            "A computer that hasn't signed in before just signed in to Bassapps.",
            '',
            `When: ${spelledOut(at)}`,
            `Computer: ${computer}`,
            `IP address: ${ip ?? 'unknown'}`,
            '',
            "If this was you, there's nothing to do.",
            '',
            "If it wasn't, change your passphrase now. That also signs out every other computer:",
            publicUrl,
            '',
            'Bassapps, at bassapps.net',
        ].join('\n');
        const res = await fetch(`${mailInternal}/internal/v1/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Door-Secret': internalSecret },
            body: JSON.stringify({ subject: 'New sign-in to Bassapps', text, fromName: 'Bassapps' }),
        });
        if (!res.ok) throw new Error(`Mail answered ${res.status}`);
        log(`new sign-in email sent (${computer})`);
    } : undefined,
});

door.cleanup();
setInterval(() => door.cleanup(), 60 * 60_000).unref();
server.listen(port, host, () => log(`sign-in service on http://${host}:${port} (${publicUrl}) for ${apps.map(a => a.name).join(', ')}`));

const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
