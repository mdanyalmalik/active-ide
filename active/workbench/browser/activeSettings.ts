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
const KNOWN_MODELS: AgentModelInfo[] = [
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
			markdownDescription: localize('narrationVoice', "Phonon voice for walkthrough narration. Empty uses Phonon's default. Pick and preview voices with **Active: Choose Narration Voice** or the status bar."),
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
		'active.explain.minMeaningfulLines': {
			type: 'number',
			default: 8,
			minimum: 1,
			description: localize('minLines', "Meaningful changed lines (not whitespace, comments or moves) that make a turn worth a walkthrough."),
		},
		'active.explain.draftQuietSeconds': {
			type: 'number',
			default: 6,
			minimum: 1,
			description: localize('draftQuiet', "Quiet period after the last change before drafting a walkthrough while the agent is still working."),
		},
		'active.startWithChat': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('startWithChat', "Open Active chat across the work area on startup."),
		},
	},
};
for (const schema of Object.values(general.properties ?? {})) {
	schema.tags = [...(schema.tags ?? []), 'active'];
}
registry.registerConfiguration(general);
