/**
 * Observer debug port interfaces (safe, passive only).
 *
 * Product runtime can expose YaosDebugPort (read-only / non-mutating).
 *
 * YaosUnsafeQaPort lives in qa/harness/ports/yaosUnsafeQaPort.ts.
 * src/sync/, src/runtime/, and src/telemetry/ must NEVER import it.
 * The guard:qa-isolation script enforces this.
 */

export type { YaosDebugPort, EditorBindingHealth, ReceiptSnapshot } from "./yaosDebugPort";
