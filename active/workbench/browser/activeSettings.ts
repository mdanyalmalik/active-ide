/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ActiveSetting, AgentModelInfo, REASONING_EFFORTS } from '../common/activeProtocol.js';

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Models Muse Code 1.4 offers; replaced by the live list once the agent connects. */
export const KNOWN_MODELS: readonly AgentModelInfo[] = [
	{ id: 'muse-spark-1.3-contributor', label: 'muse-spark-1.3-contributor', inputCost: '0.10', outputCost: '0.20', isDefault: true, efforts: [...REASONING_EFFORTS], description: 'Discounted tokens: your content may be used for product improvement.' },
	{ id: 'muse-spark-1.3', label: 'muse-spark-1.3', inputCost: '1.25', outputCost: '4.25', efforts: [...REASONING_EFFORTS] },
	{ id: 'muse-wonder-1.0', label: 'muse-wonder-1.0', inputCost: '4', outputCost: '20', efforts: [...REASONING_EFFORTS] },
];

const EFFORT_DESCRIPTIONS: Record<string, string> = {
	default: localize('effortDefault', "The agent's own default for the model."),
	minimal: localize('effortMinimal', "Fastest and cheapest; almost no deliberation."),
	low: localize('effortLow', "Quick, with light reasoning."),
	medium: localize('effortMedium', "Balanced speed and depth."),
	high: localize('effortHigh', "Thinks carefully before acting."),
	xhigh: localize('effortXhigh', "Deep analysis for complex work."),
	max: localize('effortMax', "Deepest reasoning; slowest and most expensive."),
};

/** Labels for the effort tiers, shared with the chat's effort picker. */
export function effortLabel(effort: string): string {
	switch (effort) {
		case 'minimal': return localize('effortMinimalLabel', "Minimal");
		case 'low': return localize('effortLowLabel', "Low");
		case 'medium': return localize('effortMediumLabel', "Medium");
		case 'high': return localize('effortHighLabel', "High");
		case 'xhigh': return localize('effortXhighLabel', "Extra High");
		case 'max': return localize('effortMaxLabel', "Max");
		default: return localize('effortDefaultLabel', "Default");
	}
}

export function effortDescription(effort: string): string {
	return EFFORT_DESCRIPTIONS[effort] ?? '';
}

function modelSchema(models: readonly AgentModelInfo[], description: string): IConfigurationPropertySchema {
	return {
		type: 'string',
		default: '',
		enum: ['', ...models.map(model => model.id)],
		enumItemLabels: [localize('modelDefaultLabel', "Default"), ...models.map(model => model.label)],
		enumDescriptions: [
			localize('modelDefault', "The agent's default model."),
			...models.map(model => {
				const cost = model.inputCost && model.outputCost ? localize('modelCost', "${0} in / ${1} out per million tokens.", model.inputCost, model.outputCost) : '';
				return [cost, model.description ?? ''].filter(Boolean).join(' ');
			}),
		],
		markdownDescription: description,
		scope: ConfigurationScope.APPLICATION,
		tags: ['active'],
	};
}

function effortSchema(defaultEffort: string, description: string): IConfigurationPropertySchema {
	const values = ['default', ...REASONING_EFFORTS];
	return {
		type: 'string',
		default: defaultEffort,
		enum: values,
		enumItemLabels: values.map(effortLabel),
		enumDescriptions: values.map(effortDescription),
		markdownDescription: description,
		scope: ConfigurationScope.APPLICATION,
		tags: ['active'],
	};
}

function modelNode(models: readonly AgentModelInfo[]): IConfigurationNode {
	return {
		id: 'activeModels',
		title: localize('activeTitle', "Active"),
		order: 0,
		type: 'object',
		properties: {
			[ActiveSetting.CodingModel]: modelSchema(models, localize('codingModel', "Model the coding agent writes code with. Prices are per million tokens.")),
			[ActiveSetting.CodingEffort]: effortSchema('default', localize('codingEffort', "How much the coding agent reasons before acting. Higher is slower and costs more; also changeable next to the chat input.")),
			[ActiveSetting.ExplanationModel]: modelSchema(models, localize('explanationModel', "Model that plans walkthroughs and answers questions about changes.")),
			[ActiveSetting.ExplanationEffort]: effortSchema('low', localize('explanationEffort', "How much the explanation model reasons. `Low` keeps walkthroughs quick (about 20 seconds instead of a minute or more) and is usually enough.")),
		},
	};
}

let currentModelNode = registry.registerConfiguration(modelNode(KNOWN_MODELS));

/** Replaces the model choices with what the agent actually offers. */
export function updateModelChoices(models: readonly AgentModelInfo[]): void {
	if (!models.length) {
		return;
	}
	const next = modelNode(models);
	registry.updateConfigurations({ add: [next], remove: [currentModelNode] });
	currentModelNode = next;
}

