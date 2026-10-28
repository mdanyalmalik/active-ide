#!/usr/bin/env python3
"""Idempotent edits to the Code OSS checkout. Everything else Active needs lives in
src/vs/workbench/contrib/active and extensions/active-agent."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])


def patch(path, old, new, marker):
    file = root / path
    text = file.read_text()
    if marker in text:
        return
    if old not in text:
        sys.exit(f"patch anchor not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))
    print(f"patched {path}")


# 1. Load the Active workbench contribution.
patch(
    "src/vs/workbench/workbench.common.main.ts",
    "import './contrib/files/browser/files.contribution.js';",
    "import './contrib/files/browser/files.contribution.js';\n\n// Active\nimport './contrib/active/browser/active.contribution.js';",
    "contrib/active/browser/active.contribution.js",
)

# 2. Let narration audio (generated in memory, never saved) play from blob: URLs.
for html in ("src/vs/code/electron-browser/workbench/workbench.html", "src/vs/code/electron-browser/workbench/workbench-dev.html"):
    patch(html, "media-src\n\t\t\t\t\t'self'\n", "media-src\n\t\t\t\t\t'self'\n\t\t\t\t\tblob:\n", "'self'\n\t\t\t\t\tblob:\n\t\t\t\t;\n\t\t\t\tframe-src")

# 3. Walkthrough narration starts automatically when chat hands off to it.
patch(
    "src/vs/platform/windows/electron-main/windows.ts",
    "autoplayPolicy: 'user-gesture-required',",
    "autoplayPolicy: 'no-user-gesture-required', // Active: narrated walkthroughs start on handoff",
    "Active: narrated walkthroughs start on handoff",
)

# 4. Branding.
product_path = root / "product.json"
product = json.loads(product_path.read_text())
branding = {
    "nameShort": "Active",
    "nameLong": "Active",
    "applicationName": "active",
    "dataFolderName": ".active-ide",
    "darwinBundleIdentifier": "dev.active.ide",
    "urlProtocol": "active",
}
if any(product.get(key) != value for key, value in branding.items()):
    product.update(branding)
    product_path.write_text(json.dumps(product, indent="\t") + "\n")
    print("patched product.json")
