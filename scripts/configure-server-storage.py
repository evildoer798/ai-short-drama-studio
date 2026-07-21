#!/usr/bin/env python3
import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timezone


def quote_env(value):
    value = str(value)
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: configure-server-storage.py <env-file>')

    env_path = os.path.abspath(sys.argv[1])
    payload = json.load(sys.stdin)
    values = payload.get('values')
    if not isinstance(values, dict) or not values:
        raise SystemExit('values object is required')

    with open(env_path, 'r', encoding='utf-8') as handle:
        lines = handle.read().splitlines()

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backup_path = f'{env_path}.before-oss-{timestamp}'
    with open(backup_path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(lines) + '\n')
    os.chmod(backup_path, stat.S_IRUSR | stat.S_IWUSR)

    remaining = dict(values)
    output = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and '=' in line:
            key = line.split('=', 1)[0].strip()
            if key in remaining:
                output.append(f'{key}={quote_env(remaining.pop(key))}')
                continue
        output.append(line)
    if remaining:
        if output and output[-1] != '':
            output.append('')
        output.append('# Alibaba Cloud OSS media storage')
        for key, value in remaining.items():
            output.append(f'{key}={quote_env(value)}')

    directory = os.path.dirname(env_path)
    fd, temporary_path = tempfile.mkstemp(prefix='.env-production-', dir=directory, text=True)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('\n'.join(output) + '\n')
        os.chmod(temporary_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary_path, env_path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)

    print(json.dumps({
        'ok': True,
        'updatedKeys': sorted(values.keys()),
        'backup': backup_path,
    }))


if __name__ == '__main__':
    main()
