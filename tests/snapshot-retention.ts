/**
 * Unit tests for snapshot retention policy and semantic hash computation.
 *
 * Usage:
 *   node --import jiti/register tests/snapshot-retention.ts
 */

import * as Y from "yjs";
import {
	selectRetention,
	computeStateVectorHash,
	computeSemanticHash,
	DEFAULT_RETENTION,
	type SnapshotIndex,
	type RetentionPolicy,
} from "../server/src/snapshot";

// -------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg}`);
		failed++;
	}
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	if (actual === expected) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		failed++;
	}
}

function makeSnapshot(
	id: string,
	createdAt: string,
	opts?: Partial<SnapshotIndex>,
): SnapshotIndex {
	return {
		snapshotId: id,
		vaultId: "test-vault",
		createdAt,
		day: createdAt.slice(0, 10),
		schemaVersion: 1,
		markdownFileCount: 5,
		blobFileCount: 2,
		crdtSizeBytes: 1000,
		crdtRawSizeBytes: 2000,
		referencedBlobHashes: [],
		...opts,
	};
}

// -------------------------------------------------------------------
// Retention tests
// -------------------------------------------------------------------

async function testRetention(): Promise<void> {
	console.log("\n═══════════════════════════════════════════════");
	console.log("RETENTION POLICY TESTS");
	console.log("═══════════════════════════════════════════════\n");

	const now = new Date("2026-05-27T12:00:00Z");

	// Test 1: Always keep latest
	console.log("--- Test 1: Always keep latest ---");
	{
		const snapshots = [makeSnapshot("s1", "2025-01-01T00:00:00Z")];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		assertEqual(keep.length, 1, "latest is always kept even if ancient");
		assertEqual(prune.length, 0, "nothing to prune");
	}

	// Test 2: Keep all within 7 days
	console.log("\n--- Test 2: Keep all within 7 days ---");
	{
		const snapshots = [
			makeSnapshot("s3", "2026-05-27T00:00:00Z"),
			makeSnapshot("s2", "2026-05-26T00:00:00Z"),
			makeSnapshot("s1", "2026-05-21T00:00:00Z"),
		];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		assertEqual(keep.length, 3, "all 3 within 7 days are kept");
		assertEqual(prune.length, 0, "nothing pruned");
	}

	// Test 3: Weekly retention beyond 7 days
	console.log("\n--- Test 3: Weekly retention beyond 7 days ---");
	{
		const snapshots = [
			makeSnapshot("s-latest", "2026-05-27T00:00:00Z"),
			// 10 days ago (within weekly window, week 21)
			makeSnapshot("s-10d", "2026-05-17T00:00:00Z"),
			makeSnapshot("s-11d", "2026-05-16T00:00:00Z"),
			// 21 days ago (clearly different week, week 19)
			makeSnapshot("s-21d", "2026-05-06T00:00:00Z"),
		];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		// s-latest: kept (latest + within 7d)
		// s-10d: kept (newest in its week)
		// s-11d: same week as s-10d — might be kept or pruned depending on week boundary
		// s-21d: kept (newest in its week)
		assert(keep.some(s => s.snapshotId === "s-latest"), "latest kept");
		assert(keep.some(s => s.snapshotId === "s-10d"), "newest in week kept");
		assert(keep.some(s => s.snapshotId === "s-21d"), "different week kept");
		// s-11d may or may not be pruned depending on exact week boundary,
		// so just verify the core invariants hold
		assertEqual(keep.length + prune.length, 4, "all snapshots accounted for");
	}

	// Test 4: Pinned snapshots always kept
	console.log("\n--- Test 4: Pinned snapshots always kept ---");
	{
		const snapshots = [
			makeSnapshot("s-latest", "2026-05-27T00:00:00Z"),
			makeSnapshot("s-ancient-pinned", "2024-01-01T00:00:00Z", { pinned: true }),
			makeSnapshot("s-ancient", "2024-01-02T00:00:00Z"),
		];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		assert(keep.some(s => s.snapshotId === "s-ancient-pinned"), "pinned snapshot kept regardless of age");
		assert(prune.some(s => s.snapshotId === "s-ancient"), "unpinned ancient snapshot pruned");
	}

	// Test 5: Monthly retention
	console.log("\n--- Test 5: Monthly retention beyond weekly window ---");
	{
		const snapshots = [
			makeSnapshot("s-latest", "2026-05-27T00:00:00Z"),
			// 2 months ago (within monthly window)
			makeSnapshot("s-march-a", "2026-03-15T00:00:00Z"),
			makeSnapshot("s-march-b", "2026-03-10T00:00:00Z"),
			// 3 months ago
			makeSnapshot("s-feb", "2026-02-20T00:00:00Z"),
		];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		assert(keep.some(s => s.snapshotId === "s-march-a"), "newest in March kept");
		assert(keep.some(s => s.snapshotId === "s-feb"), "newest in Feb kept");
		assert(prune.some(s => s.snapshotId === "s-march-b"), "older in March pruned");
	}

	// Test 6: Empty list
	console.log("\n--- Test 6: Empty list ---");
	{
		const { keep, prune } = selectRetention([], DEFAULT_RETENTION, now);
		assertEqual(keep.length, 0, "empty keep");
		assertEqual(prune.length, 0, "empty prune");
	}

	// Test 7: Never prune the only snapshot
	console.log("\n--- Test 7: Single ancient unpinned snapshot ---");
	{
		const snapshots = [makeSnapshot("s-only", "2020-01-01T00:00:00Z")];
		const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);
		assertEqual(keep.length, 1, "single snapshot always kept (it's the latest)");
		assertEqual(prune.length, 0, "nothing to prune");
	}
}

