// Bassapps sign-in: one account for a family of apps, following OWASP's
// authentication and session guidance.
// - Passphrases are bcrypt hashes (the mail app's existing hash imports unchanged).
// - Each computer (browser) gets a session: a random 256-bit token in the sign-in service's own
//   cookie, of which only a SHA-256 is stored. It lasts while it's used: 30 days unused and it ends.
// - An app gets its own token, tied to that session, through a one-time code (like an OAuth
//   authorization code), and checks it with this service whenever it's used. When a session has
//   ended, the service says why (expired, signed out everywhere, ...), so the app can say so.
// - Limits on attempts: 10 failures from one IP address in 15 minutes, and 20 failures for one
//   username in an hour from computers that have never signed in. A computer that has signed in
//   before carries a signed mark (a cookie that survives signing out) and isn't held by the username
//   limit, so a stranger can't lock you out of your own computers (OWASP's "device cookies").
// - A wrong username costs the same as a wrong passphrase, and the answer never says which it was.
// - Each login may use some apps or every one ('*'), checked whenever an app is handed a code, swaps
//   it, or asks who someone is: a login without that app never gets a session in it.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { DoorDb } from './doorDb.ts';

/** Why a session ended: it went unused, it was signed out here, from another computer's Account
 * page, by "Sign out everywhere", or by a passphrase change (or reset). */
export type EndReason = 'expired' | 'signed-out' | 'removed' | 'everywhere' | 'passphrase';

export interface DoorUser {
    id: string;
    username: string;
}

const DAY = 86_400_000;
export const SESSION_IDLE_MS = 30 * DAY;
const TOUCH_EVERY_MS = 60 * 60_000;
const CODE_MS = 60_000;
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX = 10;
const USER_WINDOW_MS = 60 * 60_000;
const USER_MAX = 20;
/** Ended sessions are kept this long, so an app still open on that computer can say why. */
const KEEP_ENDED_MS = 30 * DAY;
const KEEP_SIGNINS_MS = 30 * DAY;
const KNOWN_FOR_MS = 365 * DAY;
export const MIN_PASSPHRASE = 12;
// The mail app's setting: its imported hash uses it, and a check stays fast on the Pi's CPU.
const BCRYPT_ROUNDS = 10;

