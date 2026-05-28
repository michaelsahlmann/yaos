import type { VaultSyncServer } from "../server";

export interface Env {
	SYNC_TOKEN?: string;
	YAOS_CANONICAL_REPO?: string;
	YAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
	/**
	 * Set to any non-empty string to reject WebSocket connections that use
	 * the legacy ?token= query parameter instead of a short-lived ticket.
	 * Enables this after all clients in your deployment have upgraded to
	 * Release N (ticket-aware plugin).  Emits a console.warn on every legacy
	 * auth attempt even when not set, so you can monitor adoption before
	 * disabling.
	 */
	YAOS_DISABLE_LEGACY_WS_TOKEN?: string;
	/**
	 * Override the ticket TTL (milliseconds) for testing.
	 * When set, the ticket endpoint issues tickets with this TTL instead of
	 * the default 5-minute production value.  Never set this in production.
	 * Used by the local wrangler dev integration harness to make the proactive
	 * refresh timer fire in seconds rather than minutes.
	 */
	YAOS_TICKET_TTL_MS?: string;
}

export type JsonResponse = (body: unknown, status?: number) => Response;

export type AuthState =
	| { mode: "env"; claimed: true; envToken: string }
	| { mode: "claim"; claimed: true; tokenHash: string }
	| { mode: "unclaimed"; claimed: false };

export type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

export type UpdateProvider = "github" | "gitlab" | "unknown";
