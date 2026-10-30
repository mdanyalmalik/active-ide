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

# 5. Active's settings come first in the Settings editor, and its model choices are commonly used.
patch(
    "src/vs/workbench/contrib/preferences/browser/settingsLayout.ts",
    "\tchildren: [\n\t\t{\n\t\t\tid: 'editor',\n",
    "\tchildren: [\n\t\t{\n\t\t\tid: 'active',\n\t\t\tlabel: localize('activeSettings', \"Active\"),\n\t\t\tsettings: ['active.*'],\n\t\t\tchildren: [\n\t\t\t\t{ id: 'active/coding', label: localize('activeCoding', \"Coding Agent\"), settings: ['active.coding.*', 'active.agent.*', 'active.muse.*'] },\n\t\t\t\t{ id: 'active/explanation', label: localize('activeExplanation', \"Explanations\"), settings: ['active.explanation.*', 'active.explain.*', 'active.walkthrough.*'] },\n\t\t\t\t{ id: 'active/narration', label: localize('activeNarration', \"Voice\"), settings: ['active.narration.*'] },\n\t\t\t]\n\t\t},\n\t\t{\n\t\t\tid: 'editor',\n",
    "id: 'active/coding'",
)
patch(
    "src/vs/workbench/contrib/preferences/browser/settingsLayout.ts",
    "const COMMONLY_USED_SETTINGS: readonly string[] = [\n",
    "const COMMONLY_USED_SETTINGS: readonly string[] = [\n\t'active.coding.model',\n\t'active.coding.reasoningEffort',\n\t'active.explanation.model',\n\t'active.explanation.reasoningEffort',\n\t'active.narration.voice',\n",
    "'active.coding.reasoningEffort',",
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