export class Locked extends Error {
    readonly retryAfterSeconds: number;
    constructor(retryAfterSeconds: number) {
        super('too many attempts');
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** This login may not use that app. */
export class NoAccess extends Error {
    readonly app: string;
    constructor(app: string) {
        super(`no access to ${app}`);
        this.app = app;
    }
}

export class PassphraseError extends Error {
    readonly field: 'current' | 'next';
    constructor(field: 'current' | 'next', message: string) {
        super(message);
        this.field = field;
    }
}

let dummyHash: string | null = null;
const dummy = () => (dummyHash ??= bcrypt.hashSync('not-a-real-passphrase', BCRYPT_ROUNDS));
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const tooShort = (passphrase: string) => `Use at least ${MIN_PASSPHRASE} characters. This has ${[...passphrase].length}`;

interface SessionRow {
    id: string;
    user_id: string;
    username: string;
    created_at: string;
    last_seen_at: string;
    ended_at: string | null;
    end_reason: EndReason | null;
}

export type Alive = { user: DoorUser; sessionId: string } | { reason: EndReason };

export class Door {
    private readonly store: DoorDb;
    private readonly key: Buffer;
    private readonly now: () => number;

    constructor(store: DoorDb, key: Buffer, options: { now?: () => number } = {}) {
        this.store = store;
        this.key = key;
        this.now = options.now ?? Date.now;
    }

    private get db() {
        return this.store.db;
    }

    private iso(ms = this.now()): string {
        return new Date(ms).toISOString();
    }

    hasUsers(): boolean {
        return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
    }

    user(username: string): (DoorUser & { hash: string }) | null {
        const row = this.db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username.trim()) as
            { id: string; username: string; password_hash: string } | undefined;
        return row ? { id: row.id, username: row.username, hash: row.password_hash } : null;
    }

    async createUser(username: string, passphrase: string): Promise<DoorUser> {
        if (!/^[a-z0-9._-]{1,40}$/i.test(username.trim())) throw new Error('a username is letters, digits, dots, dashes or underscores (up to 40)');
        if ([...passphrase].length < MIN_PASSPHRASE) throw new Error(tooShort(passphrase));
        return this.importUser(username, await bcrypt.hash(passphrase, BCRYPT_ROUNDS));
    }

    /** Keeps an existing bcrypt hash (moving the mail app's login over unchanged). */
    importUser(username: string, passwordHash: string): DoorUser {
        const user = { id: crypto.randomUUID(), username: username.trim() };
        this.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
            .run(user.id, user.username, passwordHash, this.iso());
        return user;
    }

    /** The reset command (on the server only): sets the passphrase, creating the user if need be,
     * and signs out every computer. */
    async resetPassphrase(username: string, passphrase: string): Promise<{ created: boolean; signedOut: number }> {
        if ([...passphrase].length < MIN_PASSPHRASE) throw new Error(tooShort(passphrase));
        const user = this.user(username);
        if (!user) {
            await this.createUser(username, passphrase);
            return { created: true, signedOut: 0 };
        }
        this.db.prepare('UPDATE users SET password_hash = ?, passphrase_changed_at = ? WHERE id = ?').run(await bcrypt.hash(passphrase, BCRYPT_ROUNDS), this.iso(), user.id);
        return { created: false, signedOut: this.endAll(user.id, 'passphrase') };
    }

    // ---- which apps a login may use

    /** Every app ('*'), or the ids of the ones this login may use. */
    appsOf(userId: string): '*' | string[] {
        const row = this.db.prepare('SELECT apps FROM users WHERE id = ?').get(userId) as { apps: string } | undefined;
        if (!row) return [];
        return row.apps === '*' ? '*' : row.apps.split(',').map(a => a.trim()).filter(Boolean);
    }

    mayUse(userId: string, app: string): boolean {
        const apps = this.appsOf(userId);
        return apps === '*' || apps.includes(app);
    }

    /** Sets a login's apps (the `bassapps apps` command); false when there's no such login. */
    setApps(username: string, apps: '*' | string[]): boolean {
        const value = apps === '*' ? '*' : [...new Set(apps.map(a => a.trim()).filter(Boolean))].join(',');
        return Number(this.db.prepare('UPDATE users SET apps = ? WHERE username = ?').run(value, username.trim()).changes) > 0;
    }

    // ---- the "known computer" mark: <username>.<issued>.<HMAC>, kept a year, survives signing out

    knownMark(username: string): string {
        const name = Buffer.from(username.toLowerCase()).toString('base64url');
        const issued = String(this.now());
        return `${name}.${issued}.${this.sign(`${name}.${issued}`)}`;
    }

    isKnown(mark: string | undefined, username: string): boolean {
        const [name, issued, mac] = (mark ?? '').split('.');
        if (!name || !issued || !mac) return false;
        const expected = Buffer.from(this.sign(`${name}.${issued}`));
        const given = Buffer.from(mac);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
        if (this.now() - Number(issued) > KNOWN_FOR_MS) return false;
        return Buffer.from(name, 'base64url').toString() === username.trim().toLowerCase();
    }

    private sign(value: string): string {
        return crypto.createHmac('sha256', this.key).update(`known:${value}`).digest('base64url');
    }

    // ---- signing in

    /** Seconds until this IP address (and, from an unknown computer, this username) may try again. */
    retryAfter(ip: string | null, username: string, known: boolean): number | null {
        const now = this.now();
        // With n failures in the window (oldest first), the count drops below the limit when the
        // one at n - limit leaves it.
        const wait = (ats: number[], max: number, windowMs: number) => (ats.length >= max ? ats[ats.length - max] + windowMs - now : 0);
        let ms = 0;
        if (ip) {
            const ats = (this.db.prepare('SELECT at FROM signins WHERE ip = ? AND ok = 0 AND counted = 1 AND at > ? ORDER BY at')
                .all(ip, this.iso(now - IP_WINDOW_MS)) as { at: string }[]).map(r => Date.parse(r.at));
            ms = Math.max(ms, wait(ats, IP_MAX, IP_WINDOW_MS));
        }
        if (!known) {
            const ats = (this.db.prepare('SELECT at FROM signins WHERE username = ? COLLATE NOCASE AND ok = 0 AND counted = 1 AND known = 0 AND at > ? ORDER BY at')
                .all(username, this.iso(now - USER_WINDOW_MS)) as { at: string }[]).map(r => Date.parse(r.at));
            ms = Math.max(ms, wait(ats, USER_MAX, USER_WINDOW_MS));
        }
        return ms > 0 ? Math.ceil(ms / 1000) : null;
    }

    private logAttempt(username: string, ip: string | null, userAgent: string | undefined, ok: boolean, known: boolean, counted: boolean): void {
        this.db.prepare('INSERT INTO signins (at, username, ip, user_agent, ok, known, counted) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(this.iso(), username, ip, userAgent?.slice(0, 300) ?? null, ok ? 1 : 0, known ? 1 : 0, counted ? 1 : 0);
    }

    /** Null when the username and passphrase don't match; Locked when there have been too many attempts. */
    async signIn(input: { username: string; passphrase: string; ip: string | null; userAgent?: string; mark?: string }):
        Promise<{ user: DoorUser; sessionToken: string; sessionId: string; knownMark: string; newComputer: boolean } | null> {
        const username = input.username.trim().slice(0, 100);
        const known = this.isKnown(input.mark, username);
        const wait = this.retryAfter(input.ip, username, known);
        if (wait !== null) {
            this.logAttempt(username, input.ip, input.userAgent, false, known, false);
            throw new Locked(wait);
        }
        const user = this.user(username);
        const ok = await bcrypt.compare(input.passphrase, user?.hash ?? dummy());
        if (!user || !ok) {
            this.logAttempt(username, input.ip, input.userAgent, false, known, true);
            return null;
        }
        this.logAttempt(user.username, input.ip, input.userAgent, true, known, false);
        const sessionToken = randomToken();
        const sessionId = crypto.randomUUID();
        this.db.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(sessionId, hash(sessionToken), user.id, this.iso(), this.iso(), input.userAgent?.slice(0, 300) ?? null, input.ip);
        return { user: { id: user.id, username: user.username }, sessionToken, sessionId, knownMark: this.knownMark(user.username), newComputer: !known };
    }

    // ---- sessions

    private alive(row: SessionRow): Alive {
        if (row.ended_at) return { reason: row.end_reason ?? 'signed-out' };
        const now = this.now();
        const last = Date.parse(row.last_seen_at);
        if (now - last >= SESSION_IDLE_MS) {
            this.endSession(row.id, 'expired');
            return { reason: 'expired' };
        }
        if (now - last > TOUCH_EVERY_MS) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(this.iso(now), row.id);
        return { user: { id: row.user_id, username: row.username }, sessionId: row.id };
    }

    /** The computer's session behind the sign-in service's own cookie. */
    session(sessionToken: string | undefined): Alive | null {
        if (!sessionToken) return null;
        const row = this.db.prepare(`SELECT s.id, s.user_id, u.username, s.created_at, s.last_seen_at, s.ended_at, s.end_reason
            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash(sessionToken)) as SessionRow | undefined;
        return row ? this.alive(row) : null;
    }

    endSession(sessionId: string, reason: EndReason): boolean {
        const changed = Number(this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(this.iso(), reason, sessionId).changes);
        this.db.prepare('DELETE FROM codes WHERE session_id = ?').run(sessionId);
        return changed > 0;
    }

    private endAll(userId: string, reason: EndReason, keep?: string): number {
        const live = this.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND ended_at IS NULL').all(userId) as { id: string }[];
        return live.filter(s => s.id !== keep && this.endSession(s.id, reason)).length;
    }

    // ---- apps: a one-time code on the way back from signing in, exchanged for the app's own token

    /** Throws NoAccess when the session's login may not use the app. */
    issueCode(sessionId: string, app: string): string {
        const owner = this.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as { user_id: string } | undefined;
        if (!owner || !this.mayUse(owner.user_id, app)) throw new NoAccess(app);
        const code = randomToken();
        this.db.prepare('INSERT INTO codes (code_hash, session_id, app, expires_at) VALUES (?, ?, ?, ?)').run(hash(code), sessionId, app, this.iso(this.now() + CODE_MS));
        return code;
    }

    exchange(code: string, app: string): { token: string; user: DoorUser } | null {
        const row = this.db.prepare('SELECT session_id, app, expires_at FROM codes WHERE code_hash = ?').get(hash(code)) as { session_id: string; app: string; expires_at: string } | undefined;
        if (!row) return null;
        this.db.prepare('DELETE FROM codes WHERE code_hash = ?').run(hash(code)); // once only
        if (row.app !== app || Date.parse(row.expires_at) <= this.now()) return null;
        const session = this.db.prepare(`SELECT s.id, s.user_id, u.username, s.created_at, s.last_seen_at, s.ended_at, s.end_reason
            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(row.session_id) as SessionRow | undefined;
        const alive = session && this.alive(session);
        if (!alive || 'reason' in alive || !this.mayUse(alive.user.id, app)) return null;
        const token = randomToken();
        this.db.prepare('INSERT INTO app_tokens (token_hash, session_id, app, created_at) VALUES (?, ?, ?, ?)').run(hash(token), alive.sessionId, app, this.iso());
        return { token, user: alive.user };
    }

    /** An app's token: whose it is, or why it no longer works ('unknown' when it never did,
     * 'no-access' when the login may no longer use that app). */
    verifyApp(token: string): ({ ok: true } & { user: DoorUser; sessionId: string }) | { ok: false; reason: EndReason | 'unknown' | 'no-access' } {
        const row = this.db.prepare(`SELECT s.id, s.user_id, u.username, s.created_at, s.last_seen_at, s.ended_at, s.end_reason, t.app
            FROM app_tokens t JOIN sessions s ON s.id = t.session_id JOIN users u ON u.id = s.user_id WHERE t.token_hash = ?`).get(hash(token)) as (SessionRow & { app: string }) | undefined;
        if (!row) return { ok: false, reason: 'unknown' };
        const alive = this.alive(row);
        if ('reason' in alive) return { ok: false, reason: alive.reason };
        return this.mayUse(alive.user.id, row.app) ? { ok: true, ...alive } : { ok: false, reason: 'no-access' };
    }

    /** "Sign out" in an app: this computer's session ends (and every app on it with it). */
    signOutApp(token: string): void {
        const row = this.db.prepare('SELECT session_id FROM app_tokens WHERE token_hash = ?').get(hash(token)) as { session_id: string } | undefined;
        if (row) this.endSession(row.session_id, 'signed-out');
    }

    // ---- Account

    computers(userId: string): { id: string; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string }[] {
        const since = this.iso(this.now() - SESSION_IDLE_MS);
        return (this.db.prepare(`SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions
            WHERE user_id = ? AND ended_at IS NULL AND last_seen_at > ? ORDER BY last_seen_at DESC`).all(userId, since) as
            { id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string }[])
            .map(r => ({ id: r.id, userAgent: r.user_agent, ip: r.ip, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
    }

    /** Signs one of the user's computers out ('removed' from another computer; 'signed-out' for this one). */
    signOutComputer(userId: string, sessionId: string, reason: EndReason): boolean {
        const row = this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
        return !!row && this.endSession(sessionId, reason);
    }

    /** Signs out every computer: the one asking did it itself ('signed-out'); the rest, 'everywhere'. */
    signOutEverywhere(userId: string, here?: string): number {
        const ended = here && this.endSession(here, 'signed-out') ? 1 : 0;
        return ended + this.endAll(userId, 'everywhere', here);
    }

    /** Changes the passphrase (the current one first), and signs out every other computer. */
    async changePassphrase(input: { user: DoorUser; keepSessionId: string; current: string; next: string; ip: string | null; userAgent?: string }): Promise<{ signedOutOthers: number }> {
        const wait = this.retryAfter(input.ip, input.user.username, true);
        if (wait !== null) throw new Locked(wait);
        const user = this.user(input.user.username);
        if (!user || !(await bcrypt.compare(input.current, user.hash))) {
            this.logAttempt(input.user.username, input.ip, input.userAgent, false, true, true);
            throw new PassphraseError('current', "That isn't your current passphrase");
        }
        if ([...input.next].length < MIN_PASSPHRASE) throw new PassphraseError('next', tooShort(input.next));
        this.db.prepare('UPDATE users SET password_hash = ?, passphrase_changed_at = ? WHERE id = ?').run(await bcrypt.hash(input.next, BCRYPT_ROUNDS), this.iso(), user.id);
        return { signedOutOthers: this.endAll(user.id, 'passphrase', input.keepSessionId) };
    }

    /** The last 30 days of attempts for this username, newest first. */
    signIns(username: string): { at: string; ip: string | null; userAgent: string | null; ok: boolean }[] {
        return (this.db.prepare(`SELECT at, ip, user_agent, ok FROM signins WHERE username = ? COLLATE NOCASE AND at > ? ORDER BY id DESC LIMIT 200`)
            .all(username, this.iso(this.now() - KEEP_SIGNINS_MS)) as { at: string; ip: string | null; user_agent: string | null; ok: number }[])
            .map(r => ({ at: r.at, ip: r.ip, userAgent: r.user_agent, ok: !!r.ok }));
    }

    /** Drops what no longer matters: long-ended sessions, used-up codes, old attempts. */
    cleanup(): void {
        const now = this.now();
        // Sessions unused for 30 days end now (so their apps can still say why for another 30)
        const stale = this.db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL AND last_seen_at <= ?').all(this.iso(now - SESSION_IDLE_MS)) as { id: string }[];
        for (const s of stale) this.endSession(s.id, 'expired');
        this.db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(this.iso(now - KEEP_ENDED_MS));
        this.db.prepare('DELETE FROM codes WHERE expires_at < ?').run(this.iso(now));
        this.db.prepare('DELETE FROM signins WHERE at < ?').run(this.iso(now - KEEP_SIGNINS_MS));
    }
}
