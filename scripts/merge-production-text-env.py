#!/usr/bin/env python3
import os
import stat
import sys
import tempfile
from datetime import datetime, timezone


REQUIRED_KEYS = {
    'TEXT_API_BASE_URL',
    'TEXT_API_KEY',
    'TEXT_API_MODE',
    'TEXT_MODEL',
}


def parse_env(path):
    values = {}
    with open(path, 'r', encoding='utf-8') as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            values[key] = value
    return values


def quote_env(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: merge-production-text-env.py <source-env> <target-env>')

    source_path = os.path.abspath(sys.argv[1])
    target_path = os.path.abspath(sys.argv[2])
    source_values = parse_env(source_path)
    text_values = {key: value for key, value in source_values.items() if key.startswith('TEXT_')}
    missing = sorted(REQUIRED_KEYS - text_values.keys())
    if missing:
        raise SystemExit(f'source text configuration is incomplete: {", ".join(missing)}')

    with open(target_path, 'r', encoding='utf-8') as handle:
        target_lines = handle.read().splitlines()

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backup_path = f'{target_path}.before-text-sync-{timestamp}'
    with open(backup_path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(target_lines) + '\n')
    os.chmod(backup_path, stat.S_IRUSR | stat.S_IWUSR)

    remaining = dict(text_values)
    output = []
    for line in target_lines:
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and '=' in line:
            key = line.split('=', 1)[0].strip()
            if key.startswith('TEXT_'):
                if key in remaining:
                    output.append(f'{key}={quote_env(remaining.pop(key))}')
                continue
        output.append(line)

    if remaining:
        if output and output[-1] != '':
            output.append('')
        output.append('# Text provider failover configuration')
        for key in sorted(remaining):
            output.append(f'{key}={quote_env(remaining[key])}')

    directory = os.path.dirname(target_path)
    fd, temporary_path = tempfile.mkstemp(prefix='.env-text-sync-', dir=directory, text=True)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('\n'.join(output) + '\n')
        os.chmod(temporary_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary_path, target_path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)

    primary_slots = sum(bool(text_values.get(f'TEXT_API_KEY_{index}')) for index in range(1, 11))
    fallback_slots = sum(bool(text_values.get(f'TEXT_FALLBACK_API_KEY_{index}')) for index in range(1, 11))
    tertiary_slots = sum(bool(text_values.get(f'TEXT_TERTIARY_API_KEY_{index}')) for index in range(1, 11))
    print(
        'TEXT_ENV_SYNC_OK '
        f'keys={len(text_values)} primary_slots={primary_slots} '
        f'fallback_slots={fallback_slots} tertiary_slots={tertiary_slots}'
    )


if __name__ == '__main__':
    main()
