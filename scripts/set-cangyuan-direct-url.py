import os
import sys
from pathlib import Path
from urllib.parse import urlparse


DIRECT_URL_KEY = "CANGYUAN_DIRECT_API_BASE_URL"
URL_KEYS = {
    "OPENAI_COMPAT_BASE_URL",
    "TEXT_API_BASE_URL",
    "TEXT_FALLBACK_API_BASE_URL",
    "TEXT_TERTIARY_API_BASE_URL",
    "VIDEO_API_BASE_URL",
    "VIDEO_DIRECT_API_BASE_URL",
    "GROK_VIDEO_API_BASE_URL",
}


def unquoted(value):
    stripped = value.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in {'"', "'"}:
        return stripped[1:-1]
    return stripped


def quoted_like(original, value):
    stripped = original.strip()
    quote = stripped[0] if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in {'"', "'"} else ""
    return f"{quote}{value}{quote}"


def cangyuan_path(value):
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if not (parsed.hostname or "").lower().endswith(".cangyuansuanli.cn"):
        return None
    path = parsed.path.rstrip("/")
    return f"{path}{'?' + parsed.query if parsed.query else ''}"


def main():
    if len(sys.argv) not in {2, 3}:
        print("usage: set-cangyuan-direct-url.py <env-file> [direct-base-url]", file=sys.stderr)
        return 2

    path = Path(sys.argv[1]).resolve()
    direct = (sys.argv[2] if len(sys.argv) == 3 else "http://direct-api.cangyuansuanli.cn").rstrip("/")
    lines = path.read_text(encoding="utf-8").splitlines()
    output = []
    changed = []
    has_direct_key = False

    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            output.append(line)
            continue
        key, raw_value = line.split("=", 1)
        normalized_key = key.strip()
        if normalized_key == DIRECT_URL_KEY:
            output.append(f"{key}={quoted_like(raw_value, direct)}")
            has_direct_key = True
            changed.append(normalized_key)
            continue
        suffix = cangyuan_path(unquoted(raw_value)) if normalized_key in URL_KEYS else None
        if suffix is None:
            output.append(line)
            continue
        output.append(f"{key}={quoted_like(raw_value, direct + suffix)}")
        changed.append(normalized_key)

    if not has_direct_key:
        output.append(f'{DIRECT_URL_KEY}="{direct}"')
        changed.append(DIRECT_URL_KEY)

    mode = path.stat().st_mode
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("\n".join(output) + "\n", encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)
    print("updated=" + ",".join(sorted(set(changed))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
