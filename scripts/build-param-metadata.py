#!/usr/bin/env python3
"""Generate src/protocol/param-metadata.json from the vendored SFD source.

Runs ArduPilot's param_parse.py against the submodule, flattens the
grouped output into a name->meta map, slims to the fields we actually
display, and writes minified JSON the Vite build can import.

Re-run after bumping vendor/smallfastdrone:

    bun run params:rebuild
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SFD_PARAM = REPO_ROOT / "vendor" / "smallfastdrone" / "Tools" / "autotest" / "param_metadata"
OUT = REPO_ROOT / "src" / "protocol" / "param-metadata.json"

# Source field -> our camelCase field. Anything not listed is dropped.
FIELD_MAP = (
    ("DisplayName", "displayName"),
    ("Description", "description"),
    ("Units", "units"),
    ("Range", "range"),
    ("Bitmask", "bitmask"),
    ("Values", "values"),
    ("User", "user"),
    ("RebootRequired", "rebootRequired"),
    ("ReadOnly", "readOnly"),
)


def main() -> int:
    if not SFD_PARAM.is_dir():
        print("vendor/smallfastdrone is not initialised — run: bun run setup", file=sys.stderr)
        return 1

    # Generate raw apm.pdef.json from the SFD source. param_parse.py needs
    # to run from its own directory; we use a subprocess + cwd.
    subprocess.run(
        [sys.executable, str(SFD_PARAM / "param_parse.py"),
         "--vehicle", "ArduCopter", "--format", "json"],
        cwd=SFD_PARAM,
        check=True,
    )

    raw_file = SFD_PARAM / "apm.pdef.json"
    raw = json.loads(raw_file.read_text())

    flat: dict[str, dict] = {}
    for group in raw.values():
        if not isinstance(group, dict):
            continue
        for name, p in group.items():
            if not isinstance(p, dict):
                continue
            slim = {}
            for src_key, dst_key in FIELD_MAP:
                v = p.get(src_key)
                if v not in (None, "", {}, []):
                    slim[dst_key] = v
            flat[name] = slim

    flat_sorted = dict(sorted(flat.items()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Minified — Vite gzips it again at serve time, and we don't want
    # human-edit bait in src/protocol/.
    OUT.write_text(json.dumps(flat_sorted, separators=(",", ":")))
    print(f"wrote {len(flat_sorted)} params to {OUT.relative_to(REPO_ROOT)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
