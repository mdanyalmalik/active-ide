/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import * as resources from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { DecorationsService } from '../../../../services/decorations/browser/decorationsService.js';
import { IDecorationData, IDecorationsProvider } from '../../../../services/decorations/common/decorations.js';

/**
 * The decorations filter Active adds to Code OSS (scripts/apply_patches.py): it lets the "Agent" mode hide
 * git's change decorations everywhere decorations are shown, while keeping everything else.
 */
suite('Active: decorations filter', () => {
	let service: DecorationsService;

	setup(() => {
		service = new DecorationsService(new class extends mock<IUriIdentityService>() { override extUri = resources.extUri; }, new TestThemeService());
	});

	// Before the leak check, which runs in a teardown registered after this one.
	teardown(() => service.dispose());

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const file = URI.parse('file:///project/src/a.ts');
	const provider = (label: string, data: IDecorationData): IDecorationsProvider => ({ label, onDidChange: Event.None, provideDecorations: () => data });
	const tooltip = (uri: URI, includeChildren = false) => {
		const decoration = service.getDecoration(uri, includeChildren);
		decoration?.dispose();
		return decoration?.tooltip;
	};

	test('hides what the filter rejects, keeps the rest, and restores it when the filter goes away', () => {
		store.add(service.registerDecorationsProvider(provider('vscode.git', { letter: 'M', tooltip: 'git', color: 'gitDecoration.modifiedResourceForeground' })));
		store.add(service.registerDecorationsProvider(provider('markers', { tooltip: 'problems' })));
		const changes: boolean[] = [];
		store.add(service.onDidChangeDecorations(event => changes.push(event.affectsResource(file))));
		const filterChanged = store.add(new Emitter<void>());
		let hideGit = true;
		const filter = service.registerDecorationsFilter({ onDidChange: filterChanged.event, accepts: label => !(hideGit && label === 'vscode.git') });
		assert.deepStrictEqual([tooltip(file), changes], ['problems', [true]]);
		hideGit = false;
		filterChanged.fire();
		assert.deepStrictEqual([tooltip(file), changes], ['problems • git', [true, true]]);
		hideGit = true;
		filterChanged.fire();
		filter.dispose();
		assert.deepStrictEqual([tooltip(file), changes.length], ['problems • git', 4]);
	});

	test('a folder\'s dot for changes inside it follows the filter too', () => {
		store.add(service.registerDecorationsProvider(provider('vscode.git', { letter: 'M', tooltip: 'git', bubble: true })));
		const folder = URI.parse('file:///project/src');
		tooltip(file);
		assert.ok(tooltip(folder, true));
		const filter = service.registerDecorationsFilter({ onDidChange: Event.None, accepts: label => label !== 'vscode.git' });
		assert.strictEqual(tooltip(folder, true), undefined);
		filter.dispose();
	});

	test('the filter sees the data, so some of a provider\'s decorations can be kept', () => {
		store.add(service.registerDecorationsProvider(provider('vscode.git', { tooltip: 'ignored', color: 'gitDecoration.ignoredResourceForeground' })));
		const filter = service.registerDecorationsFilter({ onDidChange: Event.None, accepts: (label, data) => label !== 'vscode.git' || data.color === 'gitDecoration.ignoredResourceForeground' });
		assert.strictEqual(tooltip(file), 'ignored');
		filter.dispose();
	});
});
