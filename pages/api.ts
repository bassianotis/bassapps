/**
 * The sign-in pages talk to the sign-in service (service/src/server.ts) at /door-api, same
 * origin, JSON only. "Can't reach the server" is a failed connection, or a proxy answering for it.
 */
import type { FamilyApp } from './AppsMenu';

export interface DoorStatus {
    signedIn: boolean;
    username: string | null;
    reason: string | null;
    apps: FamilyApp[];
    accountUrl: string;
}

export interface AccountView {
    username: string;
    idleDays: number;
    computers: { id: string; name: string; kind: 'laptop' | 'desktop'; here: boolean; lastSeenAt: string; createdAt: string }[];
    signIns: { at: string; computer: string; ip: string | null; ok: boolean }[];
}

export class Unreachable extends Error {}

export async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T; retryAfter: number | null }> {
    let res: Response;
    try {
        res = await fetch(`/door-api${path}`, {
            method,
            credentials: 'same-origin',
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        });
    } catch {
        throw new Unreachable("Can't reach the server");
    }
    const json = res.headers.get('content-type')?.includes('json');
    if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status === 500 && !json)) throw new Unreachable("Can't reach the server");
    const data = (json ? await res.json().catch(() => ({})) : {}) as T;
    const retry = res.headers.get('retry-after');
    return { status: res.status, data, retryAfter: retry ? Number(retry) : null };
}
