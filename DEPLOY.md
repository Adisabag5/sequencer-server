# Deploying Pulse to a Hostinger VPS

One origin: the NestJS server serves the API under `/api` and the built Angular app
everywhere else. One process, one domain, no CORS, and the refresh cookie stays
`SameSite=Lax`.

> **Why a VPS and not Hostinger's web hosting.** The shared/premium tiers are built around
> PHP and give you no way to keep a Node process alive. NestJS needs the VPS tier (which is
> what Hostinger's "Node.js hosting" runs on anyway).

## What runs where

```
                  ┌──────────────── VPS ────────────────┐
  browser ──443──▶│ nginx (TLS)  ──▶  node (port 3000)  │
                  │                      │              │
                  │                      ├─ /api/*   → NestJS
                  │                      └─ anything → index.html
                  │                                     │
                  │                   MySQL ◀───────────┘
                  └─────────────────────────────────────┘
```

nginx is optional on day one — Node can listen on 443 directly — but it is the easier place
to terminate TLS and it is what the rest of this runbook assumes.

## The two repositories, and the domain

Pulse is two GitHub repos, and only one of them runs on the VPS.

| Repo | What goes on the box | How |
|---|---|---|
| `Adisabag5/sequencer-server` | The whole repo, cloned | Runs as a process (pm2) or containers (Compose) |
| `Adisabag5/visual-sequencer` | Only `dist/<project>/browser/`, the built static files | Built on your machine or in CI, copied to `CLIENT_DIST`. Angular does not run on the server — there is nothing to keep alive |

Both are public, so the VPS clones over HTTPS with no credentials:

```bash
git clone https://github.com/Adisabag5/sequencer-server.git /opt/pulse/server
```

If either is ever made private, a **read-only deploy key** per repo is the right answer
(`ssh-keygen` on the VPS, paste the public half into Settings → Deploy keys), not your own
SSH key and not a password.

The frontend needs no change for this: `environment.production.ts` already sets
`apiBaseUrl: '/api'`, and `angular.json` swaps it in for the production build. Same origin,
relative path, no CORS.

### Where to build the frontend

`pnpm build` on the VPS works but puts Node, pnpm and a few hundred MB of
`node_modules` on a box that otherwise only needs Docker — and an Angular build can be
OOM-killed on the smallest plans. Building where you already develop and shipping the
output is the smaller moving part:

```bash
cd ~/DEV/visual-sequencer
pnpm install --frozen-lockfile
pnpm build
rsync -a --delete dist/angular-starter-template/browser/ \
  root@<vps-ip>:/var/www/pulse/client/
```

`--delete` matters: without it, files from an older build stay behind and the browser can
load a stale chunk that no longer matches `index.html`.

### Pointing the domain at it

The domain lives in hPanel; the VPS is just an IP. Two records, at
**hPanel → Domains → DNS Zone**:

| Type | Name | Value |
|---|---|---|
| `A` | `@` | the VPS's IPv4 |
| `A` | `www` | the same IPv4 (or a `CNAME` to the apex) |

Delete any pre-existing `A` record for `@` first — a new domain usually points at
Hostinger's parking page, and two `A` records mean half your visitors land there. If the
VPS has IPv6, add the matching `AAAA` records or drop its `AAAA` entirely; a stale `AAAA`
is the classic "works on my phone, not on my laptop" bug.

```bash
dig +short your-domain          # should print the VPS IP, and nothing else
```

Certbot needs this to resolve before it can issue a certificate, so do it first and give it
a few minutes.

### Firewall

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

Note what is *not* opened: 3000 and 3306. The app is published to `127.0.0.1` only and
nginx reaches it there. Be aware that Docker publishes ports by writing its own iptables
rules, which bypass `ufw` — so `ports: - '3000:3000'` in Compose would be reachable from
the internet even with the firewall up. That is why the compose file binds to loopback.

## One-time setup

**1. Node and MySQL**

Install Node 24 (`.nvmrc`) and MySQL. Create the database and a user that owns only it:

> **Why 24 and not the newest.** Odd-numbered Node releases never become LTS — they stop
> getting security fixes within months, which is the wrong property for a box you intend to
> leave running. Node 24 is the Krypton LTS line. Node 26 (Lithium) is the newer LTS, so
> this is a deliberate choice of the more settled line rather than the latest one; moving
> up later means changing `.nvmrc` and reinstalling on the VPS.


```sql
CREATE DATABASE pulse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pulse'@'localhost' IDENTIFIED BY '<a long random password>';
GRANT ALL PRIVILEGES ON pulse.* TO 'pulse'@'localhost';
FLUSH PRIVILEGES;
```

Do not reuse the dev password, and do not grant anything outside `pulse.*`.

**2. `.env` on the server**

Copy `.env.example` and fill it in. The values that matter in production:

| Key | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns `synchronize` **off**, migrations **on**, and `secure` on the cookie. Getting this wrong is the worst single mistake available here. |
| `JWT_SECRET` | `openssl rand -base64 48` | Never the dev value. |
| `JWT_REFRESH_SECRET` | a **different** `openssl rand -base64 48` | A leaked access secret must not mint refresh tokens. |
| `CORS_ORIGIN` | `https://your-domain` | Unused while single-origin, but it is validated at boot, so it must be present and real. |
| `CLIENT_DIST` | `/var/www/pulse/client` | Absolute path to the Angular build. Omit it and the server is API-only. |
| `TRUST_PROXY` | `1` | nginx sits in front, so without it every request looks like it came from nginx and **all visitors share one rate-limit bucket** — a few sign-in attempts would lock out everyone. Omit it if you expose Node directly, or clients can forge `X-Forwarded-For` and dodge the limit. |
| `DB_*` | the database above | |

`validateEnv` fails the boot on a missing or malformed key, so a bad `.env` stops the
server instead of surfacing later as a confusing runtime error.

**3. TLS**

Point the domain at the VPS, then Let's Encrypt via certbot. The refresh cookie is `Secure`
in production, so **without HTTPS nobody can stay signed in** — the browser will refuse to
store it.

## Each deploy

```bash
# 1. Frontend — built wherever you build, copied to CLIENT_DIST
cd visual-sequencer
pnpm install --frozen-lockfile
pnpm build
rsync -a --delete dist/angular-starter-template/browser/ user@vps:/var/www/pulse/client/

# 2. Backend
cd sequencer-server
git pull
pnpm install --frozen-lockfile
pnpm build
pm2 restart pulse-api        # or: systemctl restart pulse-api
```

Pending migrations run **at boot** in production (`migrationsRun: true`), so the schema can
never be older than the code. To see what will run before restarting:

```bash
pnpm migration:show
```

### Keeping it alive

```bash
pm2 start dist/main.js --name pulse-api
pm2 save && pm2 startup     # survive a reboot
```

`enableShutdownHooks()` is on, so a `SIGTERM` from pm2 or systemd closes the database pool
and finishes in-flight requests instead of cutting them off.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain;

  # certbot fills these in
  ssl_certificate     /etc/letsencrypt/live/your-domain/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Running it with Docker

Everything above assumes Node installed on the VPS, pm2 keeping it alive, and nginx plus
certbot in front. The alternative is `Dockerfile` + `docker-compose.yml` in this repo: one
command brings up **Traefik, the API and MySQL**, and the box needs nothing installed but
Docker. On this path the nginx and certbot sections above do not apply — Traefik is the
reverse proxy and it obtains the certificates itself.

> **Which to pick.** pm2 is fewer moving parts and lets you `pnpm migration:show` on the
> spot. Docker gives you the same image on your laptop and the server, MySQL you never
> installed by hand, TLS without a renewal cron, and restart policies that survive a reboot
> without `pm2 startup`. They are alternatives — running both means two things fighting
> over port 443.

### What the image is

Two stages (`Dockerfile`). The builder installs every dependency and runs `pnpm build`;
the final image gets only `dist/` and the production `node_modules`, runs as the
unprivileged `node` user, and has `NODE_ENV=production` baked in — so the thing that
decides whether TypeORM reshapes your schema is a property of the image, not of a file
somebody might forget to edit.

### What Traefik is doing

Traefik is the reverse proxy, and it replaces three things from the first half of this
file: the nginx server block, certbot, and the renewal timer. It reads its configuration
from **container labels** over the Docker socket, so routing a service means describing it
on the service itself:

```yaml
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.pulse.rule=Host(`${DOMAIN}`)'
      - 'traefik.http.routers.pulse.entrypoints=websecure'
      - 'traefik.http.routers.pulse.tls.certresolver=letsencrypt'
      - 'traefik.http.services.pulse.loadbalancer.server.port=3000'
```

Four things about that setup are deliberate:

- **`exposedbydefault=false`.** A container is routed only if it says `traefik.enable=true`.
  Without it, every container in the project — the database included — would get a route.
- **The HTTP→HTTPS redirect is on the entrypoint**, not on each router. One rule no new
  service can forget.
- **The ACME challenge is TLS-ALPN**, answered on 443, which Traefik already owns. No DNS
  API token and no webroot shared with the app.
- **No dashboard.** It needs `--api.insecure=true`, and a published port is reachable from
  the internet whatever `ufw` says, so it would be a public map of every route on the box.

**`www` gets its own router, which only redirects.** If the DNS has a `www` record — and
Hostinger adds one by default — it needs a router, or visitors typing `www.` get a
*certificate* error rather than a 404. TLS is negotiated before any routing happens, so
with no router asking for a certificate that covers `www`, Traefik falls back to its
self-signed default and the browser refuses before it can be redirected anywhere. A second
router fixes that, and the certificate ends up carrying both names.

A redirect rather than serving the app on both names, because the session design assumes
one origin: the refresh cookie is set on the apex and `CORS_ORIGIN` lists the apex, so
answering on `www` too would hand a visitor a cookie scoped to the wrong host and fail in
ways that are painful to reproduce. The apex router deliberately carries no middleware, so
nothing sits between a visitor and the site.

Traefik answers a permanent `redirectregex` with **308**, not 301, which preserves the
request method — a POST to `www` arrives at the apex as a POST. The path and query survive
too, through the regex capture.

Two Traefik-specific failure modes worth knowing before the first deploy. The
`letsencrypt` volume holds `acme.json`, which holds the certificate private keys: lose it
and every redeploy asks Let's Encrypt for new certificates, which has a weekly limit you
can reach while debugging. And the Docker socket is mounted into Traefik — read-only, but
still root-equivalent on the host, which is the price of label-based discovery.

```bash
docker compose logs -f reverse-proxy   # certificate acquisition shows up here
```

### First run

```bash
# On the VPS, in the repo
cp -n .env.example .env  # -n: refuses to overwrite an existing .env
```

Two Compose-only keys on top of that table:

| Key | Value | Why |
|---|---|---|
| `DB_ROOT_PASSWORD` | `openssl rand -base64 24` | The MySQL container's root password. The app never uses it; the image initialises with it. Compose refuses to start without it. |
| `DOMAIN` | `pulse.example.com` | The host Traefik routes, and the name on the certificate. Bare hostname, no scheme. It must already resolve to this VPS. |
| `ACME_EMAIL` | your mailbox | Where Let's Encrypt sends expiry warnings. |

`DB_USER` must not be `root` — the MySQL image refuses to create a user that already
exists. Use the application user from the SQL at the top of this file.

`DB_HOST`, `DB_PORT`, `NODE_ENV`, `PORT` and `TRUST_PROXY` are set by `docker-compose.yml`
and override whatever `.env` says. `DB_HOST` is `db`, the service name: inside a container
`localhost` is the container itself, which is the most common reason a dockerised app
cannot find its database.

```bash
docker compose up -d --build
docker compose logs -f app              # watch the migrations run
curl -s https://$DOMAIN/api/health      # {"status":"ok","database":"up"}
```

Nothing but Traefik publishes a port, so there is no `localhost:3000` to curl any more.
To reach the app without going through DNS and TLS at all:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
```

The database lives in a named volume (`db-data`), so `docker compose down` keeps it and
only `docker compose down -v` destroys it. MySQL is **not** published to the host at all —
the app reaches it over the Compose network.

### Each deploy

```bash
git pull
docker compose up -d --build
```

Compose rebuilds the image, starts the new container and stops the old one — a gap of a
few seconds, which is the honest cost of running one instance. Pending migrations still
run at boot (`migrationsRun: true` in production), so there is no separate migration step,
and Traefik picks up the replacement container by itself.

### Backing up the database

The `db-data` volume is the only thing on this box that cannot be rebuilt from git.
`ops/backup-db.sh` dumps it through the running container, gzips it, verifies the dump
and rotates the old ones. It runs on the **host**, not inside a container.

Run it once by hand before trusting it to cron:

```bash
BACKUP_DIR=~/backups/pulse ops/backup-db.sh
```

It prints the file it wrote and its size, then lists anything it deleted. A fresh database
dumps to a handful of KB; if it comes out at a few hundred bytes, the dump is empty and
something is wrong with the credentials rather than with the script.

Then schedule it as `adi` — no `sudo`, because the account is already in the `docker`
group, and because files under your own home are trivial to copy off the box later:

```bash
crontab -e
```

```cron
30 3 * * * BACKUP_DIR=/home/adi/backups/pulse /home/adi/pulse/ops/backup-db.sh >> /home/adi/backups/pulse.log 2>&1
```

Four things about that line, each of which is a way cron jobs silently never run:

- **Absolute paths, always.** cron starts in `$HOME` with a near-empty `PATH`
  (`/usr/bin:/bin`), and none of your shell profile is loaded. `docker` is in `/usr/bin`
  so it resolves, but the script itself will not if you write `ops/backup-db.sh`.
- **Redirect the output.** Without `>>`, cron mails it to the local user, and on a VPS
  with no mail transport configured that output is simply discarded — including the error
  that tells you why the backup failed.
- **The schedule is in the server's timezone**, not yours. `timedatectl` says which; a
  fresh VPS is usually UTC. 03:30 is deliberately not 03:00 — every other cron job on
  every other box also runs at 03:00.
- **`-T` is why this works at all.** cron has no TTY, and `docker compose exec` without
  `-T` tries to allocate one and fails. It is already in the script; don't remove it.

Check it after the first night:

```bash
ls -lh ~/backups/pulse/
tail ~/backups/pulse.log
```

**Then get a copy off the box.** A backup that lives on the same disk as the database
survives a bad migration or a dropped table, and nothing else — not a failed disk, not a
deleted VPS, not a compromised host. From your Mac:

```bash
rsync -avz --delete adi@72.61.84.20:backups/pulse/ ~/backups/pulse/
```

Those dumps contain bcrypt password hashes and refresh-token hashes, which is why the
script writes them `0600` in a `0700` directory. Treat the local copies the same way.

**Restoring** is in the comment header of `ops/backup-db.sh`, including how to practise it
against a scratch database. Do that once while nothing is at stake — an untested restore
is a hope, not a backup.

### Serving the frontend from the container

`CLIENT_DIST` in `.env` is a **host** path, and the container cannot see it — the server
will refuse to boot and say exactly that. Mount the build in and point at the path inside
the container instead. In `docker-compose.yml`, uncomment the app's `volumes:` block:

```yaml
    volumes:
      - /var/www/pulse/client:/srv/client:ro
```

and add one line to the `environment:` block that is already there — a second
`environment:` key in the same service is a YAML error, not an override:

```yaml
      CLIENT_DIST: /srv/client
```

Then the whole site is one router and one certificate: `/api/*` is the API, everything else
is the Angular app with its deep-link fallback. Same origin, so no CORS and the refresh
cookie stays `SameSite=Lax`.

### With Dokploy

Dokploy is a PaaS you host yourself — it owns Traefik, Let's Encrypt and the Docker
daemon on the VPS. That replaces three sections of this runbook: no nginx server block, no
certbot, no pm2, and no `.env` file edited over SSH. What stays is the `Dockerfile`.

**Create it as an Application with build type `Dockerfile`, plus a managed MySQL
service** — not a Compose service, and not a Template (those are one-click recipes for
existing open-source projects, not a way to deploy your own repo).

Nixpacks is Dokploy's default build type and is the wrong choice here: it would run
`pnpm start` — `nest start`, which wants the Nest CLI at runtime — and nothing would set
`NODE_ENV=production`, which is what keeps TypeORM's `synchronize` away from a real
schema. The image in this repo settles both by construction. Dokploy's own docs also warn
that Nixpacks and Heroku builds "can lead to timeout on your server or even freezing your
server", which is the OOM note above in different words.

| Dokploy field | Value |
|---|---|
| Build Type | `Dockerfile` |
| Dockerfile Path | `Dockerfile` |
| Docker Context Path | *(blank — the repo root)* |
| Docker Build Stage | *(blank; the last stage, `runner`, is the one wanted)* |
| Domains → Container Port | `3000` |
| Domains → HTTPS + Certificate | on, `letsencrypt` |

The **Environment** tab is the `.env`: the same keys as the table above, with two
differences. `DB_HOST` is the **Internal Host** value shown on the MySQL service's
*Connection* tab (Dokploy's hostname, not `db` and not `localhost`), and `TRUST_PROXY=1`
because Traefik is the one proxy hop in front. `NODE_ENV` and `PORT` are already baked
into the image, so they are optional there.

Scheduled backups to S3 are a tab on the managed database, which is most of the argument
for using it instead of running MySQL yourself in a Compose service.

**If you do choose the Compose type**, `docker-compose.yml` here needs three edits, because
it was written for plain Docker on a VPS:

1. Add `dokploy-network` to **both** services. Dokploy attaches it only to the service you
   point the domain at, and the app then cannot reach the database.
2. Drop the `reverse-proxy` service and the app's `traefik.*` labels. Dokploy runs its own
   Traefik and writes its own labels; two of them on one box fight over 80 and 443.
3. Bind mounts must be relative, like `../files/client`. Dokploy says absolute host paths
   "will be cleaned up during deployments" — exactly what the commented-out
   `/var/www/pulse/client` mount is.

The UI's environment variables are written to a `.env` next to the compose file rather than
injected into containers, which this file already expects (`env_file: .env`), so that part
needs no change.

**The frontend** becomes a second Dokploy Application from the `visual-sequencer` repo with
build type `Static` (its domain wants container port **80**). Give it the apex host with
path `/`, and give the API the *same* host with path `/api` and **Strip Path off** — every
server route lives under that prefix. Same host means the single-origin reasoning this
whole file rests on still holds: no CORS, and the refresh cookie stays `SameSite=Lax`.
`CLIENT_DIST` then goes unset, because Nest is no longer the thing serving the client.

Dokploy's docs recommend building in CI and deploying a prebuilt image (Source Type
`Docker`) rather than building on the VPS. That is the upgrade path once the build starts
straining the box: GitHub Actions builds this same `Dockerfile`, pushes to GHCR, and
Dokploy pulls it.

### Without Compose

The image is useful on its own, against a MySQL you already run:

```bash
docker build -t sequencer-server .
docker run -d --name pulse-api --restart unless-stopped \
  --env-file .env -e NODE_ENV=production -e TRUST_PROXY=1 \
  -p 127.0.0.1:3000:3000 sequencer-server
```

`DB_HOST` then has to be something the container can reach — `host.docker.internal` on
Docker Desktop, or the host's bridge IP on Linux. `localhost` will not work.

### Docker-specific things that will bite

- **Publishing a port "just to test".** Docker writes its own iptables rules, so
  `ports: - '3000:3000'` is reachable from the internet even when `ufw` says that port is
  closed — the API served without TLS, right next to the Traefik that has it. Only Traefik
  publishes anything in this compose file. To poke at the app, `docker compose exec` into
  it or bind to `127.0.0.1` explicitly.
- **A certificate that will not issue.** Almost always DNS: `DOMAIN` must resolve to this
  VPS *before* Traefik asks, or the TLS-ALPN challenge fails. `docker compose logs
  reverse-proxy` says which. Debug against the staging CA (the commented line in the
  compose file) so a few failed attempts do not spend the weekly budget on the real one.
- **`docker compose down -v`.** The `-v` drops the volume, and the database with it.
- **Admins.** `pnpm set-role` needs ts-node, which the production image does not have. Run
  it inside the running container with the compiled code, or against the database directly:
  `docker compose exec db mysql -u root -p -e "UPDATE pulse.users SET role='ADMIN' WHERE email='you@example.com';"`
- **Building on your laptop and pushing the image.** An Apple Silicon Mac builds `arm64`;
  most VPS plans are `amd64`, and the container then refuses to start ("exec format
  error"). Build on the VPS, which is what the commands above do, or pass
  `--platform linux/amd64`.
- **A 1 GB VPS.** `--build` compiles TypeScript on the server and can be OOM-killed on the
  smallest plans. Either add swap, or build elsewhere and push the image to a registry.
- **A changed `DB_NAME` or `DB_USER` after first boot.** The MySQL image only creates them
  on an empty volume; on an existing one it ignores those variables and the app fails to
  connect to a database nobody created.

## Checking it worked

```bash
curl https://your-domain/api/health      # {"status":"ok","database":"up"}
# eleventh sign-in attempt in a minute should be 429, not 401
for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code} " -X POST \
  https://your-domain/api/auth/signin -H 'Content-Type: application/json' \
  --data '{"email":"nobody@example.invalid","password":"wrong"}'; done; echo
curl -I https://your-domain/             # 200, text/html
curl -I https://your-domain/auth         # 200 — deep links reach the router
```

Then sign in through the UI and reload the page. If the session survives the reload, the
refresh cookie is being set and returned correctly, which exercises TLS, the cookie flags
and the `/api/auth` path in one go.

## First admin

Roles are not settable through the API — signup is public, so a settable role would let
anyone mint an admin. Promote out of band, on the server.

On the **pm2** path, where the repo and its dev dependencies are both present:

```bash
pnpm set-role you@example.com ADMIN
```

On the **Docker** path, call the compiled script directly. The runner image carries
production dependencies only, so there is no pnpm in it to run the package script, and
`pnpm set-role` fails with `command not found`:

```bash
docker compose exec app node dist/scripts/set-role.js you@example.com ADMIN
```

It runs inside the app container, so it reuses that container's validated config and
database connection — no `.env` to pass and no host MySQL client needed. Sign up through
the API first; the script promotes an account that already exists.

## Things that will bite

- **`NODE_ENV` not `production`.** `synchronize` comes back on and TypeORM will reshape the
  schema to match the entities, dropping columns and their data. Check it first, every time.
- **No HTTPS.** The cookie is `Secure`; sessions silently never persist.
- **`CLIENT_DIST` pointing at `dist/angular-starter-template` instead of its `browser/`
  subdirectory.** Angular puts `index.html` one level down. The server refuses to boot
  rather than serve nothing, so you will see this immediately.
- **A stale `dist/`.** `pnpm build` before restarting; pm2 runs the compiled output, not
  the sources.
- **`TRUST_PROXY` unset behind nginx.** Sign-in is limited to 10 attempts a minute *per IP*,
  and without this every visitor counts as the same IP. The symptom is users getting 429s
  they did nothing to deserve.
- **Rate-limit counts are per process and in memory.** Restarting clears them, and a second
  instance would double the real limit. Fine for one VPS; not fine the day you scale out.
