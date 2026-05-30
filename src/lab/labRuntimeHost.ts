/**
 * LabRuntimeHost — minimal interface that main.ts exposes to the lab runtime.
 *
 * Lab code accesses product state exclusively through this interface.
 * Product code never imports lab modules directly.
 */

import type { App } from "obsidian";
import type { VaultSync } from "../sync/vaultSync";
import type { ReconciliationController } from "../runtime/reconciliationController";
import type { ConnectionController } from "../runtime/connectionController";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { VaultSyncSettings } from "../settings";
import type { TraceSink } from "../observability/traceSink";
import type { TraceHttpContext } from "../observability/traceContext";

export interface LabRuntimeHost {
	readonly app: App;
	getSettings(): VaultSyncSettings;
	getVaultSync(): VaultSync | null;
	getReconciliationController(): ReconciliationController;
	getConnectionController(): ConnectionController | null;
	getEditorBindings(): EditorBindingManager | null;
	getTraceSink(): TraceSink;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getDiagnosticsDir(): Promise<string | undefined> | undefined;
	sha256Hex(text: string): Promise<string>;
	getPluginVersion(): string;
	isMarkdownPathSyncable(path: string): boolean;
	/** Called by lab when the QA debug API is mounted/unmounted. */
	onLabApiMounted(api: unknown): void;
	onLabApiUnmounted(): void;
	/** Register a cleanup to run on plugin unload. */
	registerCleanup(cleanup: () => void): void;
	log(msg: string): void;
}
