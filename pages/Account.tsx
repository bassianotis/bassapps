/**
 * Account (and its states): the signed-in computers
 * (sign one out, or every one), changing the passphrase, and the last 30 days of sign-ins.
 * Reached from every app's apps menu; signed out, it sends the person to sign in first.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Laptop, Monitor, X } from 'lucide-react';
import { AppsMenu, type FamilyApp } from './AppsMenu';
import { call, type AccountView, type DoorStatus } from './api';

const MIN = 12;
const dateShort = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dateTime = (iso: string) => `${dateShort(iso)}, ${new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

/** "Active now", "Last active 2 hours ago", or "Last active Nov 3". */
function lastActive(iso: string, here: boolean): string {
    const ago = Date.now() - Date.parse(iso);
    if (here || ago < 2 * 60_000) return 'Active now';
    if (ago < 60 * 60_000) return `Last active ${Math.round(ago / 60_000)} minutes ago`;
    if (ago < 24 * 60 * 60_000) {
        const hours = Math.round(ago / (60 * 60_000));
        return `Last active ${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    return `Last active ${dateShort(iso)}`;
}

const toSignIn = (reason?: string | null) => window.location.assign(`/sign-in?app=account${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);

export const Account: React.FC = () => {
    const [view, setView] = useState<AccountView | null>(null);
    const [family, setFamily] = useState<{ apps: FamilyApp[]; accountUrl: string }>({ apps: [], accountUrl: '/account' });
    const [confirming, setConfirming] = useState(false);
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [repeat, setRepeat] = useState('');
    const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
    const [done, setDone] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        const { status, data } = await call<AccountView & { reason?: string | null }>('GET', '/account');
        if (status === 401) return toSignIn(data.reason);
        setView(data);
    }, []);

    useEffect(() => {
        document.title = 'Account';
        void load();
        call<DoorStatus>('GET', '/status').then(({ data }) => setFamily({ apps: data.apps, accountUrl: data.accountUrl })).catch(() => {});
    }, [load]);

    const signOutComputer = async (id: string) => {
        const { data } = await call<{ signedOutHere?: boolean }>('POST', `/computers/${encodeURIComponent(id)}/sign-out`);
        if (data.signedOutHere) return toSignIn();
        void load();
    };

    const signOutEverywhere = async () => {
        await call('POST', '/sign-out-everywhere');
        toSignIn();
    };

    const signOut = async () => {
        await call('POST', '/sign-out').catch(() => {});
        toSignIn();
    };

    const changePassphrase = async (e: React.FormEvent) => {
        e.preventDefault();
        setDone(null);
        const found: typeof errors = {};
        if ([...next].length < MIN) found.next = `Use at least ${MIN} characters. This has ${[...next].length}`;
        if (next !== repeat) found.repeat = "These don't match";
        if (!current) found.current = "That isn't your current passphrase";
        setErrors(found);
        if (Object.keys(found).length) return;
        setSaving(true);
        try {
            const { status, data } = await call<{ signedOutOthers?: number; field?: 'current' | 'next'; error?: string }>('POST', '/passphrase', { current, next });
            if (status === 200) {
                const n = data.signedOutOthers ?? 0;
                setDone(n === 0 ? 'Passphrase changed' : `Passphrase changed. ${n} other computer${n === 1 ? ' was' : 's were'} signed out`);
                setCurrent(''); setNext(''); setRepeat('');
                void load();
            } else if (status === 401) toSignIn();
            else setErrors({ [data.field ?? 'current']: data.error ?? "That isn't your current passphrase" });
        } finally {
            setSaving(false);
        }
    };

    useEffect(() => {
        if (!confirming) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirming(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [confirming]);

    if (!view) return <div className="ac" aria-busy="true"><aside className="ac-rail" /></div>;

    return (
        <div className="ac">
            <aside className="ac-rail">
                <AppsMenu username={view.username} apps={family.apps} current="account" accountUrl={family.accountUrl} onSignOut={() => void signOut()} />
            </aside>
            <header className="ac-top">Account</header>
            <main className="ac-main">
                <div>
                    <h1 className="ac-h">Account</h1>
                    <p className="ac-cap" style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>Signed in as {view.username}</p>
                </div>

                <section className="ac-sec" aria-labelledby="h-dev">
                    <div className="ac-sh">
                        <h2 id="h-dev">Signed-in computers</h2>
                        <p className="ac-cap">These can open your apps until they sign out or go unused for {view.idleDays} days</p>
                    </div>
                    {view.computers.map(c => (
                        <div key={c.id} className="ac-dev">
                            {c.kind === 'laptop' ? <Laptop size={20} aria-hidden="true" /> : <Monitor size={20} aria-hidden="true" />}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="ac-dev-name">{c.name}{c.here && <span className="ac-tag">This computer</span>}</div>
                                <div className="ac-dev-meta">{lastActive(c.lastSeenAt, c.here)} · Signed in since {dateShort(c.createdAt)}</div>
                            </div>
                            <button type="button" className="ac-btn2" onClick={() => void signOutComputer(c.id)}>Sign out</button>
                        </div>
                    ))}
                    <div className="ac-foot">
                        <p className="ac-cap">Signs out every computer, this one included</p>
                        <button type="button" className="ac-btn2 ac-danger" onClick={() => setConfirming(true)}>Sign out everywhere</button>
                    </div>
                </section>

                <section className="ac-sec" aria-labelledby="h-pass">
                    <div className="ac-sh">
                        <h2 id="h-pass">Change passphrase</h2>
                        <p className="ac-cap">At least {MIN} characters. Your other computers are signed out afterwards</p>
                    </div>
                    <form className="ac-form" onSubmit={changePassphrase} noValidate>
                        {done && (
                            <div className="ac-ok" role="status">
                                <Check size={16} aria-hidden="true" style={{ color: 'var(--color-success)' }} />
                                <span>{done}</span>
                            </div>
                        )}
                        <div>
                            <label className="ac-lab" htmlFor="pc">Current passphrase</label>
                            <input id="pc" className={`ac-inp${errors.current ? ' bad' : ''}`} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} aria-invalid={!!errors.current} />
                            {errors.current && <p className="ac-err">{errors.current}</p>}
                        </div>
                        <div>
                            <label className="ac-lab" htmlFor="pn">New passphrase</label>
                            <input id="pn" className={`ac-inp${errors.next ? ' bad' : ''}`} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} aria-invalid={!!errors.next} />
                            {errors.next && <p className="ac-err">{errors.next}</p>}
                        </div>
                        <div>
                            <label className="ac-lab" htmlFor="pr">Repeat new passphrase</label>
                            <input id="pr" className={`ac-inp${errors.repeat ? ' bad' : ''}`} type="password" autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)} aria-invalid={!!errors.repeat} />
                            {errors.repeat && <p className="ac-err">{errors.repeat}</p>}
                        </div>
                        <div><button type="submit" className="ac-primary" disabled={saving}>Change passphrase</button></div>
                    </form>
                </section>

                <section className="ac-sec" aria-labelledby="h-log">
                    <div className="ac-sh">
                        <h2 id="h-log">Recent sign-ins</h2>
                        <p className="ac-cap">The last 30 days, newest first</p>
                    </div>
                    <table className="ac-table">
                        <thead><tr><th scope="col">Time</th><th scope="col">Computer</th><th scope="col">IP address</th><th scope="col">Result</th></tr></thead>
                        <tbody>
                            {view.signIns.map((r, i) => (
                                <tr key={i}>
                                    <td className="t">{dateTime(r.at)}</td>
                                    <td>{r.computer}</td>
                                    <td className="ip">{r.ip ?? '—'}</td>
                                    <td>{r.ok
                                        ? <span className="ac-res"><Check size={14} aria-hidden="true" style={{ color: 'var(--color-text-muted)' }} />Succeeded</span>
                                        : <span className="ac-res ac-danger"><X size={14} aria-hidden="true" />Failed</span>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            </main>

            {confirming && (
                <div className="ac-scrim" onClick={() => setConfirming(false)}>
                    <div className="ac-dlg" role="dialog" aria-modal="true" aria-labelledby="h-conf" onClick={e => e.stopPropagation()}>
                        <h2 id="h-conf">Sign out everywhere?</h2>
                        <p>Every computer, this one included, will need your passphrase again.</p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                            <button type="button" className="ac-btn2" style={{ height: '40px' }} onClick={() => setConfirming(false)} autoFocus>Cancel</button>
                            <button type="button" className="ac-dlg-danger" onClick={() => void signOutEverywhere()}>Sign out everywhere</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
