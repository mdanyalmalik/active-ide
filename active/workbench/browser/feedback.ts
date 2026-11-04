/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IActiveService } from './activeService.js';

/** Where reports go. If this is ever emptied, the report is copied to the clipboard instead. */
export const FEEDBACK_EMAIL = 'feedback.danyal@gmail.com';
export const REPORT_ISSUE_COMMAND_ID = 'active.reportIssue';

type Kind = 'bug' | 'feature';

/** The prefilled email: a short template to fill in, then the facts that help triage. */
export function feedbackEmail(kind: Kind, title: string, facts: ReadonlyArray<[string, string]>): { subject: string; body: string } {
	const subject = kind === 'bug' ? `[Active bug] ${title}` : `[Active idea] ${title}`;
	const template = kind === 'bug'
		? ['What happened:', '', '', 'What you expected:', '', '', 'Steps to reproduce:', '1. ', '']
		: ['What you would like:', '', '', 'Why it would help:', '', ''];
	const body = [...template, '--', ...facts.map(([label, value]) => `${label}: ${value}`)].join('\n');
	return { subject, body };
}

/** A mailto link with the subject and body encoded for any mail app. */
export function mailtoLink(address: string, subject: string, body: string): string {
	return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REPORT_ISSUE_COMMAND_ID,
			title: localize2('reportIssue', "Report a Bug or Request a Feature"),
			category: localize2('activeCategory', "Active"),
			icon: Codicon.feedback,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const opener = accessor.get(IOpenerService);
		const clipboard = accessor.get(IClipboardService);
		const notifications = accessor.get(INotificationService);
		const product = accessor.get(IProductService);
		const active = accessor.get(IActiveService);

		type KindItem = IQuickPickItem & { kind: Kind };
		const picked = await quickInput.pick<KindItem>([
			{ kind: 'bug', label: localize('reportBug', "Report a Bug"), description: localize('reportBugDetail', "Something didn't work") },
			{ kind: 'feature', label: localize('requestFeature', "Request a Feature"), description: localize('requestFeatureDetail', "An idea or improvement") },
		], { placeHolder: localize('feedbackKind', "What would you like to send?") });
		if (!picked) {
			return;
		}
		const title = await quickInput.input({
			prompt: picked.kind === 'bug' ? localize('bugTitle', "In a few words, what went wrong?") : localize('featureTitle', "In a few words, what would you like?"),
			validateInput: async value => value.trim() ? undefined : localize('feedbackTitleNeeded', "Add a short title."),
		});
		if (!title?.trim()) {
			return;
		}

		const os = OS === OperatingSystem.Macintosh ? 'macOS' : OS === OperatingSystem.Windows ? 'Windows' : 'Linux';
		const agent = active.agent;
		const facts: Array<[string, string]> = [
			['Active', `${product.nameLong} ${product.version}${product.commit ? ` (${product.commit.slice(0, 8)})` : ''}`],
			// Just the platform: Chromium's user agent freezes the OS version (every Mac says 10_15_7).
			['OS', os],
			['Agent', agent.host ?? agent.provider.name],
			['Explanations', active.mode],
			['Agents', String(active.agents.filter(item => item.kind === 'agent' && !item.mergedInto).length)],
			...(active.remote ? [['Session', `guest (${active.remote.role})`] as [string, string]] : []),
		];
		const { subject, body } = feedbackEmail(picked.kind, title.trim(), facts);

		if (!FEEDBACK_EMAIL) {
			await clipboard.writeText(`${subject}\n\n${body}`);
			notifications.info(localize('feedbackCopied', "The report is copied to your clipboard. Paste it into an email to the Active team."));
			return;
		}
		// A string, not a URI: the opener passes strings through as is, but re-encodes a URI's query (doubling every %).
		await opener.open(mailtoLink(FEEDBACK_EMAIL, subject, body), { openExternal: true });
	}
});
