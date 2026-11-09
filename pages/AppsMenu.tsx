/**
 * The Bassapps apps tile and menu (sign-in-design.md §4): a 36px tile at the very top of the 48px
 * rail, with a short divider under it, in every app of the family. The menu opens to its right,
 * level with it: the wordmark and the username, the apps that exist (the current one says "Open"),
 * then Account and Sign out. Colours come from the theme's tokens, so it sits in Mail's light and
 * dark themes and on the Account page alike.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Mail, SquareCheck, UserRound } from 'lucide-react';
import './apps-menu.css';

export interface FamilyApp {
    id: string;
    name: string;
    url: string;
}

/** The family's four-square mark. */
export const Mark: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
        <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="8" y="1" width="5" height="5" rx="1" /><rect x="1" y="8" width="5" height="5" rx="1" /><rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
);

/** The wordmark: "bass" semibold, "apps" in secondary grey. */
export const Wordmark: React.FC<{ size?: number; markSize?: number; gap?: number }> = ({ size = 18, markSize = 16, gap = 10 }) => (
    <span className="bassapps-wordmark" style={{ gap: `${gap}px` }}>
        <Mark size={markSize} />
        <span style={{ fontSize: `${size}px`, letterSpacing: '-0.02em' }}><span style={{ fontWeight: 600 }}>bass</span><span className="bassapps-wordmark-apps">apps</span></span>
    </span>
);

const ICONS: Record<string, React.FC<{ size?: number; 'aria-hidden'?: boolean }>> = { mail: Mail, tasks: SquareCheck };

export const AppsMenu: React.FC<{
    username: string;
    apps: FamilyApp[];
    /** The app this is (an id), or 'account' on the Account page. */
    current: string;
    accountUrl: string;
    onSignOut: () => void;
}> = ({ username, apps, current, accountUrl, onSignOut }) => {
    const [open, setOpen] = useState(false);
    const tile = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);

    // Escape and a click elsewhere close it; the arrow keys move between its items
    useEffect(() => {
        if (!open) return;
        const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        items()[0]?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
                tile.current?.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const list = items();
                const at = list.indexOf(document.activeElement as HTMLElement);
                list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
            }
        };
        const onDown = (e: PointerEvent) => {
            if (!menu.current?.contains(e.target as Node) && !tile.current?.contains(e.target as Node)) setOpen(false);
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('pointerdown', onDown, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('pointerdown', onDown, true);
        };
    }, [open]);

    const here = (id: string) => (id === current ? { 'aria-current': 'page' as const } : {});
    return (
        <>
            <button
                ref={tile}
                type="button"
                className={`bassapps-tile${open ? ' bassapps-tile-open' : ''}`}
                aria-label="Apps and account"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
            >
                <Mark />
            </button>
            <span className="bassapps-rail-divider" aria-hidden="true" />
            {open && createPortal(
                <div ref={menu} className="bassapps-menu" role="menu" aria-label="Apps and account">
                    <div className="bassapps-menu-head">
                        <Wordmark size={14} markSize={13} gap={8} />
                        <span className="bassapps-menu-user">{username}</span>
                    </div>
                    {apps.map(app => {
                        const Icon = ICONS[app.id] ?? Mail;
                        return (
                            <a key={app.id} role="menuitem" className="bassapps-menu-item" href={app.url} {...here(app.id)}
                                onClick={e => { if (app.id === current) { e.preventDefault(); setOpen(false); } }}>
                                <Icon size={16} aria-hidden={true} />{app.name}
                                {app.id === current && <span className="bassapps-menu-here">Open</span>}
                            </a>
                        );
                    })}
                    <div className="bassapps-menu-sep" role="separator" />
                    <a role="menuitem" className="bassapps-menu-item" href={accountUrl} {...here('account')}
                        onClick={e => { if (current === 'account') { e.preventDefault(); setOpen(false); } }}>
                        <UserRound size={16} aria-hidden="true" />Account
                        {current === 'account' && <span className="bassapps-menu-here">Open</span>}
                    </a>
                    <button type="button" role="menuitem" className="bassapps-menu-item" onClick={() => { setOpen(false); onSignOut(); }}>
                        <LogOut size={16} aria-hidden="true" />Sign out
                    </button>
                </div>,
                document.body,
            )}
        </>
    );
};
