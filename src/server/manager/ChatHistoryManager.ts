/**
 * ChatHistoryManager - Handles conversation history storage in MongoDB
 *
 * Features:
 * - Per-day conversation storage
 * - In-memory cache for fast access
 * - Configurable history window
 */

import type { User } from "../session/User";
import { Conversation, type IConversationTurn } from "../db/schemas/conversation.schema";
import { UserSettings } from "../db/schemas/user-settings.schema";
import { CONVERSATION_SETTINGS } from "../constants/config";

/**
 * A conversation turn for context
 */
export interface ConversationTurn {
  query: string;
  response: string;
  timestamp: Date;
  hadPhoto: boolean;
}

/**
 * ChatHistoryManager — manages conversation history for a single user.
 */
export class ChatHistoryManager {
  // In-memory cache of recent turns (for fast access)
  private recentTurns: ConversationTurn[] = [];

  // User settings cache
  private chatHistoryEnabled: boolean = true;

  constructor(private user: User) {}

  /**
   * Initialize the manager (load settings and today's conversation)
   */
  async initialize(): Promise<void> {
    await this.loadSettings();
    await this.loadTodayConversation();
  }

  /**
   * Load user settings
   */
  private async loadSettings(): Promise<void> {
    try {
      const settings = await UserSettings.findOne({ userId: this.user.userId });
      if (settings) {
        this.chatHistoryEnabled = settings.chatHistoryEnabled;
      }
    } catch (error) {
      console.warn(`Failed to load settings for ${this.user.userId}:`, error);
    }
  }

  /**
   * Load today's conversation into memory
   */
  private async loadTodayConversation(): Promise<void> {
    if (!this.chatHistoryEnabled) return;

    try {
      const today = this.getTodayDate();
      const conversation = await Conversation.findOne({
        userId: this.user.userId,
        date: today,
      });

      if (conversation) {
        this.recentTurns = conversation.turns.map(turn => ({
          query: turn.query,
          response: turn.response,
          timestamp: turn.timestamp,
          hadPhoto: turn.hadPhoto,
        }));
        console.log(`📚 Loaded ${this.recentTurns.length} turns from today's conversation`);
      }
    } catch (error) {
      console.warn(`Failed to load conversation for ${this.user.userId}:`, error);
    }
  }

  /**
   * Add a conversation turn
   */
  async addTurn(query: string, response: string, hadPhoto: boolean = false): Promise<void> {
    if (!this.chatHistoryEnabled) {
      console.log(`📚 Chat history disabled for ${this.user.userId}, skipping save`);
      return;
    }

    const turn: ConversationTurn = {
      query,
      response,
      timestamp: new Date(),
      hadPhoto,
    };

    // Add to in-memory cache
    this.recentTurns.push(turn);

    // Trim in-memory cache to max turns
    if (this.recentTurns.length > CONVERSATION_SETTINGS.maxTurns) {
      this.recentTurns = this.recentTurns.slice(-CONVERSATION_SETTINGS.maxTurns);
    }

    // Save to MongoDB
    try {
      const today = this.getTodayDate();

      await Conversation.findOneAndUpdate(
        { userId: this.user.userId, date: today },
        {
          $push: {
            turns: {
              query: turn.query,
              response: turn.response,
              timestamp: turn.timestamp,
              hadPhoto: turn.hadPhoto,
            } as IConversationTurn,
          },
        },
        { upsert: true, new: true }
      );

      console.log(`💾 Saved conversation turn for ${this.user.userId}`);
    } catch (error) {
      console.error(`Failed to save conversation for ${this.user.userId}:`, error);
    }
  }

  /**
   * Get recent turns for context
   * Filters by age and returns up to maxTurns
   */
  getRecentTurns(limit?: number): ConversationTurn[] {
    const now = Date.now();
    const maxAge = CONVERSATION_SETTINGS.maxAgeMs;
    const maxTurns = limit ?? CONVERSATION_SETTINGS.maxTurns;

    // Filter by age
    const recent = this.recentTurns.filter(turn => {
      const age = now - turn.timestamp.getTime();
      return age < maxAge;
    });

    // Return most recent
    return recent.slice(-maxTurns);
  }

  /**
   * Format conversation history for the prompt
   */
  formatForPrompt(limit?: number): string {
    const turns = this.getRecentTurns(limit);

    if (turns.length === 0) {
      return "";
    }

    const formatted = turns.map(turn => {
      const photoNote = turn.hadPhoto ? " (with photo)" : "";
      return `User${photoNote}: ${turn.query}\nAssistant: ${turn.response}`;
    }).join("\n\n");

    return `## Previous Conversation\n\n${formatted}`;
  }

  /**
   * Get conversation history by date (for webview)
   */
  async getHistoryByDate(date: Date): Promise<ConversationTurn[]> {
    try {
      const conversation = await Conversation.findOne({
        userId: this.user.userId,
        date: this.normalizeDate(date),
      });

      if (!conversation) return [];

      return conversation.turns.map(turn => ({
        query: turn.query,
        response: turn.response,
        timestamp: turn.timestamp,
        hadPhoto: turn.hadPhoto,
      }));
    } catch (error) {
      console.error(`Failed to get history for ${this.user.userId}:`, error);
      return [];
    }
  }

  /**
   * Clear today's conversation
   */
  async clearToday(): Promise<void> {
    this.recentTurns = [];

    try {
      const today = this.getTodayDate();
      await Conversation.deleteOne({
        userId: this.user.userId,
        date: today,
      });
      console.log(`🗑️ Cleared today's conversation for ${this.user.userId}`);
    } catch (error) {
      console.error(`Failed to clear conversation for ${this.user.userId}:`, error);
    }
  }

  /**
   * Clear all conversation history
   */
  async clearAll(): Promise<void> {
    this.recentTurns = [];

    try {
      await Conversation.deleteMany({ userId: this.user.userId });
      console.log(`🗑️ Cleared all conversations for ${this.user.userId}`);
    } catch (error) {
      console.error(`Failed to clear all conversations for ${this.user.userId}:`, error);
    }
  }

  /**
   * Update chat history enabled setting
   */
  async setChatHistoryEnabled(enabled: boolean): Promise<void> {
    this.chatHistoryEnabled = enabled;

    try {
      await UserSettings.findOneAndUpdate(
        { userId: this.user.userId },
        { chatHistoryEnabled: enabled },
        { upsert: true }
      );
    } catch (error) {
      console.error(`Failed to update chat history setting for ${this.user.userId}:`, error);
    }
  }

  /**
   * Check if chat history is enabled
   */
  isChatHistoryEnabled(): boolean {
    return this.chatHistoryEnabled;
  }

  /**
   * Get today's date (normalized to midnight)
   */
  private getTodayDate(): Date {
    return this.normalizeDate(new Date());
  }

  /**
   * Normalize a date to midnight UTC
   */
  private normalizeDate(date: Date): Date {
    const normalized = new Date(date);
    normalized.setUTCHours(0, 0, 0, 0);
    return normalized;
  }

  /**
   * Clean up (called on session end)
   */
  destroy(): void {
    // In-memory cache is cleared, but MongoDB data persists
    this.recentTurns = [];
    console.log(`🗑️ ChatHistoryManager cleaned up for ${this.user.userId}`);
  }
}
