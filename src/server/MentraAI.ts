/**
 * MentraAI — Main MentraOS AppServer for the AI assistant.
 *
 * Handles the glasses lifecycle (onSession/onStop) and wires up
 * all the managers, event listeners, and query processing.
 */

import { AppServer, AppSession } from "@mentra/sdk";
import { sessions } from "./manager/SessionManager";
import { connectDB } from "./db/connection";

const WELCOME_SOUND_URL = process.env.WELCOME_SOUND_URL;

export interface MentraAIConfig {
  packageName: string;
  apiKey: string;
  port: number;
  cookieSecret?: string;
}

export class MentraAI extends AppServer {
  constructor(config: MentraAIConfig) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      cookieSecret: config.cookieSecret,
    });
  }

  /**
   * Called when a user launches the app on their glasses
   */
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    console.log(`🚀 Mentra AI session started for ${userId} | model: ${session.capabilities?.modelName ?? 'unknown (capabilities not yet loaded)'} | hasCamera: ${session.capabilities?.hasCamera} | hasDisplay: ${session.capabilities?.hasDisplay} | hasSpeaker: ${session.capabilities?.hasSpeaker}`);

    // Get or create user
    const user = sessions.getOrCreate(userId);

    // Initialize async components (database, settings)
    await user.initialize();

    // Wire up glasses session
    user.setAppSession(session);

    // Set up transcription callback for query processing
    user.transcription.setOnQueryReady(async (query, speakerId, prePhoto) => {
      await user.queryProcessor.processQuery(query, speakerId, prePhoto);
    });

    // Wire up location updates
    session.events.onLocation((locationData) => {
      user.location.updateCoordinates(locationData.lat, locationData.lng);
    });

    // Wire up phone notifications
    session.events.onPhoneNotifications((notifications) => {
      if (Array.isArray(notifications)) {
        user.notifications.addNotifications(notifications);
      } else if (notifications) {
        user.notifications.addNotification(notifications);
      }
    });

    // Wire up timezone from SDK settings
    const userTimezone = session.settings.getMentraOS<string>('userTimezone');
    if (userTimezone) {
      user.location.setTimezone(userTimezone);
      console.log(`🕐 Set timezone: ${userTimezone}`);
    }

    // Listen for timezone changes
    session.settings.onMentraosChange<string>('userTimezone', (newTimezone) => {
      if (newTimezone) {
        user.location.setTimezone(newTimezone);
        console.log(`🕐 Updated timezone: ${newTimezone}`);
      }
    });

    // Play welcome message (with delay for camera-only glasses)
    this.playWelcome(session, sessionId);

    console.log(`✅ Mentra AI ready for ${userId}`);
  }

  /**
   * Play the welcome sound/message
   */
  private playWelcome(session: AppSession, sessionId: string): void {
    const hasDisplay = session.capabilities?.hasDisplay ?? false;

    if (hasDisplay) {
      // HUD glasses: show text
      session.layouts.showTextWall(
        "Mentra AI\n\nWelcome to Mentra AI.\nSay \"Hey Mentra\" followed by your question.",
        { durationMs: 3000 }
      );
    } else {
      // Camera-only glasses: play welcome audio after delay
      if (WELCOME_SOUND_URL) {
        setTimeout(() => {
          session.audio.playAudio({ audioUrl: WELCOME_SOUND_URL }).catch((err) => {
            console.debug("Welcome audio failed:", err);
          });
        }, 2000);
      }
    }
  }

  /**
   * Called when a user closes the app or disconnects
   */
  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    console.log(`👋 Mentra AI session ended for ${userId}: ${reason}`);

    try {
      sessions.remove(userId);
      console.log(`🗑️ Cleaned up session for ${userId}`);
    } catch (err) {
      console.error(`Error during session cleanup for ${userId}:`, err);
    }
  }
}

/**
 * Create and configure the Mentra AI server
 */
export async function createMentraAIServer(config: MentraAIConfig): Promise<MentraAI> {
  // Connect to MongoDB
  await connectDB();

  // Create server
  const server = new MentraAI(config);

  return server;
}
