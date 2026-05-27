import { strict as assert } from "node:assert";
import { decideClosedFileConflict } from "../src/sync/closedFileConflict";

console.log("\n--- Test 1: closed-file conflict decision table ---");

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "A" }),
	{ kind: "no-op" },
	"disk=crdt is no-op",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "B" }),
	{ kind: "apply-remote-to-disk", reason: "disk-at-baseline" },
	"baseline=A disk=A crdt=B applies remote",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "A" }),
	{ kind: "import-disk-to-crdt", reason: "crdt-at-baseline" },
	"baseline=A disk=B crdt=A imports disk",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	},
	"baseline=A disk=B crdt=C preserves conflict",
);

// missing-baseline with no mtime evidence → CRDT wins (safe distributed default)
assert.deepEqual(
	decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing-baseline, no mtime evidence → CRDT wins (safe default)",
);

// missing-baseline with only diskMtime (no lastSaveDiskIndexAt) → CRDT wins (not enough evidence)
assert.deepEqual(
	decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 2000 }),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing-baseline, only diskMtime, no lastSaveDiskIndexAt → CRDT wins",
);

// missing-baseline with only lastSaveDiskIndexAt (no diskMtime) → CRDT wins (not enough evidence)
assert.deepEqual(
	decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", lastSaveDiskIndexAt: 1000 }),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing-baseline, only lastSaveDiskIndexAt, no diskMtime → CRDT wins",
);

// missing-baseline: disk mtime AFTER last save → disk edited while YAOS was inactive → disk wins
assert.deepEqual(
	decideClosedFileConflict({
		baselineHash: null,
		diskHash: "B",
		crdtHash: "C",
		diskMtime: 2000,         // disk file modified at T=2000
		lastSaveDiskIndexAt: 1000, // YAOS last saved clean state at T=1000
	}),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "disk",
		preserveCrdt: true,
	},
	"missing-baseline, diskMtime > lastSaveDiskIndexAt → disk edited while YAOS inactive → disk wins",
);

// missing-baseline: disk mtime BEFORE last save → disk is stale → CRDT wins
assert.deepEqual(
	decideClosedFileConflict({
		baselineHash: null,
		diskHash: "B",
		crdtHash: "C",
		diskMtime: 1000,         // disk file not touched since T=1000
		lastSaveDiskIndexAt: 2000, // YAOS last saved clean state at T=2000 (after disk)
	}),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing-baseline, diskMtime < lastSaveDiskIndexAt → disk is stale → CRDT wins",
);

// missing-baseline: disk mtime EQUAL to last save → treat as stale (not newer) → CRDT wins
assert.deepEqual(
	decideClosedFileConflict({
		baselineHash: null,
		diskHash: "B",
		crdtHash: "C",
		diskMtime: 1000,
		lastSaveDiskIndexAt: 1000,
	}),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing-baseline, diskMtime === lastSaveDiskIndexAt → not newer → CRDT wins",
);

// disk === crdt is always no-op regardless of baseline or mtime
assert.deepEqual(
	decideClosedFileConflict({
		baselineHash: null,
		diskHash: "same",
		crdtHash: "same",
		diskMtime: 9999,
		lastSaveDiskIndexAt: 1,
	}),
	{ kind: "no-op" },
	"disk===crdt is no-op even with mtime evidence and null baseline",
);

console.log("\n--- Test 2: stale disk with newer remote — no mtime evidence → CRDT canonical ---");

{
	const staleDisk = "old local disk";
	const newerRemoteCrdt = "newer remote server state";
	let canonicalCrdt = newerRemoteCrdt;
	let canonicalDisk = staleDisk;
	const conflictArtifacts: Array<{ side: "disk" | "crdt"; content: string }> = [];

	// No mtime evidence → CRDT wins (existing behavior, safe default)
	const decision = decideClosedFileConflict({
		baselineHash: null,
		diskHash: "stale-disk-hash",
		crdtHash: "newer-remote-hash",
	});

	if (decision.kind === "preserve-conflict") {
		const preservedContent = decision.preserveDisk ? canonicalDisk : canonicalCrdt;
		const preservedSide = decision.preserveDisk ? "disk" : "crdt";
		conflictArtifacts.push({ side: preservedSide, content: preservedContent });
		if (decision.winner === "disk") {
			canonicalCrdt = canonicalDisk;
		} else {
			canonicalDisk = canonicalCrdt;
		}
	}

	assert.equal(canonicalCrdt, newerRemoteCrdt, "canonical CRDT remains the newer remote version");
	assert.equal(canonicalDisk, newerRemoteCrdt, "canonical disk is updated from CRDT");
	assert.deepEqual(
		conflictArtifacts,
		[{ side: "disk", content: staleDisk }],
		"stale disk is preserved as the conflict artifact",
	);
}

console.log("\n--- Test 3: user edited while YAOS was inactive — mtime evidence → disk wins ---");

{
	const localEdit = "my offline note edits";
	const remoteContent = "newer remote server state";
	let canonicalCrdt = remoteContent;
	let canonicalDisk = localEdit;
	const conflictArtifacts: Array<{ side: "disk" | "crdt"; content: string }> = [];

	// diskMtime > lastSaveDiskIndexAt → Issue #22-B case → disk wins
	const decision = decideClosedFileConflict({
		baselineHash: null,
		diskHash: "local-edit-hash",
		crdtHash: "remote-hash",
		diskMtime: 1_700_000_000_000,   // file modified at T+1h
		lastSaveDiskIndexAt: 1_699_996_400_000, // YAOS last saved T-1h
	});

	if (decision.kind === "preserve-conflict") {
		const preservedContent = decision.preserveDisk ? canonicalDisk : canonicalCrdt;
		const preservedSide = decision.preserveDisk ? "disk" : "crdt";
		conflictArtifacts.push({ side: preservedSide, content: preservedContent });
		if (decision.winner === "disk") {
			canonicalCrdt = canonicalDisk;
		} else {
			canonicalDisk = canonicalCrdt;
		}
	}

	assert.equal(decision.kind, "preserve-conflict", "preserve-conflict decision");
	assert.equal(decision.kind === "preserve-conflict" && decision.reason, "missing-baseline", "reason is missing-baseline");
	assert.equal(decision.kind === "preserve-conflict" && decision.winner, "disk", "disk wins when edited after last save");
	assert.equal(canonicalDisk, localEdit, "canonical disk is the user's local edit");
	assert.equal(canonicalCrdt, localEdit, "canonical CRDT is updated from disk (disk wins)");
	assert.deepEqual(
		conflictArtifacts,
		[{ side: "crdt", content: remoteContent }],
		"remote CRDT content is preserved as the conflict artifact",
	);
}

console.log("\n──────────────────────────────────────────────────");
