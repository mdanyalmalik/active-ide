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

# 6. A filter on file decorations, so Active can show the agent's changes instead of git's in the
#    Explorer, editor tabs and breadcrumbs (Active's "Agent" / "Git" switch).
patch(
    "src/vs/workbench/services/decorations/common/decorations.ts",
    "export interface IResourceDecorationChangeEvent {",
    "/**\n * Hides decorations it rejects, wherever decorations are shown. `providerLabel` is the provider's label\n * (an extension's identifier for decorations contributed by extensions).\n */\nexport interface IDecorationsFilter {\n\treadonly onDidChange: Event<void>;\n\taccepts(providerLabel: string, data: IDecorationData): boolean;\n}\n\nexport interface IResourceDecorationChangeEvent {",
    "export interface IDecorationsFilter",
)
patch(
    "src/vs/workbench/services/decorations/common/decorations.ts",
    "\tregisterDecorationsProvider(provider: IDecorationsProvider): IDisposable;\n",
    "\tregisterDecorationsProvider(provider: IDecorationsProvider): IDisposable;\n\n\tregisterDecorationsFilter(filter: IDecorationsFilter): IDisposable;\n",
    "registerDecorationsFilter(filter: IDecorationsFilter): IDisposable;",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "import { IDecorationsService, IDecoration, IResourceDecorationChangeEvent, IDecorationsProvider, IDecorationData } from '../common/decorations.js';",
    "import { IDecorationsService, IDecoration, IResourceDecorationChangeEvent, IDecorationsProvider, IDecorationData, IDecorationsFilter } from '../common/decorations.js';",
    "IDecorationData, IDecorationsFilter } from '../common/decorations.js';",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\tprivate readonly _provider = new LinkedList<IDecorationsProvider>();\n",
    "\tprivate readonly _provider = new LinkedList<IDecorationsProvider>();\n\tprivate readonly _filters = new Set<IDecorationsFilter>();\n",
    "private readonly _filters = new Set<IDecorationsFilter>();",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\tprivate _ensureEntry(uri: URI): DecorationEntry {",
    "\tregisterDecorationsFilter(filter: IDecorationsFilter): IDisposable {\n\t\tconst everything = () => this._onDidChangeDecorations.fire({ affectsResource() { return true; } });\n\t\tthis._filters.add(filter);\n\t\tconst listener = filter.onDidChange(everything);\n\t\teverything();\n\t\treturn toDisposable(() => {\n\t\t\tthis._filters.delete(filter);\n\t\t\tlistener.dispose();\n\t\t\teverything();\n\t\t});\n\t}\n\n\tprivate _accepts(provider: IDecorationsProvider, data: IDecorationData): boolean {\n\t\tfor (const filter of this._filters) {\n\t\t\tif (!filter.accepts(provider.label, data)) {\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}\n\t\treturn true;\n\t}\n\n\tprivate _ensureEntry(uri: URI): DecorationEntry {",
    "registerDecorationsFilter(filter: IDecorationsFilter): IDisposable {",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\t\t\tif (data && !(data instanceof DecorationDataRequest)) {\n\t\t\t\t// having data\n\t\t\t\tall.push(data);",
    "\t\t\tif (data && !(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {\n\t\t\t\t// having data\n\t\t\t\tall.push(data);",
    "!(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {\n\t\t\t\t// having data",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\t\t\t\t\tfor (const data of tuple[1].values()) {\n\t\t\t\t\t\tif (data && !(data instanceof DecorationDataRequest)) {",
    "\t\t\t\t\tfor (const [provider, data] of tuple[1]) {\n\t\t\t\t\t\tif (data && !(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {",
    "for (const [provider, data] of tuple[1]) {",
)
patch(
    "src/vs/workbench/test/browser/workbenchTestServices.ts",
    "\tregisterDecorationsProvider(_provider: IDecorationsProvider): IDisposable { return Disposable.None; }\n",
    "\tregisterDecorationsProvider(_provider: IDecorationsProvider): IDisposable { return Disposable.None; }\n\tregisterDecorationsFilter(): IDisposable { return Disposable.None; }\n",
    "registerDecorationsFilter(): IDisposable { return Disposable.None; }",
)

# 7. Active's walkthrough guides the Explorer: it outlines the file being explained and opens the folders
#    on the way to it (closing them again afterwards). It needs the Explorer's tree and where a row sits.
patch(
    "src/vs/base/browser/ui/tree/asyncDataTree.ts",
    "\tgetRelativeTop(element: T): number | null {\n\t\treturn this.tree.getRelativeTop(this.getDataNode(element));\n\t}\n",
    "\tgetRelativeTop(element: T): number | null {\n\t\treturn this.tree.getRelativeTop(this.getDataNode(element));\n\t}\n\n\t/** The element's top in the tree's content, or `undefined` when it isn't shown (Active). */\n\tgetElementTop(element: T): number | undefined {\n\t\treturn this.nodes.has(element) ? this.tree.getElementTop(this.getDataNode(element)) : undefined;\n\t}\n",
    "getElementTop(element: T): number | undefined {",
)
patch(
    "src/vs/workbench/contrib/files/browser/views/explorerView.ts",
    "\thasFocus(): boolean {\n",
    "\t/** The files tree, for Active's walkthrough guide (an outline on the file being explained). */\n\tget activeTree(): WorkbenchCompressibleAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem, FuzzyScore> {\n\t\treturn this.tree;\n\t}\n\n\thasFocus(): boolean {\n",
    "get activeTree(): WorkbenchCompressibleAsyncDataTree",
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
