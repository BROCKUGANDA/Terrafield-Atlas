#!/bin/sh
set -eu
cd /home/ubuntu/ai-azimara-terrafield
if ! grep -q '^SESSION_SECRET=..' .env; then
  cp -p .env .env.before-session-secret-20261119
  python3 - <<'PY'
import secrets
from pathlib import Path
p = Path('.env')
p.write_text(p.read_text() + '\nSESSION_SECRET=' + secrets.token_hex(48) + '\n')
PY
fi
chmod 600 .env
printf 'Persistent session secret configured (value withheld).\n'