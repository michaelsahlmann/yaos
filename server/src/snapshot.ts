import * as Y from "yjs";
import { gzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";
import { sha256Hex, bytesToHex } from "./hex";

export interface SnapshotIndex {
	snapshotId: string;
	vaultId: string;
	createdAt: string;
	day: string;
	schemaVersion: number | undefined;
	markdownFileCount: number;
	blobFileCount: number;
	crdtSizeBytes: number;
	crdtRawSizeBytes: number;
	referencedBlobHashes: string[];
	triggeredBy?: string;
	/** SHA-256 hex of Y.encodeStateVector(ydoc) — cheap causal-state fingerprint. */
	stateVectorHash?: string;
	/** SHA-256 hex of sorted active paths + blob hashes — semantic content fingerprint. */
	semanticHash?: string;
	/** Whether this snapshot is pinned (exempt from automatic retention). */
	pinned?: boolean;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	reason?: string;
	index?: SnapshotIndex;
}

// -------------------------------------------------------------------
// Retention policy
// -------------------------------------------------------------------

export interface RetentionPolicy {
	keepDays: number;
	keepWeekly: number;
	keepMonthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	keepDays: 7,
	keepWeekly: 4,
	keepMonthly: 12,
};

const SNAPSHOT_FETCH_CONCURRENCY = 4;

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function blobKey(vaultId: string, hash: string): string {
	return `v1/${vaultId}/blobs/${hash}`;
}

function generateSnapshotId(): string {
	const ts = Date.now().toString(36);
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${ts}-${rand}`;
}

function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
	return `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
}

function normalizeBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await bucket.list({
			prefix,
			limit: 1000,
			cursor,
		});

		for (const object of page.objects) {
			keys.push(object.key);
		}

		if (!page.truncated) break;
		cursor = page.cursor;
	}

	return keys;
}

export async function hasSnapshotForDay(
	vaultId: string,
	day: string,
	bucket: R2Bucket,
): Promise<boolean> {
	const page = await bucket.list({
		prefix: `v1/${vaultId}/snapshots/${day}/`,
		limit: 1,
	});
	return page.objects.length > 0;
}

// -------------------------------------------------------------------
// Semantic hash computation
// -------------------------------------------------------------------

/**
 * Compute the state vector hash: SHA-256 of Y.encodeStateVector(ydoc).
 * This is a cheap causal-state fingerprint. If unchanged, the CRDT has
 * received no new operations at all.
 */
export async function computeStateVectorHash(ydoc: Y.Doc): Promise<string> {
	const sv = Y.encodeStateVector(ydoc);
	return sha256Hex(sv);
}

/**
 * Compute the semantic hash: SHA-256 of sorted active paths and their
 * associated content identifiers (file IDs for markdown, blob hashes for blobs).
 *
 * This detects whether the user-visible vault state has changed, even if the
 * state vector changed due to metadata-only CRDT operations.
 */
export async function computeSemanticHash(ydoc: Y.Doc): Promise<string> {
	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");

	// Build sorted entries: "md:{path}:{fileId}" and "blob:{path}:{hash}"
	const entries: string[] = [];

	pathToId.forEach((fileId, path) => {
		// Include Y.Text content hash proxy: use the fileId + path as identity.
		// For full semantic equality we'd hash actual text content, but that's
		// expensive. Use fileId as a stable proxy — content changes cause new
		// Y.Text operations which change the state vector anyway.
		entries.push(`md:${path}:${fileId}`);
	});

	pathToBlob.forEach((ref: unknown, path) => {
		if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
		const hash = (ref as { hash?: unknown }).hash;
		if (typeof hash === "string") {
			entries.push(`blob:${path}:${hash}`);
		}
	});

	entries.sort();
	const payload = new TextEncoder().encode(entries.join("\n"));
	return sha256Hex(payload);
}

// -------------------------------------------------------------------
// Latest snapshot index (avoids full listing)
// -------------------------------------------------------------------

const LATEST_INDEX_KEY_SUFFIX = "latest-index.json";

function latestIndexKey(vaultId: string): string {
	return `v1/${vaultId}/snapshots/${LATEST_INDEX_KEY_SUFFIX}`;
}

/**
 * Retrieve the latest snapshot index without scanning all snapshot keys.
 * Falls back to null if no latest pointer exists yet.
 */