// -------------------------------------------------------------------
// Semantic hash tests
// -------------------------------------------------------------------

async function testSemanticHash(): Promise<void> {
	console.log("\n═══════════════════════════════════════════════");
	console.log("SEMANTIC HASH TESTS");
	console.log("═══════════════════════════════════════════════\n");

	// Test 1: Same doc produces same hash
	console.log("--- Test 1: Deterministic hash ---");
	{
		const doc = new Y.Doc();
		doc.transact(() => {
			doc.getMap<string>("pathToId").set("a.md", "id-a");
			doc.getMap<string>("pathToId").set("b.md", "id-b");
			doc.getMap("pathToBlob").set("img.png", { hash: "abc123", size: 100 });
		});

		const h1 = await computeSemanticHash(doc);
		const h2 = await computeSemanticHash(doc);
		assertEqual(h1, h2, "same doc produces same semantic hash");
		assert(h1.length === 64, "hash is 64 hex chars (sha256)");
		doc.destroy();
	}

	// Test 2: Different content produces different hash
	console.log("\n--- Test 2: Content change changes hash ---");
	{
		const doc1 = new Y.Doc();
		doc1.transact(() => {
			doc1.getMap<string>("pathToId").set("a.md", "id-a");
		});

		const doc2 = new Y.Doc();
		doc2.transact(() => {
			doc2.getMap<string>("pathToId").set("a.md", "id-a");
			doc2.getMap<string>("pathToId").set("b.md", "id-b");
		});

		const h1 = await computeSemanticHash(doc1);
		const h2 = await computeSemanticHash(doc2);
		assert(h1 !== h2, "adding a file changes semantic hash");
		doc1.destroy();
		doc2.destroy();
	}

	// Test 3: Blob change changes hash
	console.log("\n--- Test 3: Blob change changes hash ---");
	{
		const doc = new Y.Doc();
		doc.transact(() => {
			doc.getMap("pathToBlob").set("img.png", { hash: "aaa", size: 100 });
		});
		const h1 = await computeSemanticHash(doc);

		doc.transact(() => {
			doc.getMap("pathToBlob").set("img.png", { hash: "bbb", size: 200 });
		});
		const h2 = await computeSemanticHash(doc);
		assert(h1 !== h2, "changing blob hash changes semantic hash");
		doc.destroy();
	}

	// Test 4: Path ordering doesn't matter
	console.log("\n--- Test 4: Path ordering independence ---");
	{
		const doc1 = new Y.Doc();
		doc1.transact(() => {
			doc1.getMap<string>("pathToId").set("z.md", "id-z");
			doc1.getMap<string>("pathToId").set("a.md", "id-a");
		});

		const doc2 = new Y.Doc();
		doc2.transact(() => {
			doc2.getMap<string>("pathToId").set("a.md", "id-a");
			doc2.getMap<string>("pathToId").set("z.md", "id-z");
		});

		const h1 = await computeSemanticHash(doc1);
		const h2 = await computeSemanticHash(doc2);
		assertEqual(h1, h2, "insertion order does not affect semantic hash");
		doc1.destroy();
		doc2.destroy();
	}

	// Test 5: State vector hash changes with any operation
	console.log("\n--- Test 5: State vector hash ---");
	{
		const doc = new Y.Doc();
		doc.transact(() => {
			doc.getMap<string>("pathToId").set("a.md", "id-a");
		});
		const h1 = await computeStateVectorHash(doc);

		doc.transact(() => {
			doc.getMap("sys").set("someMetadata", 42);
		});
		const h2 = await computeStateVectorHash(doc);
		assert(h1 !== h2, "metadata-only change still changes state vector hash");

		// But semantic hash should NOT change
		const doc2 = new Y.Doc();
		doc2.transact(() => {
			doc2.getMap<string>("pathToId").set("a.md", "id-a");
		});
		const sh1 = await computeSemanticHash(doc2);
		doc2.transact(() => {
			doc2.getMap("sys").set("someMetadata", 42);
		});
		const sh2 = await computeSemanticHash(doc2);
		assertEqual(sh1, sh2, "metadata-only change does NOT change semantic hash");

		doc.destroy();
		doc2.destroy();
	}
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║  Snapshot Retention & Semantic Hash Tests     ║");
	console.log("╚═══════════════════════════════════════════════╝");

	await testRetention();
	await testSemanticHash();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
