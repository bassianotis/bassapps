// The sign-in service's HTTP API (Bassapps; the apps' side is docs/joining.md).
//
// For its own pages (/door-api, same origin, JSON only, Origin checked):
//   status, sign-in, continue (already signed in on this computer: straight back to the app),
//   sign-out, account, sign one computer out, sign out everywhere, change passphrase.
// For the apps (/internal/v1, a shared secret, never from a browser; the proxy also blocks it):
//   exchange a one-time code for the app's own token, verify a token (or say why it ended), sign
//   a token's computer out, and the list of apps. Versioned, so apps can rely on it.
// Signing in, the service sends the person back to the app with a one-time code; the app
// exchanges it and keeps its own cookie (host-only), so no other site under the same domain ever
// sees a session cookie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Door, Locked, NoAccess, PassphraseError, SESSION_IDLE_MS } from './door.ts';
import { computerName, shownAddress } from './computer.ts';

export interface DoorApp {
    id: string;
    name: string;
    /** Where it lives (origin), e.g. https://mail.bassapps.net. */
    url: string;
}

export interface DoorServerOptions {
    door: Door;
    apps: DoorApp[];
    /** This service's own address (its sign-in and Account pages). */
    publicUrl: string;
    /** The computer's session cookie, and the "known computer" mark (kept through signing out). */
    cookieName: string;
    knownCookieName: string;
    secureCookies: boolean;
    /** Behind a proxy that sets X-Forwarded-For (only then is that header believed). */
    trustProxy: boolean;
    /** What apps send as X-Door-Secret. */
    internalSecret: string;
    /** The built pages, served in production (in development, Vite serves them). */
    staticDir?: string;
    /** A computer that hasn't signed in before just did: tell the person (the new sign-in email). */
    notifyNewComputer?: (info: { at: Date; computer: string; ip: string | null }) => Promise<void>;
    log?: (msg: string) => void;
}

class HttpError extends Error {
    readonly status: number;
    readonly body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>) {
        super(String(body.error));
        this.status = status;
        this.body = body;
    }
}

const MAX_BODY = 16 * 1024;
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // the browser's longest; the server decides when a session ends
const KNOWN_MAX_AGE = 365 * 24 * 60 * 60;
const PAGES = new Set(['/', '/sign-in', '/account']);
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