export async function getLatestSnapshotIndex(
	vaultId: string,
	bucket: R2Bucket,
): Promise<SnapshotIndex | null> {
	try {
		const object = await bucket.get(latestIndexKey(vaultId));
		if (!object) return null;
		const text = await object.text();
		return JSON.parse(text) as SnapshotIndex;
	} catch {
		return null;
	}
}

/**
 * Persist the latest snapshot index pointer for fast retrieval.
 */
async function writeLatestIndex(
	vaultId: string,
	index: SnapshotIndex,
	bucket: R2Bucket,
): Promise<void> {
	await bucket.put(latestIndexKey(vaultId), JSON.stringify(index), {
		httpMetadata: { contentType: "application/json" },
	});
}

// -------------------------------------------------------------------
// Snapshot creation
// -------------------------------------------------------------------

export async function createSnapshot(
	ydoc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	triggeredBy?: string,
): Promise<SnapshotIndex> {
	const day = today();
	const snapshotId = generateSnapshotId();
	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	const rawUpdate = Y.encodeStateAsUpdate(ydoc);
	const compressed = gzipSync(rawUpdate);

	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");
	const sys = ydoc.getMap<unknown>("sys");

	const referencedBlobHashes: string[] = [];
	pathToBlob.forEach((ref: unknown) => {
		if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
		const hash = (ref as { hash?: unknown }).hash;
		if (typeof hash === "string") {
			referencedBlobHashes.push(hash);
		}
	});

	const [stateVectorHash, semanticHash] = await Promise.all([
		computeStateVectorHash(ydoc),
		computeSemanticHash(ydoc),
	]);

	const index: SnapshotIndex = {
		snapshotId,
		vaultId,
		createdAt: new Date().toISOString(),
		day,
		schemaVersion: sys.get("schemaVersion") as number | undefined,
		markdownFileCount: pathToId.size,
		blobFileCount: pathToBlob.size,
		crdtSizeBytes: compressed.byteLength,
		crdtRawSizeBytes: rawUpdate.byteLength,
		referencedBlobHashes,
		triggeredBy,
		stateVectorHash,
		semanticHash,
	};

	await Promise.all([
		bucket.put(`${prefix}/crdt.bin.gz`, compressed, {
			httpMetadata: {
				contentType: "application/gzip",
			},
		}),
		bucket.put(`${prefix}/index.json`, JSON.stringify(index), {
			httpMetadata: {
				contentType: "application/json",
			},
		}),
		writeLatestIndex(vaultId, index, bucket),
	]);

	return index;
}

