/**
 * TraceSink — domain-level observability interface.
 *
 * Sync/runtime code emits domain events through this interface.
 * The flight recorder becomes an adapter (FlightTraceSink) that maps
 * domain events to the existing flight event schema.
 *
 * Design rules:
 *   - record() and recordPath() are non-blocking. They never return promises.
 *   - flush() is the only async/durability boundary.
 *   - Callers never need to await trace completion.
 *   - Implementation may queue async work (HMAC, redaction) internally.
 */

export interface DomainTraceEvent {
	readonly kind: string;
	readonly scope: "vault" | "file" | "connection" | "diagnostics";
	readonly severity: "debug" | "info" | "warn" | "error";
	readonly opId?: string;
	readonly data?: Record<string, unknown>;
}

export interface DomainPathTraceEvent extends DomainTraceEvent {
	readonly scope: "file";
	readonly path: string;
}

export interface TraceSink {
	/** Record a non-path-scoped domain event. Non-blocking. */
	record(event: DomainTraceEvent): void;
	/** Record a path-scoped domain event. Non-blocking. */
	recordPath(event: DomainPathTraceEvent): void;
	/** Flush pending async work (HMAC, redaction). Only async boundary. */
	flush?(): Promise<void>;
}
