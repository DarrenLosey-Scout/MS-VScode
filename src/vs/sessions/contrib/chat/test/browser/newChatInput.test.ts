/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IIconLabelValueOptions } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable, IReference } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IResolvedTextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { FileThemeIcon, FolderThemeIcon } from '../../../../../platform/theme/common/themeService.js';
import { IFileLabelOptions } from '../../../../../workbench/browser/labels.js';
import { hasSendableNewChatContent, NewChatInputWidget } from '../../browser/newChatInput.js';
import { IChatRequestVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { NewChatContextAttachments } from '../../browser/newChatContextAttachments.js';
import { getAdditionalFolderContextId, getAdditionalRepositoryContextId } from '../../common/newChatContextIds.js';

interface IInputModelReferenceHarness {
	readonly _store: DisposableStore;
	readonly textModelService: {
		createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>>;
	};
	readonly logService: {
		error(message: string, error: Error): void;
	};
	_register<T extends IDisposable>(disposable: T): T;
}

const holdInputModelReference = Reflect.get(NewChatInputWidget.prototype, '_holdInputModelReference') as (this: IInputModelReferenceHarness, uri: URI, model: ITextModel) => void;
const getDraftState = Reflect.get(NewChatInputWidget.prototype, '_getDraftState') as (this: IDraftStateHarness) => { inputText: string; attachments: readonly IChatRequestVariableEntry[] } | undefined;
const restoreState = Reflect.get(NewChatInputWidget.prototype, '_restoreState') as (this: IRestoreStateHarness) => void;
const saveState = Reflect.get(NewChatInputWidget.prototype, 'saveState') as (this: IDraftStateHarness) => void;
const updateAttachmentRendering = Reflect.get(NewChatContextAttachments.prototype, '_updateRendering') as (this: IAttachmentRenderingHarness) => void;

interface IDraftStateHarness {
	readonly storageService: {
		get(key: string, scope: unknown): string | undefined;
		store(key: string, value: string, scope: unknown, target: unknown): void;
	};
	_draftState?: { inputText: string; attachments: readonly IChatRequestVariableEntry[] };
}

interface IRestoreStateHarness {
	_getDraftState(): { inputText: string; attachments: readonly IChatRequestVariableEntry[] } | undefined;
	readonly _editor: {
		getModel(): { setValue(value: string): void } | null;
	};
	readonly _contextAttachments: {
		setAttachments(entries: readonly IChatRequestVariableEntry[]): void;
	};
}

interface IAttachmentRenderingHarness {
	readonly _container: HTMLElement;
	readonly _attachedContext: readonly IChatRequestVariableEntry[];
	readonly _renderDisposables: DisposableStore;
	readonly _resourceLabels: {
		clear(): void;
		create(container: HTMLElement): IDisposable & {
			setLabel(label: string, description?: string, options?: IIconLabelValueOptions): void;
			setFile(resource: URI, options?: IFileLabelOptions): void;
		};
	};
	readonly themeService: {
		getFileIconTheme(): { hasFileIcons: boolean; hasFolderIcons: boolean };
		getColorTheme(): { type: ColorScheme };
	};
	readonly modelService: {
		getModel(): null;
	};
	readonly languageService: {
		guessLanguageIdByFilepathOrFirstLine(): string;
	};
	removeAttachment(id: string): void;
}

class InputModelReferenceHarness implements IInputModelReferenceHarness, IDisposable {
	readonly _store = new DisposableStore();

	constructor(
		readonly textModelService: IInputModelReferenceHarness['textModelService'],
		readonly logService: IInputModelReferenceHarness['logService'],
	) { }

	_register<T extends IDisposable>(disposable: T): T {
		return this._store.add(disposable);
	}

	dispose(): void {
		this._store.dispose();
	}
}

suite('NewChatInputWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the input model alive until reference acquisition settles during disposal', async () => {
		const referenceDeferred = new DeferredPromise<IReference<IResolvedTextEditorModel>>();
		let modelDisposed = false;
		let referenceDisposed = false;
		const errors: { message: string; error: Error }[] = [];
		const model = new class extends mock<ITextModel>() {
			override dispose(): void {
				modelDisposed = true;
			}
		}();
		const resolvedModel = new class extends mock<IResolvedTextEditorModel>() {
			override readonly textEditorModel = model;
		}();
		const harness = disposables.add(new InputModelReferenceHarness(
			{
				createModelReference: () => referenceDeferred.p,
			},
			{
				error: (message, error) => errors.push({ message, error }),
			},
		));

		holdInputModelReference.call(harness, URI.from({ scheme: Schemas.sessionsChatInput, path: 'input-test' }), model);
		harness.dispose();
		const disposedBeforeReferenceSettled = modelDisposed;

		referenceDeferred.complete({
			object: resolvedModel,
			dispose: () => {
				referenceDisposed = true;
				model.dispose();
			},
		});
		await referenceDeferred.p;
		await Promise.resolve();

		assert.deepStrictEqual({
			disposedBeforeReferenceSettled,
			modelDisposed,
			referenceDisposed,
			errors,
		}, {
			disposedBeforeReferenceSettled: false,
			modelDisposed: true,
			referenceDisposed: true,
			errors: [],
		});
	});

	test('treats an additional folder pill as sendable content without prompt text', () => {
		const folder = URI.file('/workspace/docs');
		const attachment: IChatRequestVariableEntry = {
			kind: 'directory',
			id: getAdditionalFolderContextId(folder),
			name: 'docs',
			value: folder,
		};

		assert.deepStrictEqual({
			empty: hasSendableNewChatContent('', []),
			additionalFolder: hasSendableNewChatContent('', [attachment]),
		}, {
			empty: false,
			additionalFolder: true,
		});
	});

	test('persists and restores additional folder and repository context with URI values', () => {
		let stored: string | undefined;
		const storageService: IDraftStateHarness['storageService'] = {
			get: () => stored,
			store: (_key, value) => stored = value,
		};
		const folder = URI.file('/workspace/docs');
		const repositoryRoot = URI.parse('vscode-vfs://github/microsoft/typescript/HEAD');
		const attachments: IChatRequestVariableEntry[] = [
			{
				kind: 'directory',
				id: getAdditionalFolderContextId(folder),
				name: 'docs',
				value: folder,
			},
			{
				kind: 'generic',
				id: getAdditionalRepositoryContextId(URI.parse('https://github.com/microsoft/typescript')),
				name: 'microsoft/typescript',
				value: repositoryRoot,
			},
		];
		const saveHarness: IDraftStateHarness = {
			storageService,
			_draftState: { inputText: 'Fix this', attachments },
		};
		saveState.call(saveHarness);
		const restored: { inputText?: string; attachments?: readonly IChatRequestVariableEntry[] } = {};
		const draft = getDraftState.call({ storageService });

		restoreState.call({
			_getDraftState: () => draft,
			_editor: { getModel: () => ({ setValue: value => restored.inputText = value }) },
			_contextAttachments: { setAttachments: entries => restored.attachments = entries },
		});

		assert.deepStrictEqual({
			inputText: restored.inputText,
			attachmentIds: restored.attachments?.map(attachment => attachment.id),
			folderValue: restored.attachments?.[0].value,
			repositoryValue: restored.attachments?.[1].value,
		}, {
			inputText: 'Fix this',
			attachmentIds: attachments.map(attachment => attachment.id),
			folderValue: folder,
			repositoryValue: repositoryRoot,
		});
	});

	test('renders leading remove buttons and attachment icons consistently', () => {
		const container = document.createElement('div');
		const entries: IChatRequestVariableEntry[] = [
			{
				kind: 'file',
				id: 'file',
				name: 'README.md',
				value: URI.file('/workspace/README.md'),
			},
			{
				kind: 'directory',
				id: 'directory',
				name: 'spritesheet',
				value: URI.file('/workspace/spritesheet'),
			},
			{
				kind: 'generic',
				id: 'known',
				name: 'Known context',
				value: 'known',
				icon: Codicon.repo,
			},
			{
				kind: 'generic',
				id: 'unknown',
				name: 'Unknown context',
				value: 'unknown',
			},
			{
				kind: 'string',
				id: 'themed-file',
				name: 'Themed file',
				value: 'themed-file',
				uri: URI.parse('vscode://context/themed-file'),
				resourceUri: URI.file('/workspace/src/index.ts'),
				iconPath: FileThemeIcon,
				handle: 1,
			},
		];
		let removed: string | undefined;
		const labels: { label: string; icon?: string; extraClasses?: readonly string[] }[] = [];
		const files: { resource: string; fileKind?: FileKind; icon?: string }[] = [];
		const renderDisposables = disposables.add(new DisposableStore());
		updateAttachmentRendering.call({
			_container: container,
			_attachedContext: entries,
			_renderDisposables: renderDisposables,
			_resourceLabels: {
				clear: () => { },
				create: pill => {
					const labelElement = document.createElement('span');
					labelElement.className = 'resource-label';
					pill.appendChild(labelElement);
					return {
						dispose: () => { },
						setLabel: (label, _description, options) => labels.push({
							label,
							icon: ThemeIcon.isThemeIcon(options?.iconPath) ? options.iconPath.id : options?.iconPath?.toString(),
							extraClasses: options?.extraClasses,
						}),
						setFile: (resource, options) => files.push({
							resource: resource.path,
							fileKind: options?.fileKind,
							icon: ThemeIcon.isThemeIcon(options?.icon) ? options.icon.id : options?.icon?.toString(),
						}),
					};
				},
			},
			themeService: {
				getFileIconTheme: () => ({ hasFileIcons: true, hasFolderIcons: false }),
				getColorTheme: () => ({ type: ColorScheme.DARK }),
			},
			modelService: {
				getModel: () => null,
			},
			languageService: {
				guessLanguageIdByFilepathOrFirstLine: () => 'typescript',
			},
			removeAttachment: id => removed = id,
		});
		const removeButton = container.querySelector<HTMLButtonElement>('.sessions-chat-attachment-remove');
		const pill = container.querySelector<HTMLElement>('.sessions-chat-attachment-pill');
		const openTarget = pill?.querySelector<HTMLElement>('.sessions-chat-attachment-content');
		let bubbledKeyDown = false;
		pill?.addEventListener('keydown', () => bubbledKeyDown = true);
		removeButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		removeButton?.click();

		assert.deepStrictEqual({
			tagName: removeButton?.tagName,
			tabIndex: removeButton?.tabIndex,
			ariaLabel: removeButton?.getAttribute('aria-label'),
			pillChildren: Array.from(pill?.children ?? []).map(child => child.className),
			openTarget: {
				role: openTarget?.role,
				tabIndex: openTarget?.tabIndex,
				containsRemoveButton: openTarget?.contains(removeButton),
			},
			bubbledKeyDown,
			removed,
			files,
			labels,
		}, {
			tagName: 'BUTTON',
			tabIndex: 0,
			ariaLabel: 'Remove README.md',
			pillChildren: ['sessions-chat-attachment-remove', 'sessions-chat-attachment-content'],
			openTarget: {
				role: 'button',
				tabIndex: 0,
				containsRemoveButton: false,
			},
			bubbledKeyDown: false,
			removed: entries[0].id,
			files: [
				{ resource: '/workspace/README.md', fileKind: FileKind.FILE, icon: undefined },
				{ resource: '/workspace/spritesheet', fileKind: FileKind.FOLDER, icon: FolderThemeIcon.id },
			],
			labels: [
				{ label: 'Known context', icon: Codicon.repo.id, extraClasses: undefined },
				{ label: 'Unknown context', icon: Codicon.attach.id, extraClasses: undefined },
				{
					label: 'Themed file',
					icon: undefined,
					extraClasses: ['file-icon', 'src-name-dir-icon', 'index.ts-name-file-icon', 'name-file-icon', 'ts-ext-file-icon', 'ext-file-icon', 'typescript-lang-file-icon'],
				},
			],
		});
	});

	test('renders additional folder and repository context as attachment pills', () => {
		const container = document.createElement('div');
		const folder = URI.file('/workspace/docs');
		const repositoryRoot = URI.parse('vscode-vfs://github/microsoft/typescript/HEAD');
		const entries: readonly IChatRequestVariableEntry[] = [
			{
				kind: 'directory',
				id: getAdditionalFolderContextId(folder),
				name: 'docs',
				value: folder,
			},
			{
				kind: 'generic',
				id: getAdditionalRepositoryContextId(URI.parse('https://github.com/microsoft/typescript')),
				name: 'microsoft/typescript',
				value: repositoryRoot,
			},
		];
		const renderDisposables = disposables.add(new DisposableStore());
		updateAttachmentRendering.call({
			_container: container,
			_attachedContext: entries,
			_renderDisposables: renderDisposables,
			_resourceLabels: {
				clear: () => { },
				create: pill => ({
					dispose: () => { },
					setLabel: label => pill.textContent = label,
					setFile: (_resource, _options) => pill.textContent = 'docs',
				}),
			},
			themeService: {
				getFileIconTheme: () => ({ hasFileIcons: true, hasFolderIcons: false }),
				getColorTheme: () => ({ type: ColorScheme.DARK }),
			},
			modelService: {
				getModel: () => null,
			},
			languageService: {
				guessLanguageIdByFilepathOrFirstLine: () => 'typescript',
			},
			removeAttachment: () => { },
		});

		assert.deepStrictEqual(
			Array.from(container.querySelectorAll<HTMLElement>('.sessions-chat-attachment-pill')).map(pill => ({
				text: pill.textContent,
				removeAriaLabel: pill.querySelector('.sessions-chat-attachment-remove')?.getAttribute('aria-label'),
			})),
			[
				{ text: 'docs', removeAriaLabel: 'Remove docs' },
				{ text: 'microsoft/typescript', removeAriaLabel: 'Remove microsoft/typescript' },
			],
		);
	});
});
