# Deployment guide

This guide puts the school portal on a small Linux server (a VPS, or a computer on the school
network) with HTTPS, automatic start, backups and a tested restore. It assumes Ubuntu or Debian.
Commands that start with `sudo` need an administrator account on the server.

> This guide describes good practice. It is not a certification of security or legal compliance.
> Before storing real pupils' information, the school must check its own data-protection and
> child-protection obligations.

## 1. Install

```bash
sudo apt update && sudo apt install -y nodejs npm sqlite3   # Node.js 20 or newer is required
node --version
sudo useradd --system --create-home --home-dir /opt/school school
sudo -u school git clone https://github.com/ALMOUZZAMMIL/CFMA-School.git /opt/school/app
cd /opt/school/app && sudo -u school npm install --omit=dev
sudo -u school cp .env.example .env
```

Edit `/opt/school/app/.env`:

```ini
NODE_ENV=production
HOST=127.0.0.1          # only Caddy (below) talks to the app
PORT=3000
TRUST_PROXY=1
DATABASE_FILE=/opt/school/data/school.db
BACKUP_DIR=/opt/school/backups
```

The server and the `npm run` commands (backup, restore, create-admin, seed) all read this file.
The server checks these values when it starts. A typo (for example `PORT=eighty`) stops it with
a clear message instead of running with a wrong setting.

## 2. First administrator (never use the demo data in production)

```bash
cd /opt/school/app && sudo -u school npm run create-admin -- admin.name "Full Name"
```

A temporary password is printed once and must be changed at the first sign-in.

Protections in place:

- `npm run seed` (demo data) refuses to run when `NODE_ENV=production`.
- `npm run seed -- --reset` refuses any database that has real (non-demo) accounts, and writes a
  verified backup before deleting a demo database.
- The server refuses to start in production on a demo database (`demo_mode=1`), unless
  `ALLOW_DEMO_IN_PRODUCTION=1` is set on purpose for a public demonstration site.

## 3. Run as a service (systemd)

`/etc/systemd/system/school.service`:

```ini
[Unit]
Description=School portal
After=network.target

[Service]
User=school
WorkingDirectory=/opt/school/app
ExecStart=/usr/bin/node server.js
Restart=on-failure
# The app finishes current requests and closes the database on stop (up to 10 seconds).
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now school
sudo journalctl -u school -f      # logs: one JSON object per line
```

Each error page shows a short reference code. Search for it in the logs to find the matching
error: `sudo journalctl -u school | grep <code>`.

## 4. HTTPS with Caddy

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
portal.example-school.cm {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews a free certificate. In production the app also sends
`Strict-Transport-Security`, so browsers keep using HTTPS. Only turn production mode on once
HTTPS works, because sign-in cookies are then HTTPS-only.

## 5. Monitoring

`GET /healthz` needs no sign-in and returns `{"status":"ok","database":"ok","schemaVersion":3,...}`,
or HTTP 503 if the database cannot be read. Point a free uptime monitor at
`https://<your-domain>/healthz`.

## 6. Backups

- **Before every database upgrade**, the app writes a verified copy (`school-pre-migration-…db`)
  and stops if the copy fails. Each upgrade step runs inside a transaction and is rolled back if
  it fails.
- **Every 24 hours** while running, it writes `school-auto-…db` and keeps the newest 14
  (`BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`).
- **By hand:** `npm run backup` (safe while the server runs).

Every copy is checked with SQLite's `integrity_check`. Copies on the same disk do not protect
against a disk failure or theft, so also copy `/opt/school/backups` elsewhere every day, for
example:

```bash
# crontab -e (as the school user): every night at 02:30, copy to a second disk
30 2 * * * rsync -a /opt/school/backups/ /mnt/second-disk/school-backups/
```

## 7. Restore

```bash
sudo systemctl stop school
cd /opt/school/app
sudo -u school npm run restore -- /opt/school/backups/school-auto-YYYYMMDD-HHMMSS.db --yes
sudo systemctl start school
```

The restore checks the backup first and refuses a damaged file. It saves the current database as
`school-pre-restore-…db` before replacing it, so a restore can be undone. Test a restore on
a spare computer at least once a term.

## 8. Updating the application

```bash
cd /opt/school/app && sudo -u school git pull && sudo -u school npm install --omit=dev
sudo systemctl restart school
```

Database changes run automatically at start, after a verified backup.

## Sign-in timeouts

| Role | Signed out after no activity for | Longest sign-in |
| --- | --- | --- |
| Administrator | 30 minutes | 12 hours |
| Bursar | 30 minutes | 12 hours |
| Teacher | 4 hours | 7 days (`SESSION_DAYS`) |
| Parent | 2 hours | 7 days |
| Student | 1 hour | 7 days |

These can be changed with `IDLE_MINUTES_<ROLE>` and `SESSION_MAX_HOURS_PRIVILEGED` in `.env`.
