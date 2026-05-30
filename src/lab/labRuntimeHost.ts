import type { App } from "obsidian";
import type { VaultSync } from "../sync/vaultSync";
import type { ReconciliationController } from "../runtime/reconciliationController";
import type { ConnectionController } from "../runtime/connectionController";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { VaultSyncSettings } from "../settings";
import type { TraceSink } from "../observability/traceSink";
import type { TraceHttpContext } from "../observability/traceContext";
import type { EngineControlPort } from "../runtime/engineControlPort";

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
	/**
	 * Engine control port — available only when qaDebugMode is active.
	 * Absent in normal production. Not part of telemetry host.
	 * The Puppeteer harness calls this to drive Engine internals.
	 */
	getEngineControlPort(): EngineControlPort;
}