const general: IConfigurationNode = {
	id: 'activeGeneral',
	title: localize('activeTitle', "Active"),
	order: 1,
	type: 'object',
	properties: {
		[ActiveSetting.NarrationVoice]: {
			type: 'string',
			default: '',
			markdownDescription: localize('narrationVoice', "Phonon voice for walkthrough narration. Empty uses Phonon's default; `off` turns narration off (walkthroughs are read with Previous and Next). Pick and preview voices with **Active: Choose Narration Voice** or the status bar."),
			scope: ConfigurationScope.APPLICATION,
		},
		[ActiveSetting.NarrationSpeed]: {
			type: 'number',
			default: 1,
			minimum: 0.75,
			maximum: 1.75,
			description: localize('narrationSpeed', "Narration speed (0.75 to 1.75)."),
			scope: ConfigurationScope.APPLICATION,
		},
		'active.narration.pythonPath': {
			type: 'string',
			default: '',
			description: localize('narrationPython', "Python interpreter with the `ptts` package (Phonon). Empty uses .tools/tts-venv or ~/.active/tts-venv."),
			scope: ConfigurationScope.MACHINE,
		},
		'active.agent.provider': {
			type: 'string',
			enum: ['muse', 'bridge'],
			enumDescriptions: [localize('providerMuse', "Muse Code (default)"), localize('providerBridge', "DEV ONLY: Claude Code subagent bridge")],
			default: 'muse',
			description: localize('agentProvider', "The coding agent Active works with."),
		},
		'active.muse.binaryPath': {
			type: 'string',
			default: '',
			description: localize('museBinary', "Path to the `muse` CLI. Empty searches PATH and ~/.local/bin."),
			scope: ConfigurationScope.MACHINE,
		},
		'active.walkthrough.backgroundTimeoutSeconds': {
			type: 'number',
			default: 20,
			minimum: 0,
			description: localize('backgroundTimeout', "How long to wait for background tasks (tests, builds) after a coding turn before explaining. Unfinished checks are marked pending and keep running."),
		},
		'active.features': {
			type: 'string',
			enum: ['both', 'explanations', 'diagrams'],
			enumItemLabels: [localize('featuresBothLabel', "Both"), localize('featuresExplanationsLabel', "Explanations"), localize('featuresDiagramsLabel', "System Diagrams")],
			enumDescriptions: [
				localize('featuresBoth', "Walkthroughs of each change, and a system map kept up to date."),
				localize('featuresExplanations', "Only walkthroughs of each change; no system map."),
				localize('featuresDiagrams', "Only the system map; changes aren't explained."),
			],
			default: 'both',
			markdownDescription: localize('features', "What Active does while the coding agent works. Asked on first launch."),
			scope: ConfigurationScope.APPLICATION,
		},
		[ActiveSetting.DiagramCheckMinutes]: {
			type: 'number',
			default: 2,
			minimum: 0,
			description: localize('diagramCheckMinutes', "How often (at most) the diagram agent checks whether the system map needs updating while the coding agent works. It also checks at the end of every turn that changed files."),
		},
		[ActiveSetting.DebugAgentTools]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('debugAgentTools', "Give the coding agent a debugger: it can run a test with temporary logpoints (seeing real values without adding print statements) or pause at breakpoints to read the stack and variables. Runs are hidden from your debug view and never start while you're debugging. JavaScript and TypeScript for now. Turning it on applies after reloading the window; turning it off applies at once."),
		},
		[ActiveSetting.DebugSuggestWhenStuck]: {
			type: 'boolean',
			default: true,
			description: localize('debugSuggestWhenStuck', "When the coding agent looks stuck (the same test failing again, several failed runs, or print statements added to see values), suggest the debugger to it, once per task."),
		},
		'active.explain.mode': {
			type: 'string',
			enum: ['auto', 'away', 'off'],
			enumItemLabels: [localize('modeAutoLabel', "Auto"), localize('modeAwayLabel', "Away"), localize('modeOffLabel', "Off")],
			enumDescriptions: [
				localize('modeAutoDescription', "Explanations pop up as each piece of work is ready."),
				localize('modeAwayDescription', "Walkthroughs are made but wait (short notes still go to chat); switching out of Away shows a short briefing of what happened, with the walkthroughs one click away."),
				localize('modeOffDescription', "No explanations (the explanation model isn't asked). Tasks are still saved to history."),
			],
			default: 'auto',
			markdownDescription: localize('explainMode', "How Active explains the coding agent's work. Also changeable from the indicator under the chat box."),
		},
		'active.explain.checkpointMinutes': {
			type: 'number',
			default: 5,
			minimum: 1,
			description: localize('checkpointMinutes', "Minimum minutes between asking the explanation model whether the coding agent's work so far is ready for a chapter. It's asked only when the agent reaches a checkpoint (a progress update, a finished test run or a completed step)."),
		},
		'active.explain.chapterMinutes': {
			type: 'number',
			default: 10,
			minimum: 1,
			description: localize('chapterMinutes', "Long tasks are explained in chapters. At most one chapter per this many minutes; a task shorter than this gets a single explanation at the end."),
		},
		'active.explain.queueChapters': {
			type: 'boolean',
			default: true,
			description: localize('queueChapters', "When a new chapter is ready while you're still watching the previous one, keep it queued until that one ends instead of switching right away."),
		},
		'active.explain.preferNotesForSmallChanges': {
			type: 'boolean',
			default: true,
			description: localize('preferNotes', "For small changes (and short requests), lean toward a brief note in chat instead of a full walkthrough."),
		},
		'active.explorer.changeCounts': {
			type: 'string',
			enum: ['agent', 'git'],
			enumDescriptions: [
				localize('countsAgent', "What the agent changed in the last prompt that changed files."),
				localize('countsGit', "Everything not yet committed, as git sees it (including new, untracked files)."),
			],
			default: 'agent',
			description: localize('explorerCounts', "Which changes are shown: the line counts (+added −removed) next to files in the Explorer, and the change bars in the editor's gutter. Switch with the buttons at the top of the Explorer."),
		},
		'active.startWithChat': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('startWithChat', "Open Active chat on startup. The first time a folder opens, chat fills the work area; after that your layout is kept."),
		},
	},
};
for (const schema of Object.values(general.properties ?? {})) {
	schema.tags = [...(schema.tags ?? []), 'active'];
}
registry.registerConfiguration(general);
