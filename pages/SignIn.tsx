/**
 * Sign in to Bassapps (and its seven states).
 * Coming from an app, the address says which (?app=mail), with a state and the page to go back
 * to; "to continue to Mail" names it from the family's fixed list, never from text in the address.
 * Already signed in on this computer: straight back, without asking again.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Clock, Loader2, LogOut, WifiOff } from 'lucide-react';
import { Wordmark } from './AppsMenu';
import { call, Unreachable, type DoorStatus } from './api';

// 'no-access': signed in, but this login may not use the app it came from
type Phase = 'checking' | 'idle' | 'signing' | 'wrong' | 'locked' | 'offline' | 'no-access';

const params = new URLSearchParams(window.location.search);
const back = { app: params.get('app'), state: params.get('state'), return: params.get('return') };
// The notice: why this computer was signed out (from the app, or Account, that sent the person here).
// Another computer used Account, or changed the passphrase; anything else but signing out here: ended.
const reason = params.get('reason');
const banner = reason === 'everywhere' || reason === 'removed' ? 'elsewhere'
    : reason === 'passphrase' ? 'passphrase'
        : reason && reason !== 'signed-out' ? 'ended' : null;

const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const SignIn: React.FC = () => {
    const [phase, setPhase] = useState<Phase>('checking');
    const [forgot, setForgot] = useState(false);
    const [apps, setApps] = useState<DoorStatus['apps']>([]);
    const [username, setUsername] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [show, setShow] = useState(false);
    const [lockedUntil, setLockedUntil] = useState(0);
    const [now, setNow] = useState(() => Date.now());
    const userRef = useRef<HTMLInputElement>(null);
    const passRef = useRef<HTMLInputElement>(null);

    // Already signed in here? Back to the app (or on to Account); otherwise the form
    const check = () => {
        call<DoorStatus>('GET', '/status')
            .then(async ({ data }) => {
                setApps(data.apps);
                if (!data.signedIn) return setPhase('idle');
                if (!back.app || back.app === 'account') return window.location.assign('/account');
                const { status, data: next } = await call<{ redirect?: string }>('POST', '/continue', back);
                if (next.redirect) window.location.assign(next.redirect);
                else setPhase(status === 403 ? 'no-access' : 'idle');
            })
            .catch(() => setPhase('offline'));
    };
    useEffect(() => {
        document.title = 'Sign in';
        check();
    }, []);

    useEffect(() => {
        if (phase === 'idle' && !forgot) userRef.current?.focus();
    }, [phase, forgot]);

    // The countdown, while too many attempts hold the form
    useEffect(() => {
        if (phase !== 'locked') return;
        const t = setInterval(() => {
            const at = Date.now();
            setNow(at);
            if (at >= lockedUntil) setPhase('idle');
        }, 250);
        return () => clearInterval(t);
    }, [phase, lockedUntil]);

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (phase === 'signing' || phase === 'locked' || phase === 'checking') return;
        // The first look couldn't reach the server, and nothing's typed yet: look again
        if (phase === 'offline' && !username && !passphrase) {
            setPhase('checking');
            check();
            return;
        }
        setPhase('signing');
        try {
            const { status, data, retryAfter } = await call<{ redirect?: string; retryAfter?: number }>('POST', '/sign-in', { username, passphrase, ...back });
            if (status === 200 && data.redirect) {
                window.location.assign(data.redirect);
                return;
            }
            if (status === 403) {
                setPassphrase('');
                setPhase('no-access');
                return;
            }
            if (status === 429) {
                setLockedUntil(Date.now() + (data.retryAfter ?? retryAfter ?? 60) * 1000);
                setNow(Date.now());
                setPhase('locked');
                return;
            }
            // Never which part: the passphrase is cleared, and the focus goes back to it
            setPassphrase('');
            setPhase('wrong');
            setTimeout(() => passRef.current?.focus(), 0);
        } catch (err) {
            setPhase(err instanceof Unreachable ? 'offline' : 'wrong');
        }
    };

    const appName = back.app === 'account' ? 'Account' : apps.find(a => a.id === back.app)?.name ?? null;
    const locked = phase === 'locked';
    const signing = phase === 'signing';
    if (phase === 'checking') return <main className="si" aria-busy="true" />;

    return (
        <main className="si">
            <div className="si-card">
                {banner === 'ended' && (
                    <div className="si-banner" role="status">
                        <LogOut size={16} aria-hidden="true" />
                        <span><b>Your session ended</b><br /><span className="si-s">Sign in again to pick up where you left off</span></span>
                    </div>
                )}
                {banner === 'elsewhere' && (
                    <div className="si-banner" role="status">
                        <LogOut size={16} aria-hidden="true" />
                        <span><b>You were signed out from another computer</b><br /><span className="si-s">Sign in again to keep using this one</span></span>
                    </div>
                )}
                {banner === 'passphrase' && (
                    <div className="si-banner" role="status">
                        <LogOut size={16} aria-hidden="true" />
                        <span><b>Your passphrase was changed on another computer</b><br /><span className="si-s">Sign in with the new one to keep using this one</span></span>
                    </div>
                )}
                <div className="si-body">
                    <Wordmark />
                    {forgot ? (
                        <>
                            <h1 className="si-h">Forgot your passphrase?</h1>
                            <p className="si-text">For safety, your passphrase can only be reset on the server itself. There's no reset by email, so nobody can take over your apps from an inbox.</p>
                            <div>
                                <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--color-text-muted)' }}>On the server, run</p>
                                <div className="si-code">bassapps reset-passphrase</div>
                            </div>
                            <p className="si-text">Then sign in here with the new passphrase. Your other computers will need it too.</p>
                            <button type="button" className="si-secondary" onClick={() => setForgot(false)}>Back to sign in</button>
                        </>
                    ) : (
                        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }} noValidate>
                            <div>
                                <h1 className="si-h">Sign in</h1>
                                {appName && <p className="si-sub">to continue to {appName}</p>}
                            </div>
                            <div>
                                <label className="si-lab" htmlFor="u">Username</label>
                                <input ref={userRef} id="u" className="si-inp" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
                                    value={username} onChange={e => setUsername(e.target.value)} disabled={locked} />
                            </div>
                            <div>
                                <label className="si-lab" htmlFor="p">Passphrase</label>
                                <div className="si-inpw">
                                    <input ref={passRef} id="p" className="si-inp" type={show ? 'text' : 'password'} autoComplete="current-password"
                                        value={passphrase} onChange={e => setPassphrase(e.target.value)} disabled={locked} style={{ paddingRight: '64px' }} />
                                    <button type="button" className="si-show" onClick={() => setShow(s => !s)} aria-pressed={show} disabled={locked}>{show ? 'Hide' : 'Show'}</button>
                                </div>
                            </div>
                            {phase === 'wrong' && (
                                <div className="si-msg" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" />
                                    <span>That username and passphrase don't match</span>
                                </div>
                            )}
                            {locked && (
                                <div className="si-msg" role="alert">
                                    <Clock size={16} aria-hidden="true" />
                                    <span>Too many attempts<br /><span className="si-s">You can try again in <span className="si-num">{mmss(Math.max(0, Math.ceil((lockedUntil - now) / 1000)))}</span></span></span>
                                </div>
                            )}
                            {phase === 'no-access' && (
                                <div className="si-msg" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" />
                                    <span>This login can't open {appName ?? 'that app'}<br /><span className="si-s">Its apps are on <a href="/account">Account</a></span></span>
                                </div>
                            )}
                            {phase === 'offline' && (
                                <div className="si-msg" role="alert">
                                    <WifiOff size={16} aria-hidden="true" />
                                    <span>Can't reach the server<br /><span className="si-s">Check this computer's connection. The server may also be restarting</span></span>
                                </div>
                            )}
                            <button type="submit" className="si-primary" disabled={locked || signing}>
                                {signing && <Loader2 size={16} className="spin" aria-hidden="true" />}
                                {signing ? 'Signing in…' : phase === 'offline' ? 'Try again' : 'Sign in'}
                            </button>
                            <button type="button" className="si-link" onClick={() => setForgot(true)}>Forgot your passphrase?</button>
                        </form>
                    )}
                </div>
            </div>
            <p className="si-ft">bassapps.net · One account for Mail, Tasks and what comes next</p>
        </main>
    );
};
