/**
 * Debug API — dev-only endpoints for testing session lifecycle.
 */

import type { Context } from "hono";
import { sessions } from "../manager/SessionManager";
import { broadcastChatEvent, clearPendingEvents } from "./chat";

/**
 * POST /api/debug/kill-session?userId=<id>
 *
 * Simulates MentraAI.onStop() — broadcasts session_ended then removes user.
 */
export async function killSession(c: Context) {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No session for ${userId}` }, 404);

  // Same sequence as MentraAI.onStop()
  broadcastChatEvent(userId, {
    type: "session_ended",
    reason: "debug-kill",
    timestamp: new Date().toISOString(),
  });

  clearPendingEvents(userId);
  sessions.remove(userId);

  return c.json({
    success: true,
    message: `Session killed for ${userId}`,
  });
}