export function createDoorServer(o: DoorServerOptions): http.Server {
    const apps = new Map(o.apps.map(a => [a.id, a]));
    const secret = crypto.createHash('sha256').update(o.internalSecret).digest();
    const accountUrl = `${o.publicUrl.replace(/\/$/, '')}/account`;

    const cookie = (name: string, value: string, maxAge: number) =>
        `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${o.secureCookies ? '; Secure' : ''}`;
    const clientIp = (req: http.IncomingMessage) => {
        const forwarded = o.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
        return (forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '') || null;
    };

    /** Back to the app with a one-time code, or to Account when there's no app to go back to. */
    const backTo = (sessionId: string, appId?: unknown, state?: unknown, ret?: unknown) => {
        const app = typeof appId === 'string' ? apps.get(appId) : undefined;
        if (!app) return accountUrl;
        const url = new URL('/api/v2/auth/callback', app.url);
        try {
            url.searchParams.set('code', o.door.issueCode(sessionId, app.id));
        } catch (err) {
            // Signed in, but this login may not use that app: the page says so (and Account still works)
            if (err instanceof NoAccess) throw new HttpError(403, { error: 'no-access', app: app.name });
            throw err;
        }
        url.searchParams.set('state', typeof state === 'string' ? state.slice(0, 200) : '');
        // A path on the app's own site only (browsers read "//x" and "/\x" as another site); the app checks again
        url.searchParams.set('return', typeof ret === 'string' && /^\/(?![/\\])/.test(ret) && !ret.includes('\\') && ![...ret].some(c => c < ' ') ? ret.slice(0, 2000) : '/');
        return url.toString();
    };

    const signedIn = (req: http.IncomingMessage) => {
        const s = o.door.session(readCookie(req, o.cookieName));
        if (!s || 'reason' in s) throw new HttpError(401, { error: 'not signed in', reason: s && 'reason' in s ? s.reason : null });
        return s;
    };

    const api = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
        const method = req.method ?? 'GET';
        const p = url.pathname;
        if (method !== 'GET') {
            if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, { error: 'send JSON' });
            const origin = req.headers.origin;
            if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, { error: 'cross-site request refused' });
        }

        if (method === 'GET' && p === '/door-api/status') {
            const s = o.door.session(readCookie(req, o.cookieName));
            const live = s && !('reason' in s) ? s : null;
            // Signed in: only the apps this login may use (the apps menu); otherwise all (for "to continue to …")
            const shown = live ? o.apps.filter(a => o.door.mayUse(live.user.id, a.id)) : o.apps;
            return json(res, 200, {
                signedIn: !!live, username: live?.user.username ?? null, reason: s && 'reason' in s ? s.reason : null,
                apps: shown.map(a => ({ id: a.id, name: a.name, url: a.url })), accountUrl,
            });
        }

        if (method === 'POST' && p === '/door-api/sign-in') {
            const b = await readJson(req);
            if (typeof b.username !== 'string' || typeof b.passphrase !== 'string') throw new HttpError(400, { error: 'username and passphrase are required' });
            let result;
            try {
                result = await o.door.signIn({ username: b.username, passphrase: b.passphrase, ip: clientIp(req), userAgent: req.headers['user-agent'], mark: readCookie(req, o.knownCookieName) });
            } catch (err) {
                if (err instanceof Locked) {
                    res.setHeader('Retry-After', String(err.retryAfterSeconds));
                    throw new HttpError(429, { error: 'locked', retryAfter: err.retryAfterSeconds });
                }
                throw err;
            }
            if (!result) throw new HttpError(401, { error: 'mismatch' });
            res.setHeader('Set-Cookie', [cookie(o.cookieName, result.sessionToken, COOKIE_MAX_AGE), cookie(o.knownCookieName, result.knownMark, KNOWN_MAX_AGE)]);
            if (result.newComputer && o.notifyNewComputer) {
                o.notifyNewComputer({ at: new Date(), computer: computerName(req.headers['user-agent'] ?? null).name, ip: shownAddress(clientIp(req)) })
                    .catch(err => o.log?.(`new sign-in email not sent: ${(err as Error).message}`));
            }
            return json(res, 200, { redirect: backTo(result.sessionId, b.app, b.state, b.return) });
        }

        if (method === 'POST' && p === '/door-api/continue') {
            const s = signedIn(req);
            const b = await readJson(req);
            return json(res, 200, { redirect: backTo(s.sessionId, b.app, b.state, b.return) });
        }

        if (method === 'POST' && p === '/door-api/sign-out') {
            const s = o.door.session(readCookie(req, o.cookieName));
            if (s && !('reason' in s)) o.door.endSession(s.sessionId, 'signed-out');
            res.setHeader('Set-Cookie', cookie(o.cookieName, '', 0));
            return json(res, 200, { ok: true });
        }

        if (method === 'GET' && p === '/door-api/account') {
            const s = signedIn(req);
            return json(res, 200, {
                username: s.user.username,
                idleDays: SESSION_IDLE_MS / 86_400_000,
                computers: o.door.computers(s.user.id).map(c => ({ id: c.id, ...computerName(c.userAgent), here: c.id === s.sessionId, lastSeenAt: c.lastSeenAt, createdAt: c.createdAt })),
                signIns: o.door.signIns(s.user.username).map(r => ({ at: r.at, computer: computerName(r.userAgent).name, ip: shownAddress(r.ip), ok: r.ok })),
            });
        }

        const one = /^\/door-api\/computers\/([^/]+)\/sign-out$/.exec(p);
        if (method === 'POST' && one) {
            const s = signedIn(req);
            const id = decodeURIComponent(one[1]);
            const here = id === s.sessionId;
            o.door.signOutComputer(s.user.id, id, here ? 'signed-out' : 'removed');
            if (here) res.setHeader('Set-Cookie', cookie(o.cookieName, '', 0));
            return json(res, 200, { ok: true, signedOutHere: here });
        }

        if (method === 'POST' && p === '/door-api/sign-out-everywhere') {
            const s = signedIn(req);
            const count = o.door.signOutEverywhere(s.user.id, s.sessionId);
            res.setHeader('Set-Cookie', cookie(o.cookieName, '', 0));
            return json(res, 200, { signedOut: count });
        }

        if (method === 'POST' && p === '/door-api/passphrase') {
            const s = signedIn(req);
            const b = await readJson(req);
            if (typeof b.current !== 'string' || typeof b.next !== 'string') throw new HttpError(400, { error: 'current and next are required' });
            try {
                const { signedOutOthers } = await o.door.changePassphrase({ user: s.user, keepSessionId: s.sessionId, current: b.current, next: b.next, ip: clientIp(req), userAgent: req.headers['user-agent'] });
                return json(res, 200, { signedOutOthers });
            } catch (err) {
                if (err instanceof PassphraseError) throw new HttpError(400, { field: err.field, error: err.message });
                if (err instanceof Locked) {
                    res.setHeader('Retry-After', String(err.retryAfterSeconds));
                    throw new HttpError(429, { error: 'locked', retryAfter: err.retryAfterSeconds });
                }
                throw err;
            }
        }
        throw new HttpError(404, { error: 'not found' });
    };

    const internal = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
        const given = crypto.createHash('sha256').update(String(req.headers['x-door-secret'] ?? '')).digest();
        if (!crypto.timingSafeEqual(given, secret)) throw new HttpError(403, { error: 'forbidden' });
        const p = url.pathname;
        if (req.method === 'GET' && p === '/internal/v1/apps') return json(res, 200, { apps: o.apps, accountUrl });
        const b = await readJson(req);
        if (typeof b.token !== 'string' && typeof b.code !== 'string') throw new HttpError(400, { error: 'token or code required' });
        if (p === '/internal/v1/exchange') {
            const got = o.door.exchange(String(b.code), String(b.app));
            if (!got) throw new HttpError(400, { error: 'that code is not valid' });
            return json(res, 200, got);
        }
        // Who it is, and the apps they may use (the app's own apps menu shows only those)
        if (p === '/internal/v1/verify') {
            const v = o.door.verifyApp(String(b.token));
            if (!v.ok) return json(res, 200, v);
            const may = o.door.appsOf(v.user.id);
            return json(res, 200, { ...v, apps: o.apps.filter(a => may === '*' || may.includes(a.id)).map(a => a.id) });
        }
        if (p === '/internal/v1/sign-out') {
            o.door.signOutApp(String(b.token));
            return json(res, 200, { ok: true });
        }
        throw new HttpError(404, { error: 'not found' });
    };

    const page = (res: http.ServerResponse, file: string) => {
        const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
            'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        fs.createReadStream(file).pipe(res);
    };

    return http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        try {
            if (url.pathname.startsWith('/internal/')) return await internal(req, res, url);
            if (url.pathname.startsWith('/door-api/')) return await api(req, res, url);
            if (o.staticDir && req.method === 'GET') {
                const file = path.join(o.staticDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
                if (file.startsWith(o.staticDir) && fs.existsSync(file) && fs.statSync(file).isFile()) return page(res, file);
                if (PAGES.has(url.pathname)) return page(res, path.join(o.staticDir, 'index.html'));
            }
            throw new HttpError(404, { error: 'not found' });
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            if (status === 500) o.log?.(`door ${req.method} ${url.pathname}: ${(err as Error)?.stack ?? err}`);
            if (!res.headersSent) json(res, status, err instanceof HttpError ? err.body : { error: 'internal error' });
            else res.destroy();
        }
    });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return v.join('=') || undefined;
    }
    return undefined;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new HttpError(413, { error: 'too large' });
        chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return v && typeof v === 'object' ? v : {};
    } catch {
        throw new HttpError(400, { error: 'invalid JSON' });
    }
}
