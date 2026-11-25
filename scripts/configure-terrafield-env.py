import json
import os
import shutil
import sys
from pathlib import Path

target = Path('/home/ubuntu/ai-azimara-terrafield/.env')
payload = json.load(sys.stdin)
original = target.read_text()
values = {}
for line in original.splitlines():
    if '=' in line and not line.startswith('#'):
        key, value = line.split('=', 1)
        values[key] = value
updates = dict(payload['updates'])
for key, value in payload.get('defaults', {}).items():
    if not values.get(key):
        updates[key] = value
for key, value in updates.items():
    if not key.replace('_', '').isalnum() or '\n' in value or '\r' in value or '"' in value:
        raise ValueError('Unsafe environment entry')
backup = target.with_name('.env.before-provider-setup-20261119')
if not backup.exists():
    shutil.copy2(target, backup)
lines = [line for line in original.splitlines() if line.split('=', 1)[0] not in updates]
lines.extend(f'{key}="{value}"' for key, value in updates.items())
temporary = target.with_name('.env.provider-update')
temporary.touch(mode=0o600, exist_ok=False)
temporary.write_text('\n'.join(lines) + '\n')
os.replace(temporary, target)
os.chmod(target, 0o600)
print('Configured variable names only:', ', '.join(sorted(updates)))