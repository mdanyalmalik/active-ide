/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { ExplanationDepth, Familiarity, LearningProfile, MathComfort, VisualKind } from '../common/activeProtocol.js';
import { LearningProfileInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';

const $ = dom.$;

const FAMILIARITY: ReadonlyArray<[Familiarity, string]> = [
	['new', localize('famNew', "New to it")],
	['some', localize('famSome', "Some exposure")],
	['comfortable', localize('famComfortable', "Comfortable")],
	['expert', localize('famExpert', "Expert")],
];

const VISUALS: ReadonlyArray<[VisualKind, string]> = [
	['code', localize('visCode', "Related code excerpts")],
	['diff', localize('visDiff', "Before/after diffs")],
	['diagram', localize('visDiagram', "Diagrams of flows and relationships")],
	['equation', localize('visEquation', "Equations for quantitative rules")],
	['chart', localize('visChart', "Charts of numeric behavior")],
];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The editable learning setup that personalizes concept selection, depth, vocabulary, pacing and visuals. */
export class LearningProfileEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeLearningProfile';

	private root!: HTMLElement;
	private form!: HTMLElement;
	private voiceSelect: HTMLSelectElement | undefined;
	private draft!: Mutable<LearningProfile>;
	private readonly formStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(LearningProfileEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		// The page scrolls natively: the form grows as rows are added, and the root is the scroll container.
		this.root = dom.append(parent, $('.active-profile'));
		this.form = dom.append(this.root, $('.active-profile-form'));
		this._register(this.activeService.onDidChangeNarration(() => this.renderVoices()));
	}

	override async setInput(input: LearningProfileInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const profile = this.activeService.profile;
		this.draft = { ...profile, languages: [...profile.languages], concepts: [...profile.concepts], preferredVisuals: [...profile.preferredVisuals] };
		this.renderForm();
	}

	override layout(dimension: dom.Dimension): void {
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
	}

	private section(title: string, help: string): HTMLElement {
		const section = dom.append(this.form, $('section'));
		dom.append(section, $('h2')).textContent = title;
		if (help) {
			dom.append(section, $('p.help')).textContent = help;
		}
		return section;
	}

	private textarea(parent: HTMLElement, value: string, placeholder: string, onChange: (value: string) => void): void {
		const element = dom.append(parent, $('textarea')) as HTMLTextAreaElement;
		element.value = value;
		element.placeholder = placeholder;
		element.rows = 3;
		this.formStore.add(dom.addDisposableListener(element, dom.EventType.INPUT, () => onChange(element.value)));
	}

	private choices<T extends string>(parent: HTMLElement, name: string, options: ReadonlyArray<[T, string]>, value: T, onChange: (value: T) => void): void {
		const group = dom.append(parent, $('.choices'));
		for (const [id, label] of options) {
			const item = dom.append(group, $('label.choice'));
			const radio = dom.append(item, $('input')) as HTMLInputElement;
			radio.type = 'radio';
			radio.name = name;
			radio.checked = id === value;
			dom.append(item, $('span')).textContent = label;
			this.formStore.add(dom.addDisposableListener(radio, dom.EventType.CHANGE, () => radio.checked && onChange(id)));
		}
	}

	private familiarityList(parent: HTMLElement, items: Array<{ name: string; familiarity: Familiarity }>, placeholder: string): void {
		const list = dom.append(parent, $('.familiarity-list'));
		const render = () => {
			dom.clearNode(list);
			items.forEach((item, index) => {
				const row = dom.append(list, $('.familiarity-row'));
				const name = dom.append(row, $('input')) as HTMLInputElement;
				name.value = item.name;
				name.placeholder = placeholder;
				this.formStore.add(dom.addDisposableListener(name, dom.EventType.INPUT, () => { items[index] = { ...items[index], name: name.value }; }));
				const select = dom.append(row, $('select')) as HTMLSelectElement;
				for (const [id, label] of FAMILIARITY) {
					const option = dom.append(select, $('option')) as HTMLOptionElement;
					option.value = id;
					option.textContent = label;
					option.selected = id === item.familiarity;
				}
				// Choosing a familiarity by hand replaces any level learned from feedback.
				this.formStore.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => { items[index] = { name: items[index].name, familiarity: select.value as Familiarity }; }));
				const remove = dom.append(row, $('button.secondary')) as HTMLButtonElement;
				remove.textContent = localize('remove', "Remove");
				this.formStore.add(dom.addDisposableListener(remove, dom.EventType.CLICK, () => { items.splice(index, 1); render(); }));
			});
			const add = dom.append(list, $('button.secondary')) as HTMLButtonElement;
			add.textContent = localize('add', "Add");
			this.formStore.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => { items.push({ name: '', familiarity: 'some' }); render(); }));
		};
		render();
	}

	private renderForm(): void {
		this.formStore.clear();
		dom.clearNode(this.form);
		const draft = this.draft;
		const head = dom.append(this.form, $('header'));
		dom.append(head, $('.eyebrow')).textContent = localize('profileEyebrow', "Active · learning setup");
		dom.append(head, $('h1')).textContent = localize('profileTitle', "Learning Profile");
		dom.append(head, $('p.lead')).textContent = localize('profileLead', "Walkthroughs use this to choose which concepts to teach, how deep to go, which words to use, how fast to narrate and which visuals to show. It is saved locally.");

		const background = this.section(localize('background', "Programming background"), localize('backgroundHelp', "Your role, what you usually build, and anything that frames how you think about code."));
		this.textarea(background, draft.background, localize('backgroundPlaceholder', "e.g. Frontend engineer, mostly React; some Python for data work"), value => { draft.background = value; });
		const years = dom.append(background, $('label.inline'));
		dom.append(years, $('span')).textContent = localize('years', "Years programming");
		const yearsInput = dom.append(years, $('input')) as HTMLInputElement;
		yearsInput.type = 'number';
		yearsInput.min = '0';
		yearsInput.value = String(draft.yearsProgramming);
		this.formStore.add(dom.addDisposableListener(yearsInput, dom.EventType.INPUT, () => { draft.yearsProgramming = Math.max(0, Number(yearsInput.value) || 0); }));

		const languages = draft.languages as Array<{ name: string; familiarity: Familiarity }>;
		this.familiarityList(this.section(localize('languages', "Languages"), localize('languagesHelp', "Languages and frameworks you work with, and how well you know them.")), languages, localize('languagePlaceholder', "TypeScript"));
		const concepts = draft.concepts as Array<{ name: string; familiarity: Familiarity }>;
		this.familiarityList(this.section(localize('concepts', "Concepts"), localize('conceptsHelp', "Ideas that come up in your codebase: concurrency, caching, recursion, type systems, networking…")), concepts, localize('conceptPlaceholder', "Promises and async/await"));

		const learn = this.section(localize('learn', "What to teach vs. gloss over"), '');
		dom.append(learn, $('label.field')).textContent = localize('wantToLearn', "I want to learn");
		this.textarea(learn, draft.wantToLearn, localize('learnPlaceholder', "e.g. why concurrency bugs happen, how caches stay consistent"), value => { draft.wantToLearn = value; });
		dom.append(learn, $('label.field')).textContent = localize('glossOver', "Gloss over");
		this.textarea(learn, draft.glossOver, localize('glossPlaceholder', "e.g. TypeScript syntax, test boilerplate, CSS"), value => { draft.glossOver = value; });

		const depth = this.section(localize('depth', "Explanation depth"), '');
		this.choices<ExplanationDepth>(depth, 'depth', [
			['overview', localize('depthOverview', "Overview — the key idea and where it lives")],
			['balanced', localize('depthBalanced', "Balanced — intuition, implementation and behavior")],
			['deep', localize('depthDeep', "Deep — mechanisms, edge cases and tradeoffs")],
		], draft.depth, value => { draft.depth = value; draft.detailBias = 0; });
		if (Math.abs(draft.detailBias ?? 0) >= 0.1) {
			dom.append(depth, $('p.help.learned')).textContent = draft.detailBias > 0
				? localize('learnedMore', "From your feedback, walkthroughs lean toward a little more detail within this depth.")
				: localize('learnedLess', "From your feedback, walkthroughs lean toward a little less detail within this depth.");
		}

		const math = this.section(localize('math', "Mathematical notation"), '');
		this.choices<MathComfort>(math, 'math', [
			['avoid', localize('mathAvoid', "Avoid equations; describe in words")],
			['light', localize('mathLight', "Light — simple formulas when they help")],
			['comfortable', localize('mathComfortable', "Comfortable — use notation freely")],
		], draft.math, value => { draft.math = value; });

		const visuals = this.section(localize('visuals', "Useful visuals"), localize('visualsHelp', "The explainer prefers these when choosing what to show."));
		const visualGroup = dom.append(visuals, $('.choices'));
		for (const [id, label] of VISUALS) {
			const item = dom.append(visualGroup, $('label.choice'));
			const checkbox = dom.append(item, $('input')) as HTMLInputElement;
			checkbox.type = 'checkbox';
			checkbox.checked = draft.preferredVisuals.includes(id);
			dom.append(item, $('span')).textContent = label;
			this.formStore.add(dom.addDisposableListener(checkbox, dom.EventType.CHANGE, () => {
				const set = new Set(draft.preferredVisuals);
				if (checkbox.checked) {
					set.add(id);
				} else {
					set.delete(id);
				}
				draft.preferredVisuals = VISUALS.map(([kind]) => kind).filter(kind => set.has(kind));
			}));
		}

		const narration = this.section(localize('narration', "Narration"), localize('narrationHelp', "Spoken on-device by Phonon 31M English. Audio is generated on demand and never saved."));
		const speed = dom.append(narration, $('label.inline'));
		dom.append(speed, $('span')).textContent = localize('speed', "Speed");
		const range = dom.append(speed, $('input')) as HTMLInputElement;
		range.type = 'range';
		range.min = '0.75';
		range.max = '1.75';
		range.step = '0.05';
		range.value = String(draft.narrationRate);
		const speedValue = dom.append(speed, $('span.value'));
		speedValue.textContent = `${draft.narrationRate.toFixed(2)}×`;
		this.formStore.add(dom.addDisposableListener(range, dom.EventType.INPUT, () => {
			draft.narrationRate = Number(range.value);
			speedValue.textContent = `${draft.narrationRate.toFixed(2)}×`;
		}));
		const voice = dom.append(narration, $('label.inline'));
		dom.append(voice, $('span')).textContent = localize('voice', "Voice");
		const voiceSelect = this.voiceSelect = dom.append(voice, $('select.voice-select')) as HTMLSelectElement;
		this.formStore.add(dom.addDisposableListener(voiceSelect, dom.EventType.CHANGE, () => { draft.voice = voiceSelect.value; }));
		this.renderVoices();
		const preview = dom.append(voice, $('button.secondary')) as HTMLButtonElement;
		preview.textContent = localize('preview', "Preview");
		this.formStore.add(dom.addDisposableListener(preview, dom.EventType.CLICK, () => this.preview()));

		const notes = this.section(localize('notes', "Anything else"), '');
		this.textarea(notes, draft.notes, localize('notesPlaceholder', "e.g. I learn best from concrete examples before abstractions"), value => { draft.notes = value; });

		const actions = dom.append(this.form, $('.profile-actions'));
		const save = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		save.textContent = localize('save', "Save Profile");
		this.formStore.add(dom.addDisposableListener(save, dom.EventType.CLICK, async () => {
			const cleaned: LearningProfile = {
				...draft,
				configured: true,
				languages: draft.languages.filter(item => item.name.trim()),
				concepts: draft.concepts.filter(item => item.name.trim()),
			};
			await this.activeService.saveProfile(cleaned);
			this.notificationService.info(localize('saved', "Learning profile saved. New walkthroughs will use it."));
		}));
	}

	/** Fills the voice list from what the narrator offers (it arrives once Phonon has loaded). */
	private renderVoices(): void {
		const select = this.voiceSelect;
		if (!select || !this.draft) {
			return;
		}
		dom.clearNode(select);
		const voices = this.activeService.narration.voices?.length ? this.activeService.narration.voices : [{ name: 'default' }];
		const groups: Array<[string, typeof voices]> = [
			[localize('narratorsGroup', "Narrators"), voices.filter(voice => !voice.character)],
			[localize('charactersGroup', "Character voices"), voices.filter(voice => voice.character)],
		];
		for (const [label, members] of groups) {
			if (!members.length) {
				continue;
			}
			const group = dom.append(select, $('optgroup')) as HTMLOptGroupElement;
			group.label = label;
			for (const voice of members) {
				const option = dom.append(group, $('option')) as HTMLOptionElement;
				option.value = voice.name;
				option.textContent = voice.name === 'default' ? localize('defaultVoiceOption', "Default") : voice.name;
				option.title = voice.description ?? '';
			}
		}
		const current = this.draft.voice || 'default';
		if (!voices.some(voice => voice.name === current)) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = current;
			option.textContent = current;
		}
		select.value = current;
	}

	private async preview(): Promise<void> {
		if (!this.activeService.narration.available) {
			this.notificationService.warn(localize('previewFailed', "Narration is unavailable: {0}", this.activeService.narration.detail));
			return;
		}
		await this.activeService.speak(localize('previewText', "This is how walkthrough narration will sound in this voice."), this.draft.voice);
	}
}
