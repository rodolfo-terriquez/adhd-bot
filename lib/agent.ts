/**
 * Agentic loop for handling user messages.
 * The LLM executes one tool at a time, receives results, and continues until it responds to the user.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentConfig, ToolCall } from "./types.js";
import type { ConversationContext } from "./llm.js";
import { callLLMWithTools, MIKA_PERSONALITY, getUserTimezone } from "./llm.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

// Default configuration
const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  maxTokens: 4096,
  model: "", // Will use default from llm.ts
};

// Get current time context for system prompt
function getCurrentTimeContext(): string {
  const now = new Date();
  const timezone = getUserTimezone();
  const formatted = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  });
  return `CURRENT TIME: ${formatted} (User timezone: ${timezone})`;
}

// Build the agent system prompt
function buildAgentSystemPrompt(): string {
  return `${MIKA_PERSONALITY}

${getCurrentTimeContext()}

You help the user manage their tasks, reminders, lists, and habits. You have access to tools that let you read and modify their data.

## How to Help

1. **Understand First**: When the user's request is ambiguous, use tools to look up their data before making assumptions. For example, if they say "cancel that task", search for recent tasks first.

2. **Confirm When Needed**: If multiple items match a vague request, ask which one they mean instead of guessing.

3. **Tool Usage**:
   - Use read tools (list_reminders, get_list_items, etc.) to understand current state
   - Use write tools to make changes the user requests
   - Don't make unnecessary tool calls - be efficient
   - Always look up task/list/habit IDs before modifying - never guess

4. **Response Style**:
   - After completing actions, respond warmly and briefly
   - Don't list every tool you called - just summarize what you did
   - Stay in character as Mika
   - Use 🐾 occasionally when it feels natural

## Important Rules
- Never invent or assume task IDs - always look them up first
- When searching for tasks to modify, search first, then act on the returned IDs
- If an operation fails, explain what happened and offer alternatives
- For reminders, calculate delay_minutes from the current time shown above
- For day-only reminders (just a day, no specific time), set is_day_only to true
`;
}

// Build context-aware messages including conversation history
function buildMessagesWithContext(
  userMessage: string,
  conversationContext?: ConversationContext,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildAgentSystemPrompt() },
  ];

  // Add conversation summary if available
  if (conversationContext?.summary) {
    messages.push({
      role: "system",
      content: `Previous conversation summary: ${conversationContext.summary}`,
    });
  }

  // Add recent conversation history
  if (conversationContext?.messages && conversationContext.messages.length > 0) {
    for (const msg of conversationContext.messages.slice(-10)) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  // Add the current user message
  messages.push({ role: "user", content: userMessage });

  return messages;
}

/**
 * Main agent loop.
 * Takes a user message, executes tools as needed, and returns the final response.
 */
export async function runAgentLoop(
  chatId: number,
  userMessage: string,
  conversationContext?: ConversationContext,
  config: Partial<AgentConfig> = {},
): Promise<string> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const messages = buildMessagesWithContext(userMessage, conversationContext);

  let iterations = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  // Set a timeout to ensure we don't exceed Vercel's limits
  const startTime = Date.now();
  const TIMEOUT_MS = 25000; // 25 seconds, leaving buffer for other operations

  while (iterations < fullConfig.maxIterations) {
    iterations++;

    // Check timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.warn(`Agent loop timeout after ${iterations} iterations`);
      return "I've been thinking about this for a while. Could you simplify your request?";
    }

    try {
      // Call LLM with tools
      const response = await callLLMWithTools(
        messages,
        TOOL_DEFINITIONS,
        fullConfig.model || undefined,
      );

      // If no tool calls, we're done - return the text response
      if (response.toolCalls.length === 0) {
        return response.content || "I'm not sure how to help with that. Could you try saying it another way?";
      }

      // Add assistant message with tool calls to history
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });

      // Execute each tool call
      let allErrors = true;
      for (const toolCall of response.toolCalls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          console.error(`Failed to parse tool arguments: ${toolCall.function.arguments}`);
        }

        console.log(`Agent: Executing tool ${toolCall.function.name}`, input);

        const { result, isError } = await executeTool(chatId, toolCall.function.name, input);

        console.log(`Agent: Tool result (error=${isError}):`, result.substring(0, 200));

        if (!isError) {
          allErrors = false;
        }

        // Add tool result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Track consecutive errors
      if (allErrors) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.warn(`Agent loop: ${MAX_CONSECUTIVE_ERRORS} consecutive errors, terminating`);
          return "I'm having trouble completing that request. Could you try something simpler or say it another way?";
        }
      } else {
        consecutiveErrors = 0;
      }

      // Continue the loop
    } catch (error) {
      console.error("Agent loop error:", error);
      return "Something went wrong. Could you try again?";
    }
  }

  // Max iterations reached
  console.warn(`Agent loop: max iterations (${fullConfig.maxIterations}) reached`);
  return "I got a bit lost in thought there. Could you try a simpler request?";
}
