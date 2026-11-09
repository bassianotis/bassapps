# Bassapps

One sign-in for a family of self-hosted apps. Today it signs people in to [Electronic Mail](https://github.com/bassianotis/electronic-mail); Tasks is next. It's a small service of its own: a sign-in page, an Account page, and the private calls apps use to check who someone is.

## How it works
- **Each computer gets a session.**
  - It's a random token in the service's own cookie, and only its hash is stored.
  - A session lasts while it's used, and ends after 30 days unused.
  - From Account you can sign out one computer, or every one; changing the passphrase signs out the others.
- **Apps never see a passphrase.**
  - An app sends the person here to sign in, gets a one-time code back, and swaps it for a token of its own, kept in its own cookie.
  - It checks that token with the service whenever it's used.
  - When a session ends, the service says why (unused, signed out here, signed out from another computer, passphrase changed), so the app can show the right message.
- **Each login has a list of apps it may use.** The service checks it at every step, and an app can refuse logins it doesn't belong to.
- **Limits on attempts:**
  - 10 failures from one address in 15 minutes;
  - 20 failures for one username in an hour, but only from computers that have never signed in. A computer that has carries a signed "known computer" mark, so a stranger can't lock you out of your own computers.

  A wrong username and a wrong passphrase look the same.
- **A new computer signing in triggers an email.** Mail sends it, from the person's own account.
- **Passphrases** are stored as bcrypt hashes, need at least 12 characters, and are reset only on the server itself: there's no reset by email.

`docs/joining.md` is the contract an app follows to join.

## Layout
- `service/`: the service (Node, TypeScript run directly, with Node's built-in SQLite):
  - `src/door.ts`: the rules (sessions, codes, tokens, limits, passphrases, app access);
  - `src/server.ts`: the HTTP side, for the pages (`/door-api/…`) and for apps (`/internal/v1/…`);
  - `bin/door.ts` runs it; `bin/bassapps.ts` holds the commands; `bin/backup.ts` makes a checked backup.
- `pages/`: the sign-in and Account pages (React and Vite).
- `Dockerfile`: the container (it builds the pages itself); `deploy/`: a compose file for a Raspberry Pi, and a settings template.
- `tools/bassapps` runs the commands; `tools/ship-pi.sh` builds and ships to the Pi.

## Run it with Mail
You need a computer or server with Docker. This starts Bassapps and [Electronic Mail](https://github.com/bassianotis/electronic-mail) together, with Mail built straight from GitHub:

```bash
git clone https://github.com/bassianotis/bassapps.git
cd bassapps
cp .env.example .env      # the two addresses, and the username Mail accepts (MAIL_USERS)
docker compose up -d
docker compose exec -it account node service/bin/bassapps.ts reset-passphrase <username>
```

The last line creates your login, with the same username as `MAIL_USERS`. Then open http://localhost:3100, sign in, and add your email accounts.

- **From other computers:** in `.env`, use your HTTPS addresses (e.g. `https://account.example.net` and `https://mail.example.net`) and set `SECURE_COOKIES=1` and `TRUST_PROXY=1`. Then point your reverse proxy at ports 3102 and 3100, and have it return 404 for `/internal/` on both.
- **Updating:** `git pull && docker compose up -d --build`.
- **Backing up:** each keeps a checked copy, which `docker compose cp` brings out:
  ```bash
  docker compose exec account node service/bin/backup.ts /data/backup && docker compose cp account:/data/backup ./account-backup
  docker compose exec mail node engine/bin/backup.ts /data/backup && docker compose cp mail:/data/backup ./mail-backup
  ```
- **How they're joined:** the two share one secret, `internal.key`. Bassapps creates it on its first start, in a volume of its own, and Mail can read only that file.

## Working on it
You need Node 22.18 or newer (24 LTS recommended).

```bash
npm install
npm test && npm run typecheck
tools/bassapps reset-passphrase <username>    # creates the first login (data goes in ./data)
npm run service                               # the service, on 127.0.0.1:3102
npm run pages                                 # the pages, on http://localhost:5175 (they talk to the service)
```

## In production
One container: the service, serving its built pages itself. It sits behind an HTTPS reverse proxy, which should return 404 for `/internal/`.

On a Raspberry Pi, `tools/ship-pi.sh` builds the image on your computer, sends it to the Pi over SSH, backs up, starts it and waits until it's healthy (`--back` returns to the version before). Its settings (the Pi, the service's address, the apps, the time zone) go in `private/install.env`: copy `deploy/install.env.example` there. Git leaves `private/` alone.

| Setting | What |
|---|---|
| `DOOR_PUBLIC_URL` | Its own address, e.g. `https://account.example.net`. With `SECURE_COOKIES=1` it must be https. It's also the link in the new-computer email. |
| `DOOR_APPS` | The apps, as JSON: `[{"id":"mail","name":"Mail","url":"https://mail.example.net"}]` |
| `SECURE_COOKIES=1` | When served over HTTPS |
| `TRUST_PROXY=1` | Believe `X-Forwarded-For` (only behind your own proxy) |
| `MAIL_INTERNAL_URL` | Where Mail listens, for the new-computer email |
| `DOOR_DATA_DIR` | `door.sqlite`, `door.key` and `internal.key` (the secret apps share). Back them up together. |
| `DOOR_SECRET_FILE` | `internal.key` somewhere else, such as a folder shared with the apps, so they see only it |
| `DOOR_HOST`, `DOOR_PORT`, `DOOR_STATIC`, `DOOR_COOKIE`, `DOOR_KNOWN_COOKIE` | Where it listens, its built pages, and its cookie names |

## Commands
`tools/bassapps` (on a server with the container, simply `bassapps`):
- `reset-passphrase [username]`: asks twice, with your typing hidden. It creates the login if needed, and signs out every computer.
- `apps <username> [* | mail,tasks]`: shows or sets which apps a login may use.
- `import-user <username> <app.sqlite> [mail login]`: moves an existing Mail login over, with the same passphrase.

## Backups
`service/bin/backup.ts <folder>` writes a checked copy of `door.sqlite` and both keys (`internal.key` from `DOOR_SECRET_FILE` when it's set). Electronic Mail's nightly backup on the Pi runs it.

## License
GPL-3.0. See `LICENSE`.
