// The Bassapps sign-in service: its rules (sign-in, limits, codes, sessions, apps) and its HTTP API
// on a real port, as an app sees it (docs/joining.md). Mail's side is tested in the Mail repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { DoorDb } from '../src/doorDb.ts';
import { Door, Locked, NoAccess, PassphraseError } from '../src/door.ts';
import { createDoorServer } from '../src/server.ts';
import { computerName, shownAddress } from '../src/computer.ts';

const PASS = 'correct horse battery staple';
const MIN = 60_000;
const DAY = 86_400_000;

async function setup() {
    let now = Date.parse('2026-11-08T12:00:00Z');
    const clock = { advance: (ms: number) => { now += ms; } };
    const db = new DoorDb(':memory:');
    const door = new Door(db, crypto.randomBytes(32), { now: () => now });
    await door.createUser('owner', PASS);
    return { door, clock, db };
}

test('door: signing in, the known-computer mark, and no telling which part was wrong', async () => {
    const { door } = await setup();
    assert.equal(await door.signIn({ username: 'owner', passphrase: 'wrong passphrase!', ip: '203.0.113.1' }), null);
    assert.equal(await door.signIn({ username: 'nobody', passphrase: PASS, ip: '203.0.113.1' }), null, 'an unknown username fails the same way');
    const first = await door.signIn({ username: 'Owner', passphrase: PASS, ip: '203.0.113.1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' });
    assert.ok(first && first.newComputer, 'a computer without the mark is new (the email goes)');
    assert.equal(first.user.username, 'owner');
    const again = await door.signIn({ username: 'owner', passphrase: PASS, ip: '203.0.113.1', mark: first.knownMark });
    assert.ok(again && !again.newComputer, 'with the mark it is known');
    assert.equal(door.isKnown(first.knownMark, 'someone-else'), false, 'the mark is for one username');
    assert.equal(door.isKnown(first.knownMark.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), 'owner'), false, 'a changed mark is refused');
    assert.deepEqual(computerName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'), { name: 'Safari on macOS', kind: 'laptop' });
    assert.deepEqual(computerName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0'), { name: 'Firefox on Windows', kind: 'desktop' });
    assert.deepEqual(['::1', '127.0.0.1', '198.51.100.77', null].map(shownAddress), ['localhost', 'localhost', '198.51.100.77', null]);
});

test('door: limits on attempts (per IP address; per username from unknown computers only)', async () => {
    const { door, clock } = await setup();
    for (let i = 0; i < 10; i++) assert.equal(await door.signIn({ username: 'owner', passphrase: `wrong ${i}xxxxxxxx`, ip: '198.51.100.7' }), null);
    await assert.rejects(door.signIn({ username: 'owner', passphrase: PASS, ip: '198.51.100.7' }), (err: unknown) => err instanceof Locked && err.retryAfterSeconds > 0 && err.retryAfterSeconds <= 900);
    assert.ok(await door.signIn({ username: 'owner', passphrase: PASS, ip: '203.0.113.9' }), 'another address is not held by that one');
    clock.advance(15 * MIN + 1000);
    assert.ok(await door.signIn({ username: 'owner', passphrase: PASS, ip: '198.51.100.7' }), 'after 15 minutes the address may try again');

    const known = (await door.signIn({ username: 'owner', passphrase: PASS, ip: '203.0.113.9' }))!.knownMark;
    clock.advance(61 * MIN); // past the username's hour (the 10 failures above count toward it)
    // 20 failures from 20 addresses, all from computers that never signed in
    for (let i = 0; i < 20; i++) await door.signIn({ username: 'owner', passphrase: 'wrong-wrong-wrong', ip: `192.0.2.${i}` });
    await assert.rejects(door.signIn({ username: 'owner', passphrase: PASS, ip: '192.0.2.200' }), (err: unknown) => err instanceof Locked && err.retryAfterSeconds <= 3600);
    assert.ok(await door.signIn({ username: 'owner', passphrase: PASS, ip: '203.0.113.50', mark: known }), 'a computer that signed in before is not held by the username limit');
    const log = door.signIns('owner');
    assert.ok(log.some(r => !r.ok) && log.some(r => r.ok), 'Recent sign-ins has both');
});

test('door: one-time codes, app tokens, and why a session ended', async () => {
    const { door, clock } = await setup();
    const signIn = async (ip: string) => (await door.signIn({ username: 'owner', passphrase: PASS, ip }))!;
    const a = await signIn('203.0.113.1');
    const code = door.issueCode(a.sessionId, 'mail');
    assert.equal(door.exchange(code, 'tasks'), null, 'a code is for one app');
    const codeB = door.issueCode(a.sessionId, 'mail');
    const got = door.exchange(codeB, 'mail')!;
    assert.equal(got.user.username, 'owner');
    assert.equal(door.exchange(codeB, 'mail'), null, 'once only');
    const late = door.issueCode(a.sessionId, 'mail');
    clock.advance(2 * MIN);
    assert.equal(door.exchange(late, 'mail'), null, 'within a minute');
    assert.equal(door.verifyApp(got.token).ok, true);
    assert.deepEqual(door.verifyApp('not-a-token'), { ok: false, reason: 'unknown' });

    // Used within 30 days it lasts; 30 days unused and it ends ('expired')
    clock.advance(29 * DAY);
    assert.equal(door.verifyApp(got.token).ok, true, 'used: pushed forward');
    clock.advance(29 * DAY);
    assert.equal(door.verifyApp(got.token).ok, true);
    clock.advance(30 * DAY + 1000);
    assert.deepEqual(door.verifyApp(got.token), { ok: false, reason: 'expired' });

    // Signed out from another computer's Account page, everywhere, by a passphrase change, here
    const tokenOn = (s: { sessionId: string }) => door.exchange(door.issueCode(s.sessionId, 'mail'), 'mail')!.token;
    const b = await signIn('203.0.113.2'); const c = await signIn('203.0.113.3'); const d = await signIn('203.0.113.4');
    const [tb, tc, td] = [tokenOn(b), tokenOn(c), tokenOn(d)];
    const user = b.user;
    door.signOutComputer(user.id, b.sessionId, 'removed');
    assert.deepEqual(door.verifyApp(tb), { ok: false, reason: 'removed' });
    const { signedOutOthers } = await door.changePassphrase({ user, keepSessionId: c.sessionId, current: PASS, next: 'a brand new passphrase', ip: null });
    assert.equal(signedOutOthers, 1, 'the other live computer (d) is signed out; this one stays');
    assert.deepEqual(door.verifyApp(td), { ok: false, reason: 'passphrase' });
    assert.equal(door.verifyApp(tc).ok, true);
    door.signOutApp(tc);
    assert.deepEqual(door.verifyApp(tc), { ok: false, reason: 'signed-out' });
    const e = await door.signIn({ username: 'owner', passphrase: 'a brand new passphrase', ip: '203.0.113.5' });
    const te = tokenOn(e!);
    assert.equal(door.signOutEverywhere(user.id), 1);
    assert.deepEqual(door.verifyApp(te), { ok: false, reason: 'everywhere' });
    assert.equal(door.computers(user.id).length, 0);

    // Ended sessions are kept 30 days (to say why), then go
    clock.advance(31 * DAY);
    door.cleanup();
    assert.deepEqual(door.verifyApp(te), { ok: false, reason: 'unknown' });
});

test('door: changing and resetting the passphrase', async () => {
    const { door } = await setup();
    const s = (await door.signIn({ username: 'owner', passphrase: PASS, ip: null }))!;
    await assert.rejects(door.changePassphrase({ user: s.user, keepSessionId: s.sessionId, current: 'not it at all', next: 'long enough passphrase', ip: null }),
        (err: unknown) => err instanceof PassphraseError && err.field === 'current' && err.message === "That isn't your current passphrase");
    await assert.rejects(door.changePassphrase({ user: s.user, keepSessionId: s.sessionId, current: PASS, next: 'too short', ip: null }),
        (err: unknown) => err instanceof PassphraseError && err.field === 'next' && err.message === 'Use at least 12 characters. This has 9');
    const reset = await door.resetPassphrase('owner', 'reset on the server itself');
    assert.deepEqual(reset, { created: false, signedOut: 1 });
    assert.equal(await door.signIn({ username: 'owner', passphrase: PASS, ip: null }), null);
    assert.ok(await door.signIn({ username: 'owner', passphrase: 'reset on the server itself', ip: null }));
    await assert.rejects(door.resetPassphrase('owner', 'short'), /at least 12/);
    // The mail app's existing login moves over with its hash (the same passphrase signs in)
    door.importUser('moved', bcrypt.hashSync('an old eight', 10));
    assert.ok(await door.signIn({ username: 'moved', passphrase: 'an old eight', ip: null }), 'an older, shorter passphrase keeps working until it is changed');
});

test('door: which apps a login may use', async () => {
    const { door } = await setup();
    const owner = (await door.signIn({ username: 'owner', passphrase: PASS, ip: null }))!;
    assert.equal(door.appsOf(owner.user.id), '*', 'the first login may use every app');
    await door.createUser('guest', 'a guest passphrase');
    door.setApps('guest', ['tasks']);
    const guest = (await door.signIn({ username: 'guest', passphrase: 'a guest passphrase', ip: null }))!;
    assert.throws(() => door.issueCode(guest.sessionId, 'mail'), (err: unknown) => err instanceof NoAccess && err.app === 'mail', 'no code for an app it may not use');
    const tasks = door.exchange(door.issueCode(guest.sessionId, 'tasks'), 'tasks')!;
    assert.equal(door.verifyApp(tasks.token).ok, true);
    // Taken away later: its app token stops working, and says why
    door.setApps('guest', []);
    assert.deepEqual(door.verifyApp(tasks.token), { ok: false, reason: 'no-access' });
    const mail = door.exchange(door.issueCode(owner.sessionId, 'mail'), 'mail')!;
    assert.equal(door.verifyApp(mail.token).ok, true, 'the owner is untouched');
});

/** The sign-in service on a real port, with one app (Mail) listed, talked to as an app does. */
async function service() {
    const { door } = await setup();
    const secret = crypto.randomBytes(16).toString('hex');
    const notices: { computer: string }[] = [];
    const server = createDoorServer({
        door, apps: [{ id: 'mail', name: 'Mail', url: 'https://mail.example' }], publicUrl: 'http://door.test', cookieName: 'door', knownCookieName: 'known',
        secureCookies: false, trustProxy: false, internalSecret: secret, notifyNewComputer: async info => { notices.push(info); },
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, cookie = '') => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const internal = (path: string, body?: unknown, key = secret) => fetch(origin + path, body === undefined
        ? { headers: { 'X-Door-Secret': key } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Door-Secret': key }, body: JSON.stringify(body) });
    return { door, origin, post, internal, notices, close: () => server.close() };
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));

test('the service, as an app sees it: sign in, a code back to the app, its token, and why it ended', async () => {
    const f = await service();
    try {
        assert.equal((await f.post('/door-api/sign-in', { username: 'owner', passphrase: 'nope nope nope' })).status, 401);
        const forged = await fetch(f.origin + '/door-api/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
        assert.equal(forged.status, 403, 'another site cannot post');

        // Signing in from Mail: back to Mail's callback with a one-time code, the state and the way back
        const ok = await f.post('/door-api/sign-in', { username: 'owner', passphrase: PASS, app: 'mail', state: 's1', return: '/?thread=abc' });
        assert.equal(ok.status, 200);
        const back = new URL((await ok.json()).redirect);
        assert.equal(`${back.origin}${back.pathname}`, 'https://mail.example/api/v2/auth/callback');
        assert.deepEqual([back.searchParams.get('state'), back.searchParams.get('return')], ['s1', '/?thread=abc']);
        assert.equal(f.notices.length, 1, 'a new computer: the new sign-in email goes');
        const doorCookies = cookiesOf(ok).join('; ');
        // Never back to another site: "//x" and "/\x" read as one
        for (const elsewhere of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
            const r = await (await f.post('/door-api/continue', { app: 'mail', state: 's', return: elsewhere }, doorCookies)).json();
            assert.equal(new URL(r.redirect).searchParams.get('return'), '/', elsewhere);
        }

        // The app swaps the code for its own token (once), and checks it with each use
        assert.equal((await f.internal('/internal/v1/exchange', { code: back.searchParams.get('code'), app: 'mail' }, 'wrong secret')).status, 403, 'only with the secret');
        const got = await (await f.internal('/internal/v1/exchange', { code: back.searchParams.get('code'), app: 'mail' })).json();
        assert.equal(got.user.username, 'owner');
        assert.equal((await f.internal('/internal/v1/exchange', { code: back.searchParams.get('code'), app: 'mail' })).status, 400, 'once only');
        const verified = await (await f.internal('/internal/v1/verify', { token: got.token })).json();
        assert.deepEqual([verified.ok, verified.user.username, verified.apps], [true, 'owner', ['mail']]);
        assert.deepEqual((await (await f.internal('/internal/v1/apps')).json()).apps.map((a: { id: string }) => a.id), ['mail']);

        // Sign out everywhere, from another computer: Mail hears "everywhere"; the one that did it, "signed-out"
        const other = await f.post('/door-api/sign-in', { username: 'owner', passphrase: PASS });
        const otherCookies = cookiesOf(other).join('; ');
        assert.equal((await f.post('/door-api/sign-out-everywhere', {}, otherCookies)).status, 200);
        assert.deepEqual(await (await f.internal('/internal/v1/verify', { token: got.token })).json(), { ok: false, reason: 'everywhere' });
        assert.deepEqual(f.door.session(otherCookies.split('; ').find(c => c.startsWith('door='))!.slice(5)), { reason: 'signed-out' });

        // A login that may not use Mail: signed in, but no way into Mail
        await f.door.createUser('guest', 'a guest passphrase');
        f.door.setApps('guest', []);
        const guest = await f.post('/door-api/sign-in', { username: 'guest', passphrase: 'a guest passphrase', app: 'mail', state: 's2' });
        assert.deepEqual([guest.status, (await guest.json()).error], [403, 'no-access']);
        const guestStatus = await (await fetch(f.origin + '/door-api/status', { headers: { Cookie: cookiesOf(guest).join('; ') } })).json();
        assert.deepEqual([guestStatus.signedIn, guestStatus.apps], [true, []], 'its apps menu lists nothing it may not use');

        // Too many attempts: 429 with Retry-After
        let last: Response | null = null;
        for (let i = 0; i < 11; i++) last = await f.post('/door-api/sign-in', { username: 'owner', passphrase: `wrong ${i} passphrase` });
        assert.equal(last!.status, 429);
        assert.ok(Number(last!.headers.get('retry-after')) > 0);
    } finally {
        f.close();
    }
});
