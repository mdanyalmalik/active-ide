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
import type { ExplanationDepth, Familiarity, KnowledgeProfile, MathComfort, VisualKind } from '../common/activeProtocol.js';
import { KnowledgeProfileInput } from './activeInputs.js';
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

/** The editable knowledge profile that shapes what walkthroughs cover, how deep they go, and how they sound. */
export class KnowledgeProfileEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeKnowledgeProfile';

	private root!: HTMLElement;
	private form!: HTMLElement;
	private draft!: Mutable<KnowledgeProfile>;
	private readonly formStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(KnowledgeProfileEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		// The page scrolls natively: the form grows as rows are added, and the root is the scroll container.
		this.root = dom.append(parent, $('.active-profile'));
		this.form = dom.append(this.root, $('.active-profile-form'));
	}

	override async setInput(input: KnowledgeProfileInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
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
				// Choosing a familiarity by hand replaces any level adjusted from feedback.
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
		dom.append(head, $('.eyebrow')).textContent = localize('profileEyebrow', "Active");
		dom.append(head, $('h1')).textContent = localize('profileTitle', "Knowledge Profile");
		dom.append(head, $('p.lead')).textContent = localize('profileLead', "Shapes what walkthroughs cover, how deep they go, and how they sound. Saved locally.");

		const background = this.section(localize('background', "Background"), localize('backgroundHelp', "Your role and what you usually build."));
		this.textarea(background, draft.background, localize('backgroundPlaceholder', "e.g. Backend engineer, mostly Go and Postgres"), value => { draft.background = value; });
		const years = dom.append(background, $('label.inline'));
		dom.append(years, $('span')).textContent = localize('years', "Years of experience");
		const yearsInput = dom.append(years, $('input')) as HTMLInputElement;
		yearsInput.type = 'number';
		yearsInput.min = '0';
		yearsInput.value = String(draft.yearsProgramming);
		this.formStore.add(dom.addDisposableListener(yearsInput, dom.EventType.INPUT, () => { draft.yearsProgramming = Math.max(0, Number(yearsInput.value) || 0); }));

		const languages = draft.languages as Array<{ name: string; familiarity: Familiarity }>;
		this.familiarityList(this.section(localize('languages', "Languages"), localize('languagesHelp', "What you work with, and how well you know it.")), languages, localize('languagePlaceholder', "TypeScript"));
		const concepts = draft.concepts as Array<{ name: string; familiarity: Familiarity }>;
		this.familiarityList(this.section(localize('concepts', "Concepts"), localize('conceptsHelp', "Ideas in your codebase, such as caching, concurrency or networking.")), concepts, localize('conceptPlaceholder', "Promises and async/await"));

		const focus = this.section(localize('focus', "Focus"), '');
		dom.append(focus, $('label.field')).textContent = localize('followClosely', "Follow closely");
		this.textarea(focus, draft.followClosely, localize('followPlaceholder', "e.g. auth, caching, database migrations"), value => { draft.followClosely = value; });
		dom.append(focus, $('label.field')).textContent = localize('glossOver', "Skim past");
		this.textarea(focus, draft.glossOver, localize('glossPlaceholder', "e.g. test boilerplate, CSS"), value => { draft.glossOver = value; });

		const depth = this.section(localize('depth', "Explanation depth"), '');
		this.choices<ExplanationDepth>(depth, 'depth', [
			['overview', localize('depthOverview', "Overview: the key change and where it lives")],
			['balanced', localize('depthBalanced', "Balanced: what changed, how, and why")],
			['deep', localize('depthDeep', "Deep: mechanisms, edge cases, tradeoffs")],
		], draft.depth, value => { draft.depth = value; draft.detailBias = 0; });
		if (Math.abs(draft.detailBias ?? 0) >= 0.1) {
			dom.append(depth, $('p.help.adjusted')).textContent = draft.detailBias > 0
				? localize('adjustedMore', "Adjusted from your feedback: slightly more detail.")
				: localize('adjustedLess', "Adjusted from your feedback: slightly less detail.");
		}

		const math = this.section(localize('math', "Mathematical notation"), '');
		this.choices<MathComfort>(math, 'math', [
			['avoid', localize('mathAvoid', "Avoid equations; describe in words")],
			['light', localize('mathLight', "Light: simple formulas when they help")],
			['comfortable', localize('mathComfortable', "Comfortable — use notation freely")],
		], draft.math, value => { draft.math = value; });

		const visuals = this.section(localize('visuals', "Useful visuals"), localize('visualsHelp', "Walkthroughs prefer these."));
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

		const notes = this.section(localize('notes', "Anything else"), '');
		this.textarea(notes, draft.notes, localize('notesPlaceholder', "e.g. Concrete examples before abstractions"), value => { draft.notes = value; });

		const actions = dom.append(this.form, $('.profile-actions'));
		const save = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		save.textContent = localize('save', "Save Profile");
		this.formStore.add(dom.addDisposableListener(save, dom.EventType.CLICK, async () => {
			const cleaned: KnowledgeProfile = {
				...draft,
				configured: true,
				languages: draft.languages.filter(item => item.name.trim()),
				concepts: draft.concepts.filter(item => item.name.trim()),
			};
			await this.activeService.saveProfile(cleaned);
			this.notificationService.info(localize('saved', "Knowledge profile saved."));
		}));
	}
}
