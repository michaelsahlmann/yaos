#!/usr/bin/env node

/**
 * guard-production-bundles.mjs
 *
 * Verifies that the production bundles (main.js, telemetry.js) do not
 * contain symbols that violate the Observer/Engine/Puppeteer split.
 *
 * Run after build:
 *   node scripts/guard-production-bundles.mjs          # strict (default)
 *   node scripts/guard-production-bundles.mjs --transitional  # warn on Engine test seams
 *
 * == Modes ==
 *
 *   strict (default, used in CI):
 *     Fails if any forbidden symbol is found in any bundle, including the
 *     known-deferred Engine test seams (__qaOnly / Unsafe / ForceSync).
 *     Use this in CI to detect regressions. Will fail until Engine test seams
 *     are removed (separate architectural phase).
 *
 *   transitional (--transitional flag):
 *     Fails on new forbidden symbols. Warns on the known-deferred Engine
 *     test seams listed below. Use locally when working on other changes
 *     that should not require fixing Engine test seams first.
 *
 * == Architecture ==
 *
 *   main.js      = Engine only.
 *                  Must NOT contain telemetry implementations or Puppeteer code.
 *
 *   telemetry.js = passive Observer only.
 *                  May contain FlightRecorder, DeviceWitnessTracker, etc.
 *                  Must NOT contain mutation harness code (Puppeteer).
 *
 *   qa/          = Puppeteer harness only. Not shipped.
 *                  May contain dangerous names.
 *
 * == Known deferred Engine test seams in main.js ==
 *
 * BLOCKER (separate phase): These __qaOnly / Unsafe / ForceSync symbols
 * exist on product classes (ReconciliationController, EditorBindingManager)
 * and cannot be removed without injected unsafe capability ports.
 *
 *   src/runtime/reconciliationController.ts:1447 __qaOnlyForceSyncFileFromDiskUnsafe
 *   src/runtime/reconciliationController.ts:1456 __qaOnlyPauseEditorBindingPropagationUnsafe
 *   src/runtime/reconciliationController.ts:1461 __qaOnlyResumeEditorBindingPropagationUnsafe
 *   src/runtime/reconciliationController.ts:1474 __qaOnlySetExternalEditPolicyOverrideUnsafe
 *   src/sync/editorBinding.ts:891               __qaOnlyPauseBindingPropagationUnsafe
 *   src/sync/editorBinding.ts:913               __qaOnlyResumeBindingPropagationUnsafe
 *
 * Count: 6 methods, touching 3 symbol strings (ForceSync, Unsafe, __qaOnly).
 * Do NOT add new entries to MAIN_FORBIDDEN_DEFERRED without explicit sign-off.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TRANSITIONAL = process.argv.includes("--transitional");

// ---------------------------------------------------------------------------
// main.js — must not contain telemetry implementations or Puppeteer code
// ---------------------------------------------------------------------------

const MAIN_FORBIDDEN = [
	// Telemetry implementations (must stay out of product bundle)
	"DeviceWitnessTracker",
	"FlightRecorder",
	"FlightTraceController",
	"FlightTraceSink",
	"PersistentTraceLogger",
	// Puppeteer command names
	"qaExportWitnessBundle",
	"startQaFlightTrace",
	"stopQaFlightTrace",
	"exportSafeFlightTrace",
	"exportFullFlightTrace",
	// Puppeteer scenario controls
	"setScenarioRunId",
	"advanceScenarioStep",
	"witnessDeviceSettled",
	// VFS torture
	"VfsTorture",
	"vfsTorture",
	// Force operations
	"ForceCrdt",
	"forceCrdt",
];

// Known deferred Engine test seams (see header for full list and blocker note).
// In strict mode these FAIL. In transitional mode these WARN.
const MAIN_FORBIDDEN_DEFERRED = [
	"ForceSync",   // __qaOnlyForceSyncFileFromDiskUnsafe
	"Unsafe",      // all __qaOnly*Unsafe methods
	"__qaOnly",    // all __qaOnly methods
];

// ---------------------------------------------------------------------------
// telemetry.js — must not contain Puppeteer/mutation harness code
// (no deferred exceptions — telemetry.js must be fully clean)
// ---------------------------------------------------------------------------

const TELEMETRY_FORBIDDEN = [
	"VfsTorture", "vfsTorture",
	"ForceCrdt", "forceCrdt",
	"ForceSync", "forceSync",
	"setScenarioRunId",
	"advanceScenarioStep",
	"networkHold", "setQaNetworkHold",
	"PauseEditorBinding", "pauseEditorBinding",
	"Unsafe", "unsafe-local", "__qaOnly",
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function checkBundle(bundlePath, forbidden, deferred, bundleName) {
	if (!existsSync(bundlePath)) {
		console.error(`FAIL [${bundleName}]: bundle not found at ${bundlePath}`);
		console.error("  Run 'npm run build' first.");
		return 1;
	}
	const content = readFileSync(bundlePath, "utf8");
	const violations = forbidden.filter((s) => content.includes(s));
	const deferredHits = deferred.filter((s) => content.includes(s));

	if (violations.length > 0) {
		console.error(`FAIL [${bundleName}]: forbidden symbols found:`);
		violations.forEach((v) => console.error(`  - ${v}`));
	}

	if (deferredHits.length > 0) {
		if (TRANSITIONAL) {
			console.warn(`WARN [${bundleName}]: Engine test seams present (deferred — see BLOCKER in guard script):`);
			deferredHits.forEach((v) => console.warn(`  - ${v}`));
		} else {
			console.error(`FAIL [${bundleName}]: Engine test seams present (fix required or use --transitional):`);
			deferredHits.forEach((v) => console.error(`  - ${v}  (deferred Engine test seam — see BLOCKER in guard script)`));
		}
	}

	const totalFail = violations.length + (TRANSITIONAL ? 0 : deferredHits.length);
	if (totalFail > 0) return totalFail;

	const sizeKb = (content.length / 1024).toFixed(1);
	const note = deferredHits.length > 0 ? ` [${deferredHits.length} Engine test seam(s) deferred]` : "";
	console.log(`PASS [${bundleName}] (${sizeKb} KB)${note}`);
	return 0;
}

// ---------------------------------------------------------------------------
// src/ → qa/ isolation
// ---------------------------------------------------------------------------

const SRC_QA_IMPORT_PATTERNS = [
	/from\s+["'][^"']*\/qa\//,
	/from\s+["']\.\.\/qa\//,
	/from\s+["']\.\.\/\.\.\/qa\//,
];

function scanSrcForQaImports(dir) {
	let count = 0;
	let entries;
	try { entries = readdirSync(dir); } catch { return 0; }
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let st;
		try { st = statSync(fullPath); } catch { continue; }
		if (st.isDirectory()) {
			count += scanSrcForQaImports(fullPath);
		} else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
			const rel = relative(".", fullPath);
			let src;
			try { src = readFileSync(fullPath, "utf8"); } catch { continue; }
			for (const pat of SRC_QA_IMPORT_PATTERNS) {
				const m = src.match(pat);
				if (m) {
					console.error(`FAIL [src->qa import]: ${rel}: ${m[0]}`);
					count++;
				}
			}
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failures = 0;

if (TRANSITIONAL) {
	console.log("Mode: transitional (Engine test seams warn, not fail)\n");
}

failures += checkBundle("main.js", MAIN_FORBIDDEN, MAIN_FORBIDDEN_DEFERRED, "main.js");
failures += checkBundle("telemetry.js", TELEMETRY_FORBIDDEN, [], "telemetry.js");

const srcQaViolations = scanSrcForQaImports("src");
if (srcQaViolations > 0) {
	console.error(`FAIL: ${srcQaViolations} src/ → qa/ import violation(s). src/ must not import from qa/.`);
	failures += srcQaViolations;
} else {
	console.log("PASS [src->qa isolation]: src/ does not import from qa/.");
}

if (failures > 0) {
	console.error(`\nFAIL: ${failures} production bundle violation(s).`);
	process.exit(1);
} else if (TRANSITIONAL) {
	console.log("\nPARTIAL PASS (transitional): Observer bundle clean; Engine test seams remain.\nRun without --transitional to see full failure list.");
	process.exit(0);
} else {
	console.log("\nPASS: all production bundle guards passed.");
	process.exit(0);
}
