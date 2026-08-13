#!/bin/sh
set -eu

kind="${1:-}"
shift || true

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

chown 10001:10001 /tmp/database-password
if [ "$kind" = application ]; then
  chown 10001:10001 /tmp/application-pepper
fi

exec /usr/bin/setpriv \
  --reuid=10001 \
  --regid=10001 \
  --clear-groups \
  --no-new-privs \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
