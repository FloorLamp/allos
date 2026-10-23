#!/bin/sh
# Bind the declared Allos environment resources after the manifest update (FP-3348).
# area: resource-bindings
# after: 0008-resource-bindings
# provides: secrets.ai secrets.allowed-dev-origins secrets.capcom-url secrets.deck-origin secrets.deck-ui-channel secrets.habitat-token
set -eu
. "$STEP_LIB"
python3 - "$1" "$STEP_RESOURCES" "$STEP_COMPOSE/.env" <<'PY'
import fcntl
import json
import os
import signal
import sys
import tempfile
from pathlib import Path

mode, path, source = sys.argv[1:]
if mode not in ('check', 'run'):
    sys.exit(2)
bindings = {
    name: {'kind': 'env', 'source': source, 'key': key}
    for name, key in (
        ('allowed-dev-origins', 'ALLOWED_DEV_ORIGINS'),
        ('capcom-url', 'CAPCOM_URL'),
        ('deck-origin', 'DECK_ORIGIN'),
        ('deck-ui-channel', 'DECK_UI_CHANNEL'),
        ('habitat-token', 'HABITAT_TOKEN'),
    )
}
if mode == 'check':
    config = json.loads(Path(path).read_text())
    secrets = config['apps']['allos']['secrets']
    sys.exit(int('ai' in secrets or any(secrets.get(k) != v for k, v in bindings.items())))
# Serialize writers on a stable lock file and reread inside the lock. Replace
# atomically so other apps' resource gates never read a partial policy.
with open(path + '.lock', 'a') as lock:
    signal.alarm(10)
    fcntl.flock(lock, fcntl.LOCK_EX)
    signal.alarm(0)
    policy = Path(path)
    original = policy.read_text()
    config = json.loads(original)
    secrets = config['apps']['allos']['secrets']
    if 'ai' not in secrets and all(secrets.get(k) == v for k, v in bindings.items()):
        sys.exit(0)
    secrets.pop('ai', None)
    secrets.update(bindings)
    fd, candidate = tempfile.mkstemp(dir=policy.parent, prefix='.allos-resources-')
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), policy.stat().st_mode & 0o777)
            json.dump(config, output, indent=2)
            output.write('\n')
        # Refuse a stale write if a writer outside this lock changed the policy.
        if policy.read_text() != original:
            sys.exit('STEP_ERROR: resource policy changed; retry the step')
        os.replace(candidate, path)
    finally:
        if os.path.exists(candidate):
            os.unlink(candidate)
PY
