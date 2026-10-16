import { statSync } from 'fs';
import Module from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

export class MockTabInputText {
    public readonly uri: { fsPath: string; scheme: string; path: string };
    constructor(uri: { fsPath: string; scheme: string; path: string }) {
        this.uri = uri;
    }
}

export const mockVscodeState = {
    workspaceFolders: undefined as
        { uri: { fsPath: string; scheme: string; path: string } }[] | undefined,
    textDocuments: [] as {
        uri: { fsPath: string; scheme: string; path: string };
        isClosed?: boolean;
        getText: () => string;
    }[],
    activeTextEditor: undefined as
        | {
              document: {
                  uri: { fsPath: string; scheme: string; path: string };
                  getText: () => string;
              };
          }
        | undefined,
    configValues: new Map<string, unknown>(),
    globalConfigValues: new Map<string, unknown>(),
    folderConfigValues: new Map<string, unknown>(),
};

export function resetMockVscodeState(): void {
    mockVscodeState.workspaceFolders = undefined;
    mockVscodeState.textDocuments = [];
    mockVscodeState.activeTextEditor = undefined;
    mockVscodeState.configValues.clear();
    mockVscodeState.globalConfigValues.clear();
    mockVscodeState.folderConfigValues.clear();
}

const vscodeMock = {
    Uri: {
        file(fsPath: string) {
            const normalized = path.normalize(fsPath);
            return {
                scheme: 'file',
                fsPath: normalized,
                path: '/' + normalized.replace(/\\/g, '/'),
                toString() {
                    return 'file:///' + normalized.replace(/\\/g, '/');
                },
            };
        },
        parse(value: string) {
            if (/^file:\/\//i.test(value)) {
                const fsPath = fileURLToPath(value);
                return {
                    scheme: 'file',
                    fsPath,
                    path: '/' + fsPath.replace(/\\/g, '/'),
                    toString() {
                        return value;
                    },
                };
            }
            return {
                scheme: 'unknown',
                fsPath: value,
                path: value,
                toString() {
                    return value;
                },
            };
        },
    },
    SymbolKind: {
        File: 0,
        Module: 1,
        Namespace: 2,
        Package: 3,
        Class: 4,
        Method: 5,
        Property: 6,
        Field: 7,
        Constructor: 8,
        Enum: 9,
        Interface: 10,
        Function: 11,
        Variable: 12,
        Constant: 13,
        String: 14,
        Number: 15,
        Boolean: 16,
        Array: 17,
        Object: 18,
        Key: 19,
        Null: 20,
        EnumMember: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25,
    },
    ConfigurationTarget: {
        Global: 1,
        Workspace: 2,
        WorkspaceFolder: 3,
    },
    TabInputText: MockTabInputText,
    workspace: {
        get workspaceFolders() {
            return mockVscodeState.workspaceFolders;
        },
        get textDocuments() {
            return mockVscodeState.textDocuments;
        },
        getConfiguration(section?: string, scope?: { fsPath: string }) {
            return {
                get<T>(key: string, defaultValue?: T): T | undefined {
                    const fullKey = section ? `${section}.${key}` : key;
                    if (scope && mockVscodeState.folderConfigValues.has(fullKey)) {
                        return mockVscodeState.folderConfigValues.get(fullKey) as T;
                    }
                    if (mockVscodeState.configValues.has(fullKey)) {
                        return mockVscodeState.configValues.get(fullKey) as T;
                    }
                    if (mockVscodeState.globalConfigValues.has(fullKey)) {
                        return mockVscodeState.globalConfigValues.get(fullKey) as T;
                    }
                    return defaultValue;
                },
                inspect(key: string) {
                    const fullKey = section ? `${section}.${key}` : key;
                    const val = mockVscodeState.configValues.get(fullKey);
                    const globalVal = mockVscodeState.globalConfigValues.get(fullKey);
                    const folderVal = scope
                        ? mockVscodeState.folderConfigValues.get(fullKey)
                        : undefined;
                    return {
                        workspaceFolderValue: folderVal,
                        workspaceValue: val,
                        globalValue: globalVal,
                    };
                },
                update(key: string, val: unknown): Promise<void> {
                    const fullKey = section ? `${section}.${key}` : key;
                    mockVscodeState.configValues.set(fullKey, val);
                    return Promise.resolve();
                },
            };
        },
        findFiles(): Promise<unknown[]> {
            return Promise.resolve([]);
        },
        fs: {
            stat(uri: { fsPath: string }): Promise<{ size: number }> {
                try {
                    const st = statSync(uri.fsPath);
                    return Promise.resolve({ size: st.size });
                } catch (err) {
                    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
                }
            },
        },
    },
    window: {
        get activeTextEditor() {
            return mockVscodeState.activeTextEditor;
        },
        tabGroups: {
            all: [] as { tabs: { input: unknown }[] }[],
        },
        showWarningMessage(): Promise<undefined> {
            return Promise.resolve(undefined);
        },
        showErrorMessage(): Promise<undefined> {
            return Promise.resolve(undefined);
        },
        showInformationMessage(): Promise<undefined> {
            return Promise.resolve(undefined);
        },
    },
    commands: {
        registerCommand() {
            return {
                dispose: () => {
                    /* no-op */
                },
            };
        },
        executeCommand(): Promise<undefined> {
            return Promise.resolve(undefined);
        },
    },
};

const vscodeLanguageClientMock = {
    DidChangeConfigurationNotification: { type: {} },
    LanguageClient: function () {
        /* mock constructor */
    },
    RevealOutputChannelOn: { Never: 4 },
};

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
}

const modLoader = Module as unknown as ModuleLoader;
const originalLoad = modLoader._load;
modLoader._load = function (request: string, parent: NodeModule | null, isMain: boolean): unknown {
    if (request === 'vscode') {
        return vscodeMock;
    }
    if (request === 'vscode-languageclient/node') {
        return vscodeLanguageClientMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};
