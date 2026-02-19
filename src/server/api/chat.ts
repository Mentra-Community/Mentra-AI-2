/**
 * Chat API
 *
 * Handles chat SSE stream and message broadcasting.
 */

import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { sessions } from "../manager/SessionManager";

// Custom writer interface for SSE clients
interface SSEWriter {
  write: (data: string) => Promise<void>;
  id: string;
}

// SSE clients for chat updates per user
const chatClients = new Map<string, Set<SSEWriter>>();

/**
 * Add a chat SSE client for a user
 */
function addChatClient(userId: string, writer: SSEWriter) {
  if (!chatClients.has(userId)) {
    chatClients.set(userId, new Set());
  }
  chatClients.get(userId)!.add(writer);
}

/**
 * Remove a chat SSE client for a user
 */
function removeChatClient(userId: string, writerId: string) {
  const clients = chatClients.get(userId);
  if (clients) {
    for (const client of clients) {
      if (client.id === writerId) {
        clients.delete(client);
        break;
      }
    }
    if (clients.size === 0) {
      chatClients.delete(userId);
    }
  }
}

/**
 * Broadcast a chat event to all clients for a user
 */
export function broadcastChatEvent(userId: string, event: {
  type: 'message' | 'processing' | 'idle' | 'history' | 'session_started' | 'session_ended' | 'session_heartbeat';
  [key: string]: unknown;
}) {
  const clients = chatClients.get(userId);
  if (!clients) return;

  const data = JSON.stringify(event);

  for (const writer of clients) {
    try {
      writer.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected
      clients.delete(writer);
    }
  }
}

/**
 * Chat SSE stream endpoint
 */
export async function chatStream(c: Context) {
  const userId = c.req.query("userId");
  const recipientId = c.req.query("recipientId");

  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const writerId = `${userId}-${Date.now()}`;

    // Create a custom writer that we can track
    const customWriter: SSEWriter = {
      id: writerId,
      write: async (data: string) => {
        await stream.write(data);
      },
    };

    addChatClient(userId, customWriter);

    // Send connected event
    await stream.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Get recent chat history if available
    const user = sessions.get(userId);
    if (user) {
      const recentTurns = user.chatHistory.getRecentTurns(30);
      if (recentTurns.length > 0) {
        const messages = recentTurns.flatMap((turn, index) => [
          {
            id: `${Date.now()}-${index * 2}`,
            senderId: userId,
            recipientId: recipientId || "mentra-ai",
            content: turn.query,
            timestamp: turn.timestamp.toISOString(),
            image: turn.photoDataUrl,
          },
          {
            id: `${Date.now()}-${index * 2 + 1}`,
            senderId: recipientId || "mentra-ai",
            recipientId: userId,
            content: turn.response,
            timestamp: turn.timestamp.toISOString(),
          },
        ]);

        await stream.write(
          `data: ${JSON.stringify({ type: "history", messages })}\n\n`
        );
      }
    }

    // Send immediate session status so frontend doesn't wait up to 15s
    const currentUser = sessions.get(userId);
    const isCurrentlyActive = currentUser != null && currentUser.appSession != null;
    await stream.write(`data: ${JSON.stringify({
      type: "session_heartbeat",
      active: isCurrentlyActive,
      timestamp: new Date().toISOString(),
    })}\n\n`);

    // Session heartbeat — periodic status ping with active/inactive state
    const heartbeatInterval = setInterval(async () => {
      try {
        const heartbeatUser = sessions.get(userId);
        const isActive = heartbeatUser != null && heartbeatUser.appSession != null;
        await stream.write(`data: ${JSON.stringify({
          type: "session_heartbeat",
          active: isActive,
          timestamp: new Date().toISOString(),
        })}\n\n`);
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 15000);

    // Wait for abort signal
    stream.onAbort(() => {
      clearInterval(heartbeatInterval);
      removeChatClient(userId, writerId);
    });

    // Keep stream open
    await new Promise(() => {});
  });
}
