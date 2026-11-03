/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import type { IActiveService, SessionParticipant } from '../activeService.js';

const $ = dom.$;

/** A person's colour in a session (`--active-person-N`, distinct from the agent colours). */
export function personColor(colorIndex: number): string {
	return `var(--active-person-${colorIndex % 6})`;
}

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

/** Everyone else looking at this agent (not this window's own person). */
export function peopleOn(activeService: IActiveService, agentId: string): SessionParticipant[] {
	return activeService.presence.filter(person => person.agentId === agentId && person.id !== activeService.presenceSelfId);
}

/** Small initials badges, in each person's colour, for whoever is looking at `agentId`. */
export function renderPresenceBadges(parent: HTMLElement, activeService: IActiveService, agentId: string): void {
	const people = peopleOn(activeService, agentId);
	if (!people.length) {
		return;
	}
	const group = dom.append(parent, $('span.active-presence-badges'));
	for (const person of people.slice(0, 4)) {
		const badge = dom.append(group, $('span.active-presence-badge'));
		badge.style.setProperty('--person-color', personColor(person.colorIndex));
		badge.textContent = initials(person.name);
		badge.title = localize('personHere', "{0} is looking at this agent", person.name);
	}
	if (people.length > 4) {
		dom.append(group, $('span.active-presence-more')).textContent = `+${people.length - 4}`;
	}
}

/** The legend in the chat header: who's in the session, their colour and role, and what they're looking at. */
export function renderPresenceLegend(parent: HTMLElement, activeService: IActiveService): void {
	dom.clearNode(parent);
	const people = activeService.presence;
	parent.classList.toggle('hidden', !people.length);
	if (!people.length) {
		return;
	}
	// Compact, for the header: name in the person's colour; role and where they are on hover.
	for (const person of people) {
		const chip = dom.append(parent, $('span.active-presence-person'));
		chip.style.setProperty('--person-color', personColor(person.colorIndex));
		dom.append(chip, $('span.active-presence-swatch'));
		const self = person.id === activeService.presenceSelfId;
		dom.append(chip, $('span.active-presence-name')).textContent = self ? localize('personYou', "{0} (you)", person.name) : person.name;
		const role = person.role === 'host' ? localize('roleHost', "host") : person.role === 'collaborator' ? localize('roleCollaborator', "collaborator") : localize('roleViewer', "viewer");
		const agent = person.agentId ? activeService.agentInfo(person.agentId)?.name : undefined;
		chip.title = agent ? localize('personTitleOn', "{0} · {1} · on {2}", person.name, role, agent) : localize('personTitle', "{0} · {1}", person.name, role);
	}
}
