/**
 * Tests for TraceSink infrastructure.
 *
 * Proves:
 * - FlightTraceSink maps domain events to flight events correctly
 * - NoopTraceSink drops events
 * - Domain event kinds map to correct FLIGHT_KIND constants
 * - Unknown domain events are silently dropped
 * - recordPath is non-blocking (no Promise returned to caller)
 */

import { FlightTraceSink } from "../src/debug/flightTraceSink";
import { NoopTraceSink } from "../src/observability/noopTraceSink";
import { FLIGHT_KIND } from "../src/debug/flightEvents";
import type { DomainPathTraceEvent } from "../src/observability/traceSink";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

console.log("\n--- Test 1: FlightTraceSink maps rename.observed to diskRenameObserved ---");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-123",
		path: "notes/file.md",
		data: { renameRole: "source", category: "markdown", opId: "op-123" },
	});

	assert(recorded.length === 1, "one event recorded");
	const event = recorded[0] as Record<string, unknown>;
	assert(event.kind === FLIGHT_KIND.diskRenameObserved, "mapped to diskRenameObserved");
	assert(event.path === "notes/file.md", "path preserved");
	assert(event.priority === "important", "info severity -> important priority");
	assert(event.source === "vaultEvents", "source is vaultEvents");
	assert(event.layer === "disk", "layer is disk");
}

console.log("\n--- Test 2: FlightTraceSink maps rename.admission.invariant-failed ---");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "rename.admission.invariant-failed",
		scope: "file",
		severity: "error",
		path: ".trash/leaked.md",
		data: { bug: "excluded-destination-reached-applyRenameBatch" },
	});

	assert(recorded.length === 1, "one event recorded");
	const event = recorded[0] as Record<string, unknown>;
	assert(event.kind === FLIGHT_KIND.renameAdmissionInvariantFailed, "mapped to renameAdmissionInvariantFailed");
	assert(event.priority === "critical", "error severity -> critical priority");
	assert(event.layer === "policy", "layer is policy for admission events");
}

console.log("\n--- Test 3: unknown domain event is silently dropped ---");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "some.future.event",
		scope: "file",
		severity: "debug",
		path: "notes/x.md",
	});

	assert(recorded.length === 0, "unknown event dropped silently");
	assert(sink.getDroppedEventCount() === 1, "dropped event count incremented");
}

console.log("\n--- Test 3b: getDroppedEventCount tracks multiple drops ---");
{
	const sink = new FlightTraceSink(() => {});

	sink.recordPath({ kind: "unknown.a", scope: "file", severity: "debug", path: "a.md" });
	sink.recordPath({ kind: "unknown.b", scope: "file", severity: "debug", path: "b.md" });
	sink.recordPath({ kind: "rename.observed", scope: "file", severity: "info", path: "c.md", data: { renameRole: "source", category: "markdown", opId: "op-1" } });
	sink.recordPath({ kind: "unknown.c", scope: "file", severity: "debug", path: "d.md" });

	assert(sink.getDroppedEventCount() === 3, "dropped count is 3 (excludes mapped event)");
}

console.log("\n--- Test 4: NoopTraceSink drops everything ---");
{
	const sink = new NoopTraceSink();
	// Should not throw.
	sink.record({ kind: "test", scope: "vault", severity: "info" });
	sink.recordPath({ kind: "test", scope: "file", severity: "info", path: "x.md" });
	assert(true, "NoopTraceSink does not throw");
}

console.log("\n--- Test 5: recordPath is non-blocking (returns void, not Promise) ---");
{
	const sink = new FlightTraceSink(() => {});
	const result = sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		path: "x.md",
		data: { renameRole: "source", category: "markdown", opId: "op-1" },
	});
	assert(result === undefined, "recordPath returns undefined (not a Promise)");
}

console.log("\n--- Test 6: flush returns a Promise ---");
{
	const sink = new FlightTraceSink(() => {});
	const result = sink.flush();
	assert(result instanceof Promise, "flush returns a Promise");
}

console.log("\n--- Test 7: severity mapping ---");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	const severities = ["debug", "info", "warn", "error"] as const;
	for (const sev of severities) {
		sink.recordPath({
			kind: "rename.observed",
			scope: "file",
			severity: sev,
			path: "x.md",
			data: { renameRole: "source", category: "markdown", opId: "op-1" },
		});
	}

	assert(recorded[0]!.priority === "verbose", "debug -> verbose");
	assert(recorded[1]!.priority === "important", "info -> important");
	assert(recorded[2]!.priority === "important", "warn -> important");
	assert(recorded[3]!.priority === "critical", "error -> critical");
}

console.log("\n--- Test 8: rename event pair (source + target) ---");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	// Simulate what main.ts does:
	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-99",
		path: "notes/old.md",
		data: { renameRole: "source", category: "markdown", opId: "op-99" },
	});
	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-99",
		path: "notes/new.md",
		data: { renameRole: "target", category: "markdown", opId: "op-99" },
	});

	assert(recorded.length === 2, "two events for rename pair");
	assert(recorded[0]!.path === "notes/old.md", "first event is source");
	assert(recorded[1]!.path === "notes/new.md", "second event is target");
	assert(recorded[0]!.opId === "op-99", "opId preserved on source");
	assert(recorded[1]!.opId === "op-99", "opId preserved on target");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
