/**
 * API Route Definitions
 *
 * Maps HTTP methods + paths to handler functions.
 * Each handler lives in its own file under api/.
 */

import { Hono } from "hono";
import { getHealth } from "../api/health";
import { photoStream, transcriptionStream } from "../api/stream";
import { speak, stopAudio } from "../api/audio";
import { getThemePreference, setThemePreference } from "../api/storage";
import { getLatestPhoto, getPhotoData, getPhotoBase64 } from "../api/photo";
import { getSettings, updateSettings } from "../api/settings";
import { chatStream } from "../api/chat";
import { killSession } from "../api/debug";

export const api = new Hono();

// Health
api.get("/health", getHealth);

// SSE streams — disable proxy buffering so Nginx/ingress forwards data immediately.
// Without this, heartbeats get stuck in Nginx's response buffer and the proxy
// considers the connection idle after its read timeout (~60s), killing the SSE.
const sseHeaders = async (c: any, next: any) => {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  await next();
};
api.use("/photo-stream", sseHeaders);
api.use("/transcription-stream", sseHeaders);
api.use("/chat/stream", sseHeaders);
api.get("/photo-stream", photoStream);
api.get("/transcription-stream", transcriptionStream);
api.get("/chat/stream", chatStream);

// Audio
api.post("/speak", speak);
api.post("/stop-audio", stopAudio);

// Storage / preferences
api.get("/theme-preference", getThemePreference);
api.post("/theme-preference", setThemePreference);

// User settings
api.get("/settings", getSettings);
api.patch("/settings", updateSettings);

// Photos
api.get("/latest-photo", getLatestPhoto);
api.get("/photo/:requestId", getPhotoData);
api.get("/photo-base64/:requestId", getPhotoBase64);

// Debug (dev only)
if (process.env.NODE_ENV === "development") {
  api.post("/debug/kill-session", killSession);
}