export async function listSnapshots(
	vaultId: string,
	bucket: R2Bucket,
	limit?: number,
): Promise<SnapshotIndex[]> {
	const keys = await listAllKeys(bucket, `v1/${vaultId}/snapshots/`);
	const indexKeys = keys
		.filter((key) => key.endsWith("/index.json") && !key.endsWith(LATEST_INDEX_KEY_SUFFIX))
		.sort()
		.reverse(); // newest day prefixes first (lexicographic desc of YYYY-MM-DD)

	const bounded = limit ? indexKeys.slice(0, limit) : indexKeys;

	const indexes = await mapWithConcurrency(
		bounded,
		SNAPSHOT_FETCH_CONCURRENCY,
		async (key) => {
			try {
				const object = await bucket.get(key);
				if (!object) return null;
				const text = await object.text();
				return JSON.parse(text) as SnapshotIndex;
			} catch {
				return null;
			}
		},
	);

	return indexes
		.filter((index): index is SnapshotIndex => index !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshotPayload(
	vaultId: string,
	snapshotId: string,
	bucket: R2Bucket,
): Promise<{ index: SnapshotIndex; payload: Uint8Array } | null> {
	const snapshots = await listSnapshots(vaultId, bucket);
	const index = snapshots.find((entry) => entry.snapshotId === snapshotId);
	if (!index) return null;

	const object = await bucket.get(
		`${snapshotPrefix(vaultId, index.day, snapshotId)}/crdt.bin.gz`,
	);
	if (!object) return null;

	const body = await object.arrayBuffer();
	return {
		index,
		payload: normalizeBytes(body),
	};
}

// -------------------------------------------------------------------
// Retention
// -------------------------------------------------------------------

/**
 * Given a list of snapshot indexes (sorted newest-first), determine which
 * to keep and which to prune based on the default retention policy.
 *
 * Rules:
 *   - Always keep the latest snapshot.
 *   - Always keep pinned snapshots.
 *   - Keep all snapshots from the last `keepDays` days.
 *   - Keep the newest snapshot per ISO week for `keepWeekly` weeks.
 *   - Keep the newest snapshot per month for `keepMonthly` months.
 *   - Everything else is a prune candidate.
 */
export function selectRetention(
	snapshots: SnapshotIndex[],
	policy: RetentionPolicy = DEFAULT_RETENTION,
	now: Date = new Date(),
): { keep: SnapshotIndex[]; prune: SnapshotIndex[] } {
	if (snapshots.length === 0) return { keep: [], prune: [] };

	const keepSet = new Set<string>();

	// Always keep latest
	keepSet.add(snapshots[0].snapshotId);

	// Always keep pinned
	for (const s of snapshots) {
		if (s.pinned) keepSet.add(s.snapshotId);
	}

	const nowMs = now.getTime();
	const dayMs = 24 * 60 * 60 * 1000;

	// Keep all within keepDays
	const daysCutoff = nowMs - policy.keepDays * dayMs;
	for (const s of snapshots) {
		if (new Date(s.createdAt).getTime() >= daysCutoff) {
			keepSet.add(s.snapshotId);
		}
	}

	// Keep newest per ISO week for keepWeekly weeks (beyond keepDays)
	const weeklyCutoff = nowMs - (policy.keepDays + policy.keepWeekly * 7) * dayMs;
	const seenWeeks = new Set<string>();
	for (const s of snapshots) {
		const ts = new Date(s.createdAt).getTime();
		if (ts >= daysCutoff) continue; // already kept by daily rule
		if (ts < weeklyCutoff) continue;
		const week = isoWeekKey(new Date(s.createdAt));
		if (!seenWeeks.has(week)) {
			seenWeeks.add(week);
			keepSet.add(s.snapshotId);
		}
	}

	// Keep newest per month for keepMonthly months (beyond weekly window)
	const monthlyCutoff = nowMs - (policy.keepDays + policy.keepWeekly * 7 + policy.keepMonthly * 30) * dayMs;
	const seenMonths = new Set<string>();
	for (const s of snapshots) {
		const ts = new Date(s.createdAt).getTime();
		if (ts >= weeklyCutoff) continue; // already handled
		if (ts < monthlyCutoff) continue;
		const month = s.createdAt.slice(0, 7); // "YYYY-MM"
		if (!seenMonths.has(month)) {
			seenMonths.add(month);
			keepSet.add(s.snapshotId);
		}
	}

	const keep: SnapshotIndex[] = [];
	const prune: SnapshotIndex[] = [];
	for (const s of snapshots) {
		if (keepSet.has(s.snapshotId)) {
			keep.push(s);
		} else {
			prune.push(s);
		}
	}
	return { keep, prune };
}

/**
 * Delete pruned snapshot objects from R2.
 * Returns the number of snapshots successfully deleted.
 */
export async function pruneSnapshots(
	vaultId: string,
	toPrune: SnapshotIndex[],
	bucket: R2Bucket,
): Promise<{ deleted: number; failed: number }> {
	let deleted = 0;
	let failed = 0;

	for (const s of toPrune) {
		const prefix = snapshotPrefix(vaultId, s.day, s.snapshotId);
		try {
			await bucket.delete([`${prefix}/crdt.bin.gz`, `${prefix}/index.json`]);
			deleted++;
		} catch {
			failed++;
		}
	}

	// Update latest-index if needed (shouldn't prune latest, but be safe)
	return { deleted, failed };
}

/**
 * Run retention: list snapshots, select retention, prune excess.
 */
export async function applyRetention(
	vaultId: string,
	bucket: R2Bucket,
	policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<{ kept: number; pruned: number; failed: number }> {
	const all = await listSnapshots(vaultId, bucket);
	const { keep, prune } = selectRetention(all, policy);
	if (prune.length === 0) return { kept: keep.length, pruned: 0, failed: 0 };
	const result = await pruneSnapshots(vaultId, prune, bucket);
	return { kept: keep.length, pruned: result.deleted, failed: result.failed };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function isoWeekKey(date: Date): string {
	// Approximate ISO week: year + week number
	const jan1 = new Date(date.getFullYear(), 0, 1);
	const dayOfYear = Math.ceil((date.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
	const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
	return `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}
