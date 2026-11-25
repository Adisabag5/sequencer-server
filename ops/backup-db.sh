#!/usr/bin/env bash
#
# MySQL backup for the Compose stack. Runs on the VPS *host*, from cron — not
# inside a container, and not on a dev machine.
#
#   ops/backup-db.sh
#
# Writes $BACKUP_DIR/pulse-YYYY-MM-DD_HHMMSS.sql.gz, verifies it, then deletes
# dumps older than RETENTION_DAYS. Override either from the environment:
#
#   BACKUP_DIR=/mnt/backups RETENTION_DAYS=30 ops/backup-db.sh
#
# Restore — DESTRUCTIVE, it overwrites the live database:
#
#   gzip -dc /var/backups/pulse/pulse-2026-11-25_030000.sql.gz \
#     | docker compose exec -T db \
#         sh -c 'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
#
# A backup you have never restored is a hope, not a backup. Practise it once
# against a scratch database before you need it:
#
#   docker compose exec db sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE restore_test"'
#   gzip -dc <dump> | docker compose exec -T db sh -c 'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" restore_test'
#
set -euo pipefail

# The dump contains bcrypt password hashes and refresh-token hashes. 0600 files
# in a 0700 directory, so no other account on the box can read them.
umask 077

# Resolve the repo from this script's own location, so cron needs no `cd` and a
# wrong working directory cannot silently act on a different compose project.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO/docker-compose.yml")

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pulse}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

out="$BACKUP_DIR/pulse-$(date +%Y-%m-%d_%H%M%S).sql.gz"
tmp="$out.partial"

# Never leave a half-written file sitting there looking like a backup.
trap 'rm -f "$tmp"' EXIT

# The password is read from the container's own environment, so it appears
# neither in this file, nor in the crontab, nor in `ps` output on the host.
#
# -T                   no TTY — cron has none, and without this the exec fails.
# --single-transaction consistent snapshot of InnoDB without locking the
#                      tables, so the app keeps serving while the dump runs.
# --no-tablespaces     skips the one statement needing the PROCESS privilege,
#                      which keeps this working if you ever dump as the app
#                      user instead of root.
# --routines --triggers schema objects mysqldump would otherwise leave behind.
"${COMPOSE[@]}" exec -T db sh -c '
  exec mysqldump \
    -u root -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --no-tablespaces --routines --triggers \
    "$MYSQL_DATABASE"
' | gzip -c >"$tmp"

# mysqldump writes "-- Dump completed on ..." as its last line. Checking for it
# catches a dump that died halfway, which happens with an exit status of 0 often
# enough to matter.
if ! gzip -dc "$tmp" | tail -n 5 | grep -q 'Dump completed'; then
  echo "backup-db: dump looks truncated, refusing to keep it" >&2
  exit 1
fi

mv "$tmp" "$out"
trap - EXIT

echo "backup-db: wrote $out ($(du -h "$out" | cut -f1))"

# Retention runs last, and only after a verified dump: a failed backup must not
# also delete the history that is still good.
find "$BACKUP_DIR" -maxdepth 1 -name 'pulse-*.sql.gz' -type f \
  -mtime "+$RETENTION_DAYS" -print -delete
