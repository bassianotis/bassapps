// What a signed-in computer is called on the Account page ("Chrome on macOS"), from its browser's
// User-Agent. Only the browser and system are named; anything not recognised says so.

export function computerName(userAgent: string | null): { name: string; kind: 'laptop' | 'desktop' } {
    const ua = userAgent ?? '';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
            : /Firefox\//.test(ua) ? 'Firefox'
                : /(Chrome|CriOS)\//.test(ua) ? 'Chrome'
                    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
                        : 'Unknown browser';
    const system = /iPhone|iPad/.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /Windows/.test(ua) ? 'Windows'
                : /CrOS/.test(ua) ? 'ChromeOS'
                    : /Android/.test(ua) ? 'Android'
                        : /Linux/.test(ua) ? 'Linux'
                            : 'an unknown system';
    // A Mac is most often a laptop; nothing in a browser says which it is
    return { name: `${browser} on ${system}`, kind: system === 'macOS' ? 'laptop' : 'desktop' };
}

/** The address a sign-in came from, as shown: this machine's own address (::1, 127.x) reads "localhost". */
export function shownAddress(ip: string | null): string | null {
    return ip && (ip === '::1' || /^127\./.test(ip)) ? 'localhost' : ip;
}
