#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image.tar> <image-tag>" >&2
  exit 2
fi
IMAGE_TAR="$1"
IMAGE_TAG="$2"
COMPOSE_FILES="${COMPOSE_FILES:-compose.yaml}"
[ -s "$IMAGE_TAR" ] || { echo "image artifact is missing or empty" >&2; exit 2; }
[ -f .env ] || { echo "deployment .env is required" >&2; exit 2; }

BACKUP="$(./deploy/backup.sh)"
PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' terrafield-atlas-web-1 2>/dev/null || true)"
echo "pre-release backup: $BACKUP"

docker load -i "$IMAGE_TAR"
export IMAGE_TAG

rollback() {
  echo "release gate failed; restoring database and previous image" >&2
# shellcheck disable=SC2086
  docker compose $COMPOSE_FILES stop web web-secondary worker scheduler outbox > /dev/null 2>&1 || true
  docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-terrafield}" --clean --if-exists --no-owner --exit-on-error < "$BACKUP" > /dev/null
  if [ -n "$PREVIOUS_IMAGE" ]; then
    docker tag "$PREVIOUS_IMAGE" terrafield-atlas:rollback
    # shellcheck disable=SC2086
    IMAGE_TAG=rollback docker compose $COMPOSE_FILES up -d web web-secondary worker scheduler outbox caddy > /dev/null
  else
    # shellcheck disable=SC2086
    IMAGE_TAG="$IMAGE_TAG" docker compose $COMPOSE_FILES up -d web web-secondary worker scheduler outbox caddy > /dev/null
  fi
  exit 1
}
trap rollback ERR INT TERM

# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up -d --wait migrate web web-secondary worker scheduler outbox caddy prometheus grafana

READY_URL="${NEXTAUTH_URL%/}/api/v1/readyz"
for attempt in $(seq 1 60); do
  CODE="$(curl -sS -o /tmp/terrafield-ready.json -w '%{http_code}' "$READY_URL" || true)"
  echo "readiness attempt $attempt -> $CODE"
  if [ "$CODE" = "200" ]; then
    curl -fsS "${NEXTAUTH_URL%/}/api/v1/health" > /dev/null
    trap - ERR INT TERM
    echo "release $IMAGE_TAG is ready"
    exit 0
  fi
  sleep 5
done
echo "readiness gate timed out" >&2
exit 1
