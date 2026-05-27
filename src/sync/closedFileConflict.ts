export type ClosedFileConflictDecision =
	| { kind: "no-op" }
	| { kind: "apply-remote-to-disk"; reason: "disk-at-baseline" }
	| { kind: "import-disk-to-crdt"; reason: "crdt-at-baseline" }
	| {
		kind: "preserve-conflict";
		reason: "both-changed" | "missing-baseline";
		winner: "disk" | "crdt";
		preserveCrdt?: true;
		preserveDisk?: true;
	};

export interface ClosedFileConflictInput {
	baselineHash: string | null;
	diskHash: string;
	crdtHash: string;
	/**
	 * mtime (Unix ms) of the disk file at reconciliation time.
	 * Used to break the missing-baseline tie: if the disk file is newer
	 * than the last known clean sync state (lastSaveDiskIndexAt), the file
	 * was probably edited while YAOS was inactive, and disk should win.
	 * Optional — when absent the missing-baseline path falls back to
	 * winner: "crdt" (the safe distributed default).
	 */
	diskMtime?: number;
	/**
	 * Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Persisted in data.json as _lastSaveDiskIndexAt.
	 * Used together with diskMtime to detect "edited while YAOS was inactive."
	 * Optional — when absent the mtime evidence path is skipped.
	 */
	lastSaveDiskIndexAt?: number;
}

export function decideClosedFileConflict(
	input: ClosedFileConflictInput,
): ClosedFileConflictDecision {
	const { baselineHash, diskHash, crdtHash, diskMtime, lastSaveDiskIndexAt } = input;
	if (diskHash === crdtHash) return { kind: "no-op" };
	if (baselineHash === null) {
		// No baseline — we don't know who changed what.
		// Use mtime evidence to break the tie:
		//   If the disk file's mtime is AFTER the last time YAOS persisted
		//   clean state (lastSaveDiskIndexAt), the file was likely edited
		//   while YAOS was inactive/killed. Disk wins: the user's local work
		//   is visible in the main file; the CRDT remote content goes to an
		//   artifact. This is the correct behavior for Issue #22-B
		//   ("I turned YAOS off, edited my note, turned it back on").
		//
		//   If we have no mtime evidence (diskMtime or lastSaveDiskIndexAt
		//   absent), fall back to winner: "crdt" — the safe distributed
		//   default that protects shared remote state.
		const diskEditedWhileInactive =
			diskMtime !== undefined &&
			lastSaveDiskIndexAt !== undefined &&
			diskMtime > lastSaveDiskIndexAt;

		if (diskEditedWhileInactive) {
			return {
				kind: "preserve-conflict",
				reason: "missing-baseline",
				winner: "disk",
				preserveCrdt: true,
			};
		}
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			winner: "crdt",
			preserveDisk: true,
		};
	}
	if (diskHash === baselineHash && crdtHash !== baselineHash) {
		return { kind: "apply-remote-to-disk", reason: "disk-at-baseline" };
	}
	if (crdtHash === baselineHash && diskHash !== baselineHash) {
		return { kind: "import-disk-to-crdt", reason: "crdt-at-baseline" };
	}
	return {
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	};
}
