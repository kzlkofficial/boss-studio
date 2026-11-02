#!/usr/bin/env python3
"""Rebuild the original bundled sprites JS from the PNG assets in this project."""
from pathlib import Path
import base64
import json
import sys

root = Path(__file__).resolve().parent.parent
config = json.loads((root / 'boss-config.json').read_text(encoding='utf-8-sig'))
paths = sorted({str(sprite) for boss in config['bosses'] for sprite in boss['sprites'].values()})
missing = [path for path in paths if not (root / path).is_file()]
if missing:
    print('Missing PNG files: ' + ', '.join(missing), file=sys.stderr)
    sys.exit(1)
assets = {
    path: base64.b64encode((root / path).read_bytes()).decode('ascii')
    for path in paths
}
output = root / 'assets-embedded.js'
output.write_text('window.BS_BUNDLED_ASSETS = ' + json.dumps(assets, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
print(f'Created {output.name} from {len(assets)} original PNG sprites.')
