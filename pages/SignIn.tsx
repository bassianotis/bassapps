/**
 * Sign in to Bassapps (and its seven states), on the shared sign-in card (SignInCard.tsx, one build
 * with Mail on its own).
 * Coming from an app, the address says which (?app=mail), with a state and the page to go back
 * to; "to continue to Mail" names it from the family's fixed list, never from text in the address.
 * Already signed in on this computer: straight back, without asking again.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Wordmark } from './AppsMenu';
import { SignInCard, type SignedOutNotice, type SignInProblem } from './SignInCard';
import { call, Unreachable, type DoorStatus } from './api';

const params = new URLSearchParams(window.location.search);
const back = { app: params.get('app'), state: params.get('state'), return: params.get('return') };
// The notice: why this computer was signed out (from the app, or Account, that sent the person here).
// Another computer used Account, or changed the passphrase; anything else but signing out here: ended.
const reason = params.get('reason');
const notice: SignedOutNotice | null = reason === 'everywhere' || reason === 'removed' ? 'elsewhere'
    : reason === 'passphrase' ? 'passphrase'
        : reason && reason !== 'signed-out' ? 'ended' : null;

const nameOf = (apps: DoorStatus['apps']) => (back.app === 'account' ? 'Account' : apps.find(a => a.id === back.app)?.name ?? null);

export const SignIn: React.FC = () => {
    const [checking, setChecking] = useState(true);
    const [apps, setApps] = useState<DoorStatus['apps']>([]);
    const [username, setUsername] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [signing, setSigning] = useState(false);
    const [problem, setProblem] = useState<SignInProblem | null>(null);

    // Already signed in here? Back to the app (or on to Account); otherwise the form
    const check = () => {
        call<DoorStatus>('GET', '/status')
            .then(async ({ data }) => {
                setApps(data.apps);
                if (!data.signedIn) return setChecking(false);
                if (!back.app || back.app === 'account') return window.location.assign('/account');
                const { status, data: next } = await call<{ redirect?: string }>('POST', '/continue', back);
                if (next.redirect) return window.location.assign(next.redirect);
                if (status === 403) setProblem({ kind: 'no-access', app: nameOf(data.apps), accountHref: '/account' });
                setChecking(false);
            })
            .catch(() => {
                setProblem({ kind: 'offline' });
                setChecking(false);
            });
    };
    useEffect(() => {
        document.title = 'Sign in';
        check();
    }, []);

    const unlock = useCallback(() => setProblem(null), []);

    const submit = async () => {
        if (signing || checking) return;
        // The first look couldn't reach the server, and nothing's typed yet: look again
        if (problem?.kind === 'offline' && !username && !passphrase) {
            setProblem(null);
            setChecking(true);
            check();
            return;
        }
        setSigning(true);
        try {
            const { status, data, retryAfter } = await call<{ redirect?: string; retryAfter?: number }>('POST', '/sign-in', { username, passphrase, ...back });
            if (status === 200 && data.redirect) {
                window.location.assign(data.redirect);
                return;
            }
            setSigning(false);
            if (status === 403) {
                setPassphrase('');
                setProblem({ kind: 'no-access', app: nameOf(apps), accountHref: '/account' });
                return;
            }
            if (status === 429) {
                setProblem({ kind: 'locked', until: Date.now() + (data.retryAfter ?? retryAfter ?? 60) * 1000 });
                return;
            }
            // Never which part: the passphrase is cleared, and the focus goes back to it
            setPassphrase('');
            setProblem({ kind: 'wrong' });
        } catch (err) {
            setSigning(false);
            setProblem(err instanceof Unreachable ? { kind: 'offline' } : { kind: 'wrong' });
        }
    };

    if (checking) return <main className="si" aria-busy="true" />;

    return (
        <SignInCard
            brand={<Wordmark />}
            notice={notice}
            continueTo={nameOf(apps)}
            username={username}
            onUsername={setUsername}
            passphrase={passphrase}
            onPassphrase={setPassphrase}
            problem={problem}
            onLockEnded={unlock}
            signing={signing}
            onSubmit={() => void submit()}
            forgot={{ command: 'bassapps reset-passphrase', protects: 'your apps' }}
            footer="bassapps.net · One account for Mail, Tasks and what comes next"
        />
    );
};
