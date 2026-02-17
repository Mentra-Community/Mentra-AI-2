/**
 * Mentra Agent - Main AI agent using Mastra
 *
 * Creates and manages the Mastra agent for query processing.
 */

import { Agent } from "@mastra/core/agent";
import { searchTool, calculatorTool, thinkingTool } from "./tools";
import { buildSystemPrompt, classifyResponseMode, type AgentContext } from "./prompt";
import { ResponseMode, AGENT_SETTINGS } from "../constants/config";
import type { LocationContext } from "../manager/LocationManager";
import type { ConversationTurn } from "../manager/ChatHistoryManager";

/**
 * Content part for multimodal messages
 */
export interface ContentPart {
  type: "text" | "image";
  text?: string;
  image?: Buffer;
}

/**
 * Agent generation options
 */
export interface GenerateOptions {
  query: string;
  photos?: Buffer[];
  context: {
    hasDisplay: boolean;
    hasSpeakers: boolean;
    hasCamera: boolean;
    glassesType: 'display' | 'camera';
    location: LocationContext | null;
    localTime: string;
    timezone?: string;
    notifications: string;
    conversationHistory: ConversationTurn[];
  };
  onToolCall?: (toolName: string) => void;
}

/**
 * Agent generation result
 */
export interface GenerateResult {
  response: string;
  toolCalls: number;
}

/**
 * Create a Mentra agent with the given context
 */
export function createMentraAgent(context: AgentContext): Agent {
  return new Agent({
    id: "mentra-ai",
    name: "Mentra AI",
    model: "google/gemini-2.5-flash",
    instructions: buildSystemPrompt(context),
    tools: {
      search: searchTool,
      calculator: calculatorTool,
      thinking: thinkingTool,
    },
  });
}

/**
 * Generate a response using the Mentra agent
 */
export async function generateResponse(options: GenerateOptions): Promise<GenerateResult> {
  const { query, photos, context } = options;

  // Classify response mode
  const responseMode = classifyResponseMode(query, context.hasDisplay);

  // Build full agent context
  const agentContext: AgentContext = {
    hasDisplay: context.hasDisplay,
    hasSpeakers: context.hasSpeakers,
    hasCamera: context.hasCamera,
    hasMicrophone: true,  // Always true
    glassesType: context.glassesType,
    responseMode,
    location: context.location,
    localTime: context.localTime,
    timezone: context.timezone,
    notifications: context.notifications,
    conversationHistory: context.conversationHistory,
  };

  // Create agent with context
  const agent = createMentraAgent(agentContext);

  // Build content array
  const content: ContentPart[] = [
    { type: "text", text: query },
  ];

  // Add photos (current + previous)
  if (photos && photos.length > 0) {
    for (const photoBuffer of photos) {
      content.push({
        type: "image",
        image: photoBuffer,
      });
    }
  }

  console.log(`🤖 Generating response for: "${query.slice(0, 50)}${query.length > 50 ? '...' : ''}"`);
  console.log(`   Mode: ${responseMode}, Photos: ${photos?.length || 0}, History: ${context.conversationHistory.length}`);

  let toolCallCount = 0;

  try {
    // Generate response
    const result = await agent.generate([
      {
        role: "user",
        content: content as any,  // Type coercion for Mastra
      },
    ], {
      maxSteps: AGENT_SETTINGS.maxSteps,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls) {
          toolCallCount += toolCalls.length;
          console.log(`   Tool calls this step: ${toolCalls.length}`);
          if (options.onToolCall) {
            for (const tc of toolCalls) {
              if (tc.payload?.toolName) {
                options.onToolCall(tc.payload.toolName);
              }
            }
          }
        }
      },
    });

    const response = typeof result.text === 'string' ? result.text : String(result.text || '');

    console.log(`✅ Response generated (${response.length} chars, ${toolCallCount} tool calls)`);

    return {
      response,
      toolCalls: toolCallCount,
    };

  } catch (error) {
    console.error("❌ Agent generation error:", error);
    throw error;
  }
}

/**
 * Quick helper to get response mode from query
 */
export { classifyResponseMode } from "./prompt";
export { ResponseMode } from "../constants/config";
