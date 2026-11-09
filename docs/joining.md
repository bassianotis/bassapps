# How an app joins the Bassapps sign-in (contract v1)

For apps that welcome accounts: today **Mail**, next **Tasks**. Other apps stay independent and can appear in someone's apps menu as one of their own links.

An app never sees a passphrase. It sends the person to the sign-in service, gets a one-time code back, swaps it for **its own token** (kept in its own host-only cookie), and checks that token with the service whenever it's used.

## The flow
1. **Not signed in:** the app sets a random `state` in a short-lived cookie (SameSite=Lax, 10 minutes), then redirects to
   `https://account.bassapps.net/sign-in?app=<id>&state=<state>&return=<path>[&reason=<why>]`
   - `return` is a path on the app's own site (it starts with `/`; never `//`, never a backslash).
   - `reason` sets the notice on the sign-in page: `ended`, `everywhere` or `passphrase` (none for "signed out here").
2. **Signed in:** the service redirects to
   `<app url>/api/v2/auth/callback?code=<code>&state=<state>&return=<path>`.
   The app checks that `state` matches its cookie, swaps the code (below), sets its own cookie, and redirects to `return` (checked again).
3. **Every request:** the app verifies its token (below). It may keep a good answer for up to 30 seconds. A bad answer says why; the app says so to the person (`reading-safety-and-sessions.md` §2 in the Mail repo has the words).
4. **Sign out in the app:** the app calls sign-out (below), which ends this computer's session for every app, then sends the person to the sign-in page.

## The calls (`/internal/v1`, server to server only)
Every call sends the shared secret as `X-Door-Secret` (the service's `internal.key`). The proxy also returns 404 for `/internal/` from outside.

| Call | Body | Answer |
|---|---|---|
| `POST /internal/v1/exchange` | `{ code, app }` | `{ token, user: { id, username } }`, or 400 (unknown, used, older than a minute, another app's, or no access) |
| `POST /internal/v1/verify` | `{ token }` | `{ ok: true, user, sessionId, apps: [ids] }` or `{ ok: false, reason }` |
| `POST /internal/v1/sign-out` | `{ token }` | `{ ok: true }` |
| `GET /internal/v1/apps` | | `{ apps: [{ id, name, url }], accountUrl }` |

**Why a session ended** (`reason`):
- `expired`: unused for 30 days;
- `signed-out`: signed out on this computer;
- `removed`: signed out from Account on another computer;
- `everywhere`: Sign out everywhere, from another computer;
- `passphrase`: the passphrase was changed on another computer, or reset on the server;
- `no-access`: this login may no longer use the app;
- `unknown`: not a token the service knows.

**`apps` in a good answer** are the ids this login may use. An app's own apps menu lists only those.

## What an app keeps to itself
- **Its own data, and who may use it.** Mail, for example, also checks the username against its own owner list (`MAIL_USERS`), so a second Bassapps login can never see the owner's mail.
- **Its own cookie:** HttpOnly, SameSite=Strict, Secure, and host-only, so no other site under bassapps.net sees it.

## Calls the service makes to an app
- `POST <app internal url>/internal/v1/notify` with `{ subject, text, fromName }` and the same secret. Mail uses it to send the new-computer email from the person's own account.
