/**
 * QueryProcessor - Orchestrates the full query → response pipeline
 *
 * This is the main entry point for processing user queries.
 * It coordinates all managers and the agent to produce responses.
 */

import type { User } from "../session/User";
import { generateResponse, type GenerateOptions } from "../agent/MentraAgent";
import { formatForTTS } from "../utils/tts-formatter";
import { isVisionQuery } from "../utils/wake-word";

const PROCESSING_SOUND_URL = process.env.PROCESSING_SOUND_URL;

/**
 * QueryProcessor — handles the full query processing pipeline.
 */
export class QueryProcessor {
  constructor(private user: User) {}

  /**
   * Process a user query and return the response
   */
  async processQuery(query: string, speakerId?: string): Promise<string> {
    const session = this.user.appSession;
    if (!session) {
      console.error(`No active session for ${this.user.userId}`);
      return "I'm not connected to your glasses right now.";
    }

    console.log(`🔄 Processing query for ${this.user.userId}: "${query.slice(0, 50)}..."`);

    // Play processing sound
    await this.playProcessingSound();

    // Step 1: Capture photo (always, if camera available)
    let photos: Buffer[] = [];
    const hasCamera = session.capabilities?.hasCamera ?? false;

    if (hasCamera) {
      const currentPhoto = await this.user.photo.takePhoto();
      if (currentPhoto) {
        photos = this.user.photo.getPhotosForContext();
      }
    }

    // Step 2: Fetch location if needed
    if (this.user.location.queryNeedsLocation(query)) {
      // Request fresh location from SDK
      try {
        const locationData = await session.location.getLatestLocation({ accuracy: "high" });
        if (locationData) {
          this.user.location.updateCoordinates(locationData.lat, locationData.lng);
          await this.user.location.fetchContextIfNeeded(query);
        }
      } catch (error) {
        console.warn(`Failed to get location for ${this.user.userId}:`, error);
      }
    }

    // Step 3: Get local time
    const localTime = this.getLocalTime();

    // Step 4: Build agent context
    const context: GenerateOptions["context"] = {
      hasDisplay: session.capabilities?.hasDisplay ?? false,
      hasSpeakers: session.capabilities?.hasSpeaker ?? true,
      hasCamera,
      location: this.user.location.getCachedContext(),
      localTime,
      timezone: this.user.location.getCachedContext()?.timezone,
      notifications: this.user.notifications.formatForPrompt(),
      conversationHistory: this.user.chatHistory.getRecentTurns(),
    };

    // Step 5: Generate response
    let response: string;
    try {
      const result = await generateResponse({
        query,
        photos: photos.length > 0 ? photos : undefined,
        context,
      });
      response = result.response;
    } catch (error) {
      console.error(`Agent error for ${this.user.userId}:`, error);
      response = "I'm sorry, I had trouble processing that. Please try again.";
    }

    // Step 6: Format response for output
    const formattedResponse = this.formatResponse(
      response,
      context.hasSpeakers,
      context.hasDisplay
    );

    // Step 7: Output response
    await this.outputResponse(formattedResponse, context.hasSpeakers, context.hasDisplay);

    // Step 8: Save to chat history
    const hadPhoto = photos.length > 0;
    await this.user.chatHistory.addTurn(query, response, hadPhoto);

    console.log(`✅ Query processed for ${this.user.userId}`);

    return response;
  }

  /**
   * Play the processing sound
   */
  private async playProcessingSound(): Promise<void> {
    if (!PROCESSING_SOUND_URL || !this.user.appSession) return;

    try {
      await this.user.appSession.audio.playAudio({ audioUrl: PROCESSING_SOUND_URL });
    } catch (error) {
      console.debug("Processing sound failed:", error);
    }
  }

  /**
   * Get local time string
   */
  private getLocalTime(): string {
    // Use timezone from location context if available
    const timezone = this.user.location.getCachedContext()?.timezone;

    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      };

      if (timezone) {
        options.timeZone = timezone;
      }

      return now.toLocaleTimeString("en-US", options);
    } catch {
      return new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }
  }

  /**
   * Format response for output
   */
  private formatResponse(
    response: string,
    hasSpeakers: boolean,
    hasDisplay: boolean
  ): string {
    // For speaker-only glasses, format for TTS
    if (hasSpeakers && !hasDisplay) {
      return formatForTTS(response);
    }

    // For HUD glasses or mixed, return as-is
    return response;
  }

  /**
   * Output the response (speak and/or display)
   */
  private async outputResponse(
    response: string,
    hasSpeakers: boolean,
    hasDisplay: boolean
  ): Promise<void> {
    const session = this.user.appSession;
    if (!session) return;

    // Display on HUD if available
    if (hasDisplay) {
      try {
        await session.layouts.showTextWall(response, { durationMs: 10000 });
      } catch (error) {
        console.debug("Display output failed:", error);
      }
    }

    // Speak if speakers available
    if (hasSpeakers) {
      try {
        await session.audio.speak(response);
      } catch (error) {
        console.debug("Speech output failed:", error);
      }
    }
  }
}
