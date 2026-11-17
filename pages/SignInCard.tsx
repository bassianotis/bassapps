/**
 * The sign-in card (board P6): one build for the Bassapps sign-in page and Mail on its own. The same
 * file sits in both repos (bassapps: pages/SignInCard.tsx; Mail: src/shared/SignInCard.tsx), with
 * sign-in.css; keep the two in step, as the apps menu is. It only draws and takes the keys; the page
 * around it signs in (Bassapps: the sign-in service; Mail on its own: its engine's login).
 * A centred 440 card: why this computer was signed out (a band across its top), the mark and name,
 * "Sign in", Username (each app names it) and Passphrase (48 high, Show inside), the problem as a bordered note above
 * the button, the 48-high button, "Forgot your passphrase?" (the same card, the server's command),
 * and the footer line (Bassapps only). The family focus ring, radius 8 on the card and 6 on the
 * fields, the button at 500.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Clock, LoaderCircle, LogOut, WifiOff } from 'lucide-react';
import './sign-in.css';

export type SignInProblem =
    | { kind: 'wrong' }
    /** Too many attempts; `until` is when the server takes them again (null: not known, no countdown) */
    | { kind: 'locked'; until: number | null }
    /** Signed in, but this login may not use the app it came from */
    | { kind: 'no-access'; app: string | null; accountHref: string }
    | { kind: 'offline' };

/** Why this computer was signed out: the band across the top of the card. */
export type SignedOutNotice = 'ended' | 'elsewhere' | 'passphrase';

const NOTICES: Record<SignedOutNotice, [string, string]> = {
    ended: ['Your session ended', 'Sign in again to pick up where you left off'],
    elsewhere: ['You were signed out from another computer', 'Sign in again to keep using this one'],
    passphrase: ['Your passphrase was changed on another computer', 'Sign in with the new one to keep using this one'],
};

