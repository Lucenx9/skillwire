#!/bin/sh
set -eu

kind="${1:-}"
shift || true
runtime_uid="${SKILLWIRE_RUNTIME_UID:-10001}"
runtime_gid="${SKILLWIRE_RUNTIME_GID:-10001}"
case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:|*:*:*) echo "invalid runtime uid/gid" >&2; exit 64 ;;
esac

case "$kind" in
  database)
    cp /run/secrets/database_password /tmp/database-password
    chmod 0600 /tmp/database-password
    export SKILLWIRE_DATABASE_PASSWORD_FILE=/tmp/database-password
    ;;
  application)
    cp /run/secrets/database_password /tmp/database-password
    cp /run/secrets/application_pepper /tmp/application-pepper
    chmod 0600 /tmp/database-password /tmp/application-pepper
    export SKILLWIRE_DATABASE_PASSWORD_FILE=/tmp/database-password
    export SKILLWIRE_API_KEY_PEPPER_FILE=/tmp/application-pepper
    ;;
  *)
    echo "invalid secret entrypoint mode" >&2
    exit 64
    ;;
esac

chown "$runtime_uid:$runtime_gid" /tmp/database-password
if [ "$kind" = application ]; then
  chown "$runtime_uid:$runtime_gid" /tmp/application-pepper
fi

exec /usr/bin/setpriv \
  --reuid="$runtime_uid" \
  --regid="$runtime_gid" \
  --clear-groups \
  --no-new-privs \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
