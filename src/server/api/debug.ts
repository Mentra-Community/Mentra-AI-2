/**
 * Debug API — dev-only endpoints for testing session lifecycle.
 */

import type { Context } from "hono";
import { sessions } from "../manager/SessionManager";
import { broadcastChatEvent, clearPendingEvents } from "./chat";

/**
 * POST /api/debug/kill-session?userId=<id>&mode=soft|hard
 *
 * Simulates MentraAI.onStop().
 * - mode=soft (default): grace period, keeps session alive for 60s
 * - mode=hard: immediate destroy, wipes everything
 */
export async function killSession(c: Context) {
  const userId = c.req.query("userId");
  const mode = c.req.query("mode") || "soft";
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No session for ${userId}` }, 404);

  if (mode === "hard") {
    // Hard kill — immediate destroy (old behavior)
    broadcastChatEvent(userId, {
      type: "session_ended",
      reason: "debug-hard-kill",
      timestamp: new Date().toISOString(),
    });
    clearPendingEvents(userId);
    sessions.remove(userId);

    return c.json({
      success: true,
      mode: "hard",
      message: `Session hard-killed for ${userId}`,
    });
  }

  // Soft kill — grace period (matches real onStop behavior)
  broadcastChatEvent(userId, {
    type: "session_reconnecting",
    reason: "debug-soft-kill",
    timestamp: new Date().toISOString(),
  });
  sessions.softRemove(userId);

  return c.json({
    success: true,
    mode: "soft",
    message: `Session soft-killed for ${userId} (60s grace period)`,
  });
}