const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const SignInCard: React.FC<{
    /** The mark and name: Bassapps' wordmark, or Mail's */
    brand: React.ReactNode;
    notice?: SignedOutNotice | null;
    /** "to continue to Mail", when the person came from an app */
    continueTo?: string | null;
    /** What the first field is called: "Username" (Bassapps); Mail on its own says "Email address"
     *  until its first-run redesign (owner, Checkpoint B). The wrong-details line follows it. */
    userLabel?: string;
    username: string;
    onUsername: (value: string) => void;
    passphrase: string;
    onPassphrase: (value: string) => void;
    /** A new object for each failure (the passphrase then takes the focus again) */
    problem: SignInProblem | null;
    /** A too-many-attempts wait has run out */
    onLockEnded?: () => void;
    signing: boolean;
    onSubmit: () => void;
    /** Forgot your passphrase?: the command that resets it on the server, and what it protects */
    forgot: { command: string; protects: string };
    footer?: string | null;
}> = ({ brand, notice, continueTo, userLabel = 'Username', username, onUsername, passphrase, onPassphrase, problem, onLockEnded, signing, onSubmit, forgot, footer }) => {
    const [show, setShow] = useState(false);
    const [forgotOpen, setForgotOpen] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const userRef = useRef<HTMLInputElement>(null);
    const passRef = useRef<HTMLInputElement>(null);
    const lockedUntil = problem?.kind === 'locked' ? problem.until : null;
    const locked = lockedUntil !== null && now < lockedUntil;

    // The username starts with the focus (again after Forgot); after a wrong attempt, the passphrase
    useEffect(() => {
        if (!forgotOpen) userRef.current?.focus();
    }, [forgotOpen]);
    useEffect(() => {
        if (problem?.kind === 'wrong') passRef.current?.focus();
    }, [problem]);

    // The countdown while too many attempts hold the form
    useEffect(() => {
        if (lockedUntil === null) return;
        const t = setInterval(() => {
            const at = Date.now();
            setNow(at);
            if (at >= lockedUntil) {
                clearInterval(t);
                onLockEnded?.();
            }
        }, 250);
        return () => clearInterval(t);
    }, [lockedUntil, onLockEnded]);

    return (
        <main className="si">
            <div className="si-card">
                {notice && (
                    <div className="si-banner" role="status">
                        <LogOut size={16} aria-hidden="true" />
                        <span><b>{NOTICES[notice][0]}</b><br /><span className="si-s">{NOTICES[notice][1]}</span></span>
                    </div>
                )}
                <div className="si-body">
                    {brand}
                    {forgotOpen ? (
                        <>
                            <h1 className="si-h">Forgot your passphrase?</h1>
                            <p className="si-text">For safety, your passphrase can only be reset on the server itself. There's no reset by email, so nobody can take over {forgot.protects} from an inbox.</p>
                            <div>
                                <p className="si-cap">On the server, run</p>
                                <div className="si-code">{forgot.command}</div>
                            </div>
                            <p className="si-text">Then sign in here with the new passphrase. Your other computers will need it too.</p>
                            <button type="button" className="si-secondary" onClick={() => setForgotOpen(false)}>Back to sign in</button>
                        </>
                    ) : (
                        <form className="si-form" onSubmit={e => { e.preventDefault(); if (!locked && !signing) onSubmit(); }} noValidate>
                            <div>
                                <h1 className="si-h">Sign in</h1>
                                {continueTo && <p className="si-sub">to continue to {continueTo}</p>}
                            </div>
                            <div>
                                <label className="si-lab" htmlFor="u">{userLabel}</label>
                                <input ref={userRef} id="u" className="si-inp" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
                                    value={username} onChange={e => onUsername(e.target.value)} disabled={locked} />
                            </div>
                            <div>
                                <label className="si-lab" htmlFor="p">Passphrase</label>
                                <div className="si-inpw">
                                    <input ref={passRef} id="p" className="si-inp si-inp--secret" type={show ? 'text' : 'password'} autoComplete="current-password"
                                        value={passphrase} onChange={e => onPassphrase(e.target.value)} disabled={locked} />
                                    <button type="button" className="si-show" onClick={() => setShow(s => !s)} aria-pressed={show} disabled={locked}>{show ? 'Hide' : 'Show'}</button>
                                </div>
                            </div>
                            {problem?.kind === 'wrong' && (
                                <div className="si-msg" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" />
                                    <span>That {userLabel.toLowerCase()} and passphrase don't match</span>
                                </div>
                            )}
                            {problem?.kind === 'locked' && (
                                <div className="si-msg" role="alert">
                                    <Clock size={16} aria-hidden="true" />
                                    <span>Too many attempts<br /><span className="si-s">{lockedUntil === null
                                        ? 'Wait a few minutes, then try again'
                                        : <>You can try again in <span className="si-num">{mmss(Math.max(0, Math.ceil((lockedUntil - now) / 1000)))}</span></>}</span></span>
                                </div>
                            )}
                            {problem?.kind === 'no-access' && (
                                <div className="si-msg" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" />
                                    <span>This login can't open {problem.app ?? 'that app'}<br /><span className="si-s">Its apps are on <a href={problem.accountHref}>Account</a></span></span>
                                </div>
                            )}
                            {problem?.kind === 'offline' && (
                                <div className="si-msg" role="alert">
                                    <WifiOff size={16} aria-hidden="true" />
                                    <span>Can't reach the server<br /><span className="si-s">Check this computer's connection. The server may also be restarting</span></span>
                                </div>
                            )}
                            <button type="submit" className="si-primary" disabled={locked || signing}>
                                {signing && <LoaderCircle size={16} className="si-spin" aria-hidden="true" />}
                                {signing ? 'Signing in…' : problem?.kind === 'offline' ? 'Try again' : 'Sign in'}
                            </button>
                            <button type="button" className="si-link" onClick={() => setForgotOpen(true)}>Forgot your passphrase?</button>
                        </form>
                    )}
                </div>
            </div>
            {footer && <p className="si-ft">{footer}</p>}
        </main>
    );
};
