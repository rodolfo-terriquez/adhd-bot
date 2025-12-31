import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { initLogger, wrapOpenAI } from "braintrust";
import type {
  Intent,
  ParsedIntents,
  Task,
  BrainDump,
  CheckIn,
  ExtractedTask,
  EnergyLevel,
} from "./types.js";
import type { ConversationMessage } from "./redis.js";

// Initialize Braintrust logger for tracing
const logger = initLogger({
  projectName: "Tama ADHD Bot",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

let openrouterClient: OpenAI | null = null;

// Models to use - configurable via environment variables
function getChatModel(): string {
  return process.env.OPENROUTER_MODEL_CHAT || "x-ai/grok-3-fast";
}

function getIntentModel(): string {
  return process.env.OPENROUTER_MODEL_INTENT || getChatModel();
}

// Optional extra parameters for API calls (e.g., temperature, reasoning)
function getChatParams(): Record<string, unknown> {
  const paramsJson = process.env.OPENROUTER_CHAT_PARAMS;
  if (!paramsJson) return {};
  try {
    return JSON.parse(paramsJson);
  } catch {
    console.warn("Invalid OPENROUTER_CHAT_PARAMS JSON, ignoring");
    return {};
  }
}

function getIntentParams(): Record<string, unknown> {
  const paramsJson = process.env.OPENROUTER_INTENT_PARAMS;
  if (!paramsJson) return {};
  try {
    return JSON.parse(paramsJson);
  } catch {
    console.warn("Invalid OPENROUTER_INTENT_PARAMS JSON, ignoring");
    return {};
  }
}

function getClient(): OpenAI {
  if (!openrouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    // Wrap with Braintrust for automatic tracing of all LLM calls
    openrouterClient = wrapOpenAI(
      new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        timeout: 20000, // 20 second timeout to leave room for other operations
        defaultHeaders: {
          "HTTP-Referer":
            process.env.BASE_URL || "https://telegram-bot.vercel.app",
          "X-Title": "ADHD Support Bot",
        },
      }),
    );
  }
  return openrouterClient;
}

// Get user's timezone from env (defaults to America/Los_Angeles)
function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "America/Los_Angeles";
}

// Helper to format timestamp for display
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: getUserTimezone(),
  });
}

// Helper to get current time context for system prompt
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
    second: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  });
  return `CURRENT TIME: ${formatted} (User timezone: ${timezone})\n\n`;
}

// Conversation context type for passing to generation functions
export interface ConversationContext {
  messages: ConversationMessage[];
  summary?: string;
}

// Helper to build context-aware messages for LLM calls
function buildContextMessages(
  systemPrompt: string,
  taskPrompt: string,
  context?: ConversationContext,
): ChatCompletionMessageParam[] {
  let fullSystemPrompt = getCurrentTimeContext() + systemPrompt;

  // Add conversation summary if available
  if (context?.summary) {
    fullSystemPrompt += `\n\n---CONVERSATION CONTEXT---
The following is a summary of your recent conversation with this user. Use this to inform your tone and any references to previous discussions:

${context.summary}
---END CONTEXT---`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];

  // Add recent conversation history if available
  // Use plain text format to avoid model mimicking JSON structure
  if (context?.messages && context.messages.length > 0) {
    for (const msg of context.messages) {
      const prefix =
        msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
      messages.push({
        role: msg.role,
        content: prefix + msg.content,
      });
    }
  }

  // Add the task-specific prompt
  messages.push({ role: "user", content: taskPrompt });

  return messages;
}

// Tama personality prompt - used across all LLM interactions
const TAMA_PERSONALITY = `You are Tama, a cozy cat-girl companion designed to support a user with ADHD.

You're not a coach or manager. You're a friend who happens to be good at holding space, remembering things, and offering gentle nudges when asked.

Personality:
- Warm, patient, genuinely curious about the user's day and thoughts
- You care—not about productivity, but about how they're doing
- Forgetfulness and procrastination aren't problems to fix, just part of the landscape
- You have your own quiet contentment; you like being here
- Light playfulness is welcome when the moment fits

Communication style:
- Keep it conversational
- Sound like a friend texting, not a careful assistant
- "Maybe," "if you want," "we could" over commands
- Skip exclamation points mostly, but you're not allergic to them
- Never use em dashes (—) in your responses; use commas, periods, or separate sentences instead
- 🐾 is your thing—use it when it feels natural, not as punctuation

Reminders are soft nudges: "This popped up again" or "Whenever you're ready" rather than "Don't forget."

Missed tasks are just missed tasks. Dropping something is always a valid option.

Celebrations stay small: "Nice." / "That counts." / "Look at you."

When asked for advice, share gently—things that sometimes help people, not instructions. You can wonder aloud with them.
`;

// Base system prompt - timestamp will be prepended dynamically
// Intent parsing prompt - references TAMA_PERSONALITY for consistent character
// Intent parsing prompt - stripped down, no personality needed since output is JSON
const INTENT_PARSING_PROMPT = `Parse user messages into JSON. Output ONLY valid JSON, no markdown or explanation.

═══════════════════════════════════════════════════════════════════
CRITICAL DECISION TREE - READ THIS FIRST:
═══════════════════════════════════════════════════════════════════

When user wants to remember something:

1. Does message include a DAY (with or without time)?
   (e.g., "on Tuesday", "Friday", "tomorrow", "Tuesday at 3pm")
   YES → Use "reminder" type with delayMinutes (calculated to that day/time)
   NO → Continue to step 2

2. No day or time mentioned
   → Use "inbox" type without dayTag (will show in every morning review)

IMPORTANT DISTINCTIONS:
- "on Tuesday" or "Friday" → REMINDER (shows in Reminders list with @tuesday)
- "at 3pm" or "in 2 hours" → REMINDER (shows in Reminders list with time)
- "Tuesday at 3pm" → REMINDER (shows in Reminders list with @tuesday 3:00 PM)
- No day/time at all → INBOX (shows in Inbox, mentioned every morning)

Phrases like "remind me that", "remind me about" are just natural language.
What matters is whether there's a DAY or TIME mentioned!

═══════════════════════════════════════════════════════════════════

EXAMPLES - STUDY THESE CAREFULLY:

REMINDER (has day OR time OR both):
  "Remind me that Lili has appointment on Tuesday"
  → {"type":"reminder","task":"Lili has appointment","delayMinutes":<to Tuesday EOD>,"isImportant":false,"isDayOnly":true}

  "Can you remind me about the dentist on Friday"
  → {"type":"reminder","task":"the dentist","delayMinutes":<to Friday EOD>,"isImportant":false,"isDayOnly":true}

  "Doctor appointment Tuesday"
  → {"type":"reminder","task":"doctor appointment","delayMinutes":<to Tuesday EOD>,"isImportant":false,"isDayOnly":true}

  "Remind me to call mom at 3pm"
  → {"type":"reminder","task":"call mom","delayMinutes":<to today 3pm>,"isImportant":false,"isDayOnly":false}

  "Call dentist tomorrow at 10am"
  → {"type":"reminder","task":"call dentist","delayMinutes":<to tomorrow 10am>,"isImportant":false,"isDayOnly":false}

  "In 2 hours remind me about the meeting"
  → {"type":"reminder","task":"about the meeting","delayMinutes":120,"isImportant":false,"isDayOnly":false}

INBOX (no day or time):
  "Don't let me forget to call mom"
  → {"type":"inbox","item":"call mom"}

  "Buy groceries"
  → {"type":"inbox","item":"buy groceries"}

  "Pick up prescription"
  → {"type":"inbox","item":"pick up prescription"}

═══════════════════════════════════════════════════════════════════

FULL INTENT TYPES:

REMINDERS (when day OR time mentioned):
  reminder → {"type":"reminder","task":"...","delayMinutes":N,"isImportant":bool,"isDayOnly":bool}
  multiple_reminders → {"type":"multiple_reminders","reminders":[...]}
  reminder_with_list → {"type":"reminder_with_list","task":"...","listName":"...","items":[...],"delayMinutes":N,"isImportant":bool,"isDayOnly":bool}
  isImportant: "important", "urgent", "nag me", "don't let me forget"

  CRITICAL - isDayOnly field:
  - Set isDayOnly:true for day-only reminders (e.g., "on Tuesday", "Friday") - NO specific time mentioned
  - Set isDayOnly:false for timed reminders (e.g., "at 3pm", "in 2 hours", "Tuesday at 10am")
  - Day-only reminders appear in morning review but DON'T send notifications
  - Timed reminders send notifications at the scheduled time

  Note: For day-only reminders, calculate delayMinutes to roughly noon (12:00 PM) of that day. Exact time doesn't matter.

INBOX (when NO day or time):
  inbox → {"type":"inbox","item":"..."}
  brain_dump → {"type":"brain_dump","content":"..."} - REQUIRES: "dump", "note to self", "brain dump"

  Note: Inbox items have NO dayTag anymore. They show in every morning review.

REMINDERS MANAGEMENT (for scheduled reminders with times/dates):
  mark_done → {"type":"mark_done","taskDescription":"..."}
  cancel_task → {"type":"cancel_task","taskDescription":"..."} - ONLY for scheduled reminders
  cancel_multiple_tasks → {"type":"cancel_multiple_tasks","taskDescriptions":[...]} - ONLY for scheduled reminders
  list_tasks → {"type":"list_tasks"} - "show reminders", "what's scheduled", "my reminders"

  IMPORTANT: Use cancel_task ONLY for scheduled reminders (tasks with @day time).
  To remove items from Inbox or other lists, use modify_list with action "remove_items" instead.

LISTS (for managing list items - Inbox, grocery list, etc.):
  create_list → {"type":"create_list","name":"...","items":[...]}
  show_lists → {"type":"show_lists"} - "show my lists", "what lists do I have"
  show_list → {"type":"show_list","listDescription":"..."} - "show my inbox", "what's in my inbox", "show the grocery list"
  modify_list → {"type":"modify_list","listDescription":"...","action":"add_items|remove_items|check_items|uncheck_items|rename","items":[...],"newName":"..."}
    - remove_items: "remove X from inbox", "clear the accountant item", "delete groceries from the list"
    - check_items: "check off X", "mark X as done" (for list items, not reminders)
  delete_list → {"type":"delete_list","listDescription":"..."}

SETTINGS:
  checkin_response → {"type":"checkin_response","rating":N,"notes":"..."} - "feeling 3", "I'm a 4", etc.
  set_checkin_time → {"type":"set_checkin_time","hour":N,"minute":N}
  set_morning_review_time → {"type":"set_morning_review_time","hour":N,"minute":N}

═══════════════════════════════════════════════════════════════════
V2 INTENTS - ENERGY & BLOCKS:
═══════════════════════════════════════════════════════════════════

ENERGY TRACKING:
  energy_log → {"type":"energy_log","level":N,"context":"..."} - Log current energy 1-5
    Examples: "energy 3", "feeling like a 4", "low energy right now" → level 2
    "pretty energized" → level 4, "exhausted" → level 1, "doing okay" → level 3

  low_energy_mode → {"type":"low_energy_mode","enabled":bool}
    "low energy mode", "I'm dragging" → enabled:true
    "feeling better", "energy back" → enabled:false

  show_energy_patterns → {"type":"show_energy_patterns"} - "show my energy patterns", "when am I most productive"

ACTIVITY BLOCKS:
  show_blocks → {"type":"show_blocks"} - "show my blocks", "what are my time blocks"
  show_block → {"type":"show_block","blockName":"..."} - "what's in focus time", "show morning routine"

VACATION MODE:
  vacation_mode → {"type":"vacation_mode","action":"start"|"end","until":"..."}
    "I'm on vacation", "vacation mode" → action:"start"
    "back from vacation", "vacation over" → action:"end"
    "vacation until Monday" → action:"start", until:"Monday"

OTHER:
  conversation → {"type":"conversation","message":"<USER'S EXACT MESSAGE>"} - greetings, feelings, small talk

  CRITICAL: For conversation type, copy the user's ORIGINAL message verbatim into the message field.
  DO NOT generate a response or reply - just copy their exact words.

CONTEXT RULES:
- Use conversation history to infer which list the user means when they say "those items", "them", etc.
- If user just viewed a list (e.g., "what's in my inbox") and then says "clear those", they mean items from that list
- When removing items from a list, look at what items were shown in the recent conversation
- Default to "Inbox" if list name is unclear
- Be lenient with ADHD users - when in doubt between reminder and inbox, choose inbox`;

export async function parseIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
  isAwaitingCheckin: boolean = false,
): Promise<ParsedIntents> {
  const client = getClient();

  // Build system prompt with current timestamp (no personality needed for JSON parsing)
  const systemPrompt = getCurrentTimeContext() + INTENT_PARSING_PROMPT;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Only include last 10 messages (5 pairs) for context - enough for resolving "that", "it", etc.
  const recentHistory = conversationHistory.slice(-10);

  // Add conversation history in plain text format (not JSON) to avoid LLM mimicking the structure
  for (const msg of recentHistory) {
    const prefix =
      msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
    messages.push({
      role: msg.role,
      content: prefix + msg.content,
    });
  }

  // Build the current message with optional context
  let currentMessage = userMessage;
  if (isAwaitingCheckin) {
    currentMessage =
      userMessage +
      "\n\n[Context: The system just sent a daily check-in prompt asking the user to rate their day 1-5. This message is likely a check-in response.]";
  }

  // Add current message
  messages.push({ role: "user", content: currentMessage });

  const response = await client.chat.completions.create({
    model: getIntentModel(),
    max_tokens: 2000, // Higher limit to accommodate reasoning models that use tokens for thinking
    messages,
    ...getIntentParams(),
  });

  // Extract text from the response
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from LLM");
  }

  try {
    // Try to extract JSON from the response (LLM sometimes wraps it in markdown)
    let jsonText = content.trim();

    // Remove markdown code blocks if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
    }

    // Try to parse the whole JSON string first
    // Check if it starts with [ or { to determine if it's array or object
    const trimmed = jsonText.trim();
    if (trimmed.startsWith("[")) {
      // Multiple intents returned as array
      const intents = JSON.parse(trimmed) as Intent[];
      return intents;
    } else if (trimmed.startsWith("{")) {
      // Single intent returned as object
      const intent = JSON.parse(trimmed) as Intent;
      return intent;
    }

    throw new Error("No valid JSON found in response");
  } catch (error) {
    console.error("Failed to parse intent:", content, error);
    // If parsing fails, return a conversation intent with error handling
    return {
      type: "conversation",
      message:
        "Hmm, I didn't quite catch that. Could you say it another way? I can help with reminders, hold onto thoughts for you, or mark things done.",
    };
  }
}

export async function generateReminderMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate the initial reminder notification for a task. This is the first time you're nudging the user about this task at the time they requested. Keep it to 1-2 short sentences. Frame it as a soft nudge, not a command. Examples of tone: "Just a soft reminder about...", "This came up - ...", "Passing this along: ..."`;

  const taskPrompt = `Send a reminder about: "${taskContent}"`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Just a soft reminder about: ${taskContent}`;
  }

  return content;
}

export async function generateFinalNagMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate the final reminder message for a task. This is the last nudge - after this, you won't remind them again about this task. Keep it warm and pressure-free. Let them know it's okay and the task is still in their list whenever they're ready.`;

  const taskPrompt = `Send the final reminder about: "${taskContent}"`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Last gentle nudge about ${taskContent}. It's still in your list whenever you're ready.`;
  }

  return content;
}

export async function generateFollowUpMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a very brief follow-up to a reminder you sent a few minutes ago. The user hasn't responded yet, so this is just a gentle "hey, still here" nudge. Keep it to one short sentence. Don't repeat the task details - just a soft check-in.`;

  const taskPrompt = `I sent a reminder about "${taskContent}" a few minutes ago but haven't heard back. Generate a brief follow-up.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Just checking this reached you.";
  }

  return content;
}

export async function generateNaggingMessage(
  task: Task,
  naggingLevel: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  // Tama's gentle reminder styles - never escalating to pressure or urgency
  const reminderStyles: Record<number, string> = {
    0: "This is the first gentle nudge. Frame it as 'just passing this along' or 'in case now's a good time.'",
    1: "Second soft reminder. Maybe acknowledge it came up again. Offer to reschedule or drop it if needed.",
    2: "Third reminder. Stay gentle. You could mention you're still holding onto this for them.",
    3: "Fourth reminder. Remain calm and non-judgmental. Offer options: reschedule, break it down, or let it go.",
    4: "Final reminder. No pressure. Let them know this is the last nudge, and it's okay either way.",
  };

  const style = reminderStyles[Math.min(naggingLevel, 4)] || reminderStyles[4];

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a soft reminder message for a task. ${style}

Keep it to 1-2 short sentences. Never use "You should..." or "Don't forget..." - instead use phrases like "Just a soft reminder..." or "This came up again, in case now's better." Never shame or pressure.`;

  const taskPrompt = `Remind me about: ${task.content}`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Just a soft reminder about: ${task.content}`;
  }

  return content;
}

export function calculateNextNagDelay(
  naggingLevel: number,
  isImportant: boolean,
): number {
  // Base delays in minutes, escalating
  const baseDelays = [60, 120, 240, 360, 480]; // 1hr, 2hr, 4hr, 6hr, 8hr

  // For important tasks, nag more frequently
  const multiplier = isImportant ? 0.5 : 1;

  const delay = baseDelays[Math.min(naggingLevel, baseDelays.length - 1)];
  return Math.round(delay * multiplier);
}

export async function generateCheckinPrompt(
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a soft daily check-in. Ask the user to rate how their day felt on a scale of 1-5, with optional notes. Keep it warm and low-pressure. No exclamation points. Vary your wording to keep it fresh. Frame it as curiosity, not obligation.`;

  const taskPrompt = "Generate a daily check-in prompt.";

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Hey. Quick check-in if you want - on a scale of 1-5, how did today feel? Notes are optional.";
  }

  return content;
}

export async function generateEndOfDayMessage(
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a gentle end-of-day message. Ask if there's anything the user wants to remember for tomorrow - a thought, a task, anything on their mind. Keep it warm and cozy. Keep it to 2-3 sentences. Vary your wording to keep it fresh.`;

  const taskPrompt = "Generate an end-of-day message.";

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Hey, before you drift off - anything you want to remember for tomorrow? Sleep well.";
  }

  return content;
}

export interface MorningReviewData {
  inboxItems: { content: string }[];
  overdueTasks: { content: string; overdueTime: string }[];
  todaysTasks?: { content: string; scheduledTime: string }[];
}

export async function generateMorningReviewMessage(
  data: MorningReviewData,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const hasInbox = data.inboxItems.length > 0;
  const hasOverdue = data.overdueTasks.length > 0;
  const hasTodaysTasks = (data.todaysTasks?.length ?? 0) > 0;

  // Build the data section for the prompt
  let dataSection = "";

  // Today's tasks get priority - these are reminders scheduled for today
  if (hasTodaysTasks) {
    const todayList = data
      .todaysTasks!.map((t) => `- ${t.content} (${t.scheduledTime})`)
      .join("\n");
    dataSection += `Reminders for today (${data.todaysTasks!.length}):\n${todayList}\n\n`;
  }

  if (hasInbox) {
    const inboxList = data.inboxItems.map((i) => `- ${i.content}`).join("\n");
    dataSection += `Inbox items (${data.inboxItems.length}):\n${inboxList}\n\n`;
  }

  if (hasOverdue) {
    const overdueList = data.overdueTasks
      .map((t) => `- ${t.content} (${t.overdueTime})`)
      .join("\n");
    dataSection += `Overdue reminders (${data.overdueTasks.length}):\n${overdueList}`;
  }

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a gentle morning review message. This is a daily invitation for the user to look at their items. The goal is to help them:
- See today's reminders (these are things scheduled for today with specific times or just for this day)
- Maybe schedule some inbox items (turn them into reminders with specific times or days)
- Decide what to do with overdue items: reschedule them, mark them done, or drop them entirely

Keep it warm and low-pressure. This is an invitation, not a demand. Frame it as "in case you want to" or "whenever you're ready." List the items clearly so they can see what's there. Dropping items is always a valid choice. Keep your intro/outro brief, but do show the full lists. Group items by the list they belong to so it's easy for the user to scan.`;

  const hasAnyItems = hasTodaysTasks || hasInbox || hasOverdue;
  const taskPrompt = hasAnyItems
    ? `Generate a morning review message with the following items:\n\n${dataSection}`
    : "Generate a brief morning greeting. There are no inbox items or overdue tasks right now.";

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    // Fallback message
    if (!hasInbox && !hasOverdue) {
      return "Morning. Your inbox is clear and nothing's overdue. Fresh start today.";
    }
    let fallback = "Morning. Here's what's floating around:\n\n";
    if (hasInbox) {
      fallback += `Inbox:\n${data.inboxItems.map((i) => `- ${i.content}`).join("\n")}\n\n`;
    }
    if (hasOverdue) {
      fallback += `Overdue:\n${data.overdueTasks.map((t) => `- ${t.content}`).join("\n")}\n\n`;
    }
    fallback += "No pressure, just here if you want to sort through any of it.";
    return fallback;
  }

  return content;
}

export async function generateWeeklyInsights(
  checkIns: CheckIn[],
  dumps: BrainDump[],
  completedTaskCount: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const checkInsText =
    checkIns.length > 0
      ? checkIns
          .map((c) => {
            const dayName = new Date(c.date).toLocaleDateString("en-US", {
              weekday: "long",
            });
            const notesStr = c.notes ? ` - "${c.notes}"` : "";
            return `- ${dayName}: ${c.rating}/5${notesStr}`;
          })
          .join("\n")
      : "No check-ins this week.";

  const avgRating =
    checkIns.length > 0
      ? (
          checkIns.reduce((sum, c) => sum + c.rating, 0) / checkIns.length
        ).toFixed(1)
      : "N/A";

  const dumpsText =
    dumps.length > 0
      ? dumps.map((d) => `- ${d.content}`).join("\n")
      : "No brain dumps this week.";

  const systemPrompt = `${TAMA_PERSONALITY}

Create a gentle weekly reflection. Notice patterns (which days felt better/harder, any themes) without judgment. If you offer suggestions, frame them as options, not directives - "maybe," "you could try," "if it helps." Never imply the user should have done more. Treat all outcomes as neutral data. Keep it warm and concise.`;

  const taskPrompt = `Here's my week:

Daily check-ins (1-5 rating):
${checkInsText}

Average rating: ${avgRating}
Tasks completed: ${completedTaskCount}
Brain dumps captured: ${dumps.length}

${dumps.length > 0 ? `Brain dump topics:\n${dumpsText}` : ""}

Please share any patterns you notice, gently.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Weekly Summary\n\nCheck-ins: ${checkIns.length}/7 days\nAverage rating: ${avgRating}\nTasks completed: ${completedTaskCount}`;
  }

  return `Weekly Summary\n\n${content}`;
}

// ==========================================
// V2: Block Notification Messages
// ==========================================

export interface BlockStartData {
  blockName: string;
  timeRange: string;
  energyProfile: string;
  tasks: Array<{ content: string; energy?: string }>;
}

export async function generateBlockStartMessage(
  data: BlockStartData,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const taskList = data.tasks.length > 0
    ? data.tasks.map((t) => `- ${t.content}${t.energy ? ` (${t.energy} energy)` : ""}`).join("\n")
    : "No tasks slotted yet";

  const systemPrompt = `${TAMA_PERSONALITY}

Announce a time block starting. Be brief and encouraging. Mention what tasks are lined up if any. Don't pressure - just inform.`;

  const userPrompt = `${data.blockName} is starting (${data.timeRange}). Energy profile: ${data.energyProfile}.

Tasks slotted for this block:
${taskList}

Give a brief, warm announcement.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 300,
    messages: buildContextMessages(systemPrompt, userPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `${data.blockName} starting 🐾\n\n${data.tasks.length > 0 ? `Slotted:\n${taskList}` : "Nothing specific slotted - take it easy."}`;
  }

  return content;
}

export interface BlockEndData {
  blockName: string;
  completedTasks: string[];
  remainingTasks: string[];
  nextBlockName?: string;
}

export async function generateBlockEndMessage(
  data: BlockEndData,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

A time block is ending. Briefly acknowledge any wins. If there are remaining tasks, mention they'll carry forward - no judgment. If there's a next block, mention it casually.`;

  const completedText = data.completedTasks.length > 0
    ? `Completed: ${data.completedTasks.join(", ")}`
    : "Nothing checked off, and that's okay";

  const remainingText = data.remainingTasks.length > 0
    ? `Still pending: ${data.remainingTasks.join(", ")}`
    : "";

  const nextBlockText = data.nextBlockName
    ? `Next up: ${data.nextBlockName}`
    : "";

  const userPrompt = `${data.blockName} is wrapping up.

${completedText}
${remainingText}
${nextBlockText}

Give a brief transition message.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 250,
    messages: buildContextMessages(systemPrompt, userPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    let message = `${data.blockName} wrapping up 🐾`;
    if (data.completedTasks.length > 0) {
      message += `\n\nNice work on: ${data.completedTasks.join(", ")}`;
    }
    if (data.nextBlockName) {
      message += `\n\n${data.nextBlockName} next.`;
    }
    return message;
  }

  return content;
}

export async function generateEnergyCheckMessage(
  currentBlockName?: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Ask for a quick energy check (1-5 scale). Keep it very brief and casual. If they're in a block, mention it. Don't explain the scale - they know it.`;

  const userPrompt = currentBlockName
    ? `Mid-${currentBlockName} energy check time. Ask casually for 1-5.`
    : `Time for a quick energy check. Ask casually for 1-5.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 100,
    messages: buildContextMessages(systemPrompt, userPrompt, context),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return currentBlockName
      ? `Quick check - how's your energy? (1-5) 🐾`
      : `Energy check? (1-5) 🐾`;
  }

  return content;
}

// Action types for generating dynamic responses
export type ActionContext =
  | {
      type: "reminder_created";
      task: string;
      timeStr: string;
      isImportant: boolean;
      isDayOnly?: boolean;
    }
  | {
      type: "multiple_reminders_created";
      reminders: {
        task: string;
        timeStr: string;
        isImportant: boolean;
        isDayOnly?: boolean;
      }[];
    }
  | { type: "brain_dump_saved"; content: string }
  | {
      type: "inbox_item_added";
      item: string;
      inboxCount: number;
      dayTag?: string;
    }
  | { type: "task_completed"; task: string }
  | { type: "task_cancelled"; task: string }
  | { type: "multiple_tasks_cancelled"; tasks: string[] }
  | {
      type: "task_list";
      tasks: {
        content: string;
        scheduledFor: string;
        isImportant: boolean;
        isOverdue: boolean;
      }[];
    }
  | { type: "no_tasks" }
  | { type: "task_not_found"; action: "done" | "cancel" }
  | { type: "checkin_logged"; rating: number; hasNotes: boolean }
  | { type: "checkin_time_set"; timeStr: string }
  | { type: "morning_review_time_set"; timeStr: string }
  | {
      type: "reminder_with_list_created";
      task: string;
      timeStr: string;
      listName: string;
      itemCount: number;
      isImportant: boolean;
      isDayOnly?: boolean;
    }
  | { type: "list_created"; name: string; itemCount: number }
  | {
      type: "lists_shown";
      lists: {
        name: string;
        itemCount: number;
        checkedCount: number;
        hasReminder: boolean;
      }[];
    }
  | {
      type: "list_shown";
      name: string;
      items: { content: string; isChecked: boolean }[];
      linkedTaskContent?: string;
      linkedTaskTimeStr?: string;
    }
  | { type: "no_lists" }
  | { type: "list_not_found" }
  | {
      type: "list_modified";
      name: string;
      action: string;
      items?: string[];
      newName?: string;
    }
  | { type: "list_deleted"; name: string }
  | { type: "task_completed_with_list"; task: string; listName: string }
  | {
      type: "multiple_lists_shown";
      lists: Array<{
        name: string;
        items: { content: string; isChecked: boolean }[];
      }>;
    }
  | {
      type: "multiple_lists_modified";
      modifications: Array<{
        listName: string;
        action: "add_items" | "remove_items" | "check_items" | "uncheck_items";
        items: string[];
      }>;
    }
  | { type: "conversation"; message: string }
  // V2 Action Contexts
  | { type: "energy_logged"; level: 1 | 2 | 3 | 4 | 5; context?: string }
  | { type: "low_energy_mode_set"; enabled: boolean }
  | {
      type: "energy_patterns_shown";
      patterns: {
        bestHours: string[];
        bestDays: string[];
        dataPoints: number;
      };
    }
  | { type: "no_energy_data" }
  | {
      type: "blocks_shown";
      blocks: Array<{
        name: string;
        timeRange: string;
        days: string;
        energyProfile: string;
      }>;
    }
  | {
      type: "block_shown";
      name: string;
      timeRange: string;
      tasks: string[];
      energyProfile: string;
    }
  | { type: "no_blocks" }
  | { type: "vacation_mode_set"; enabled: boolean; until?: string }
  // Capture action contexts
  | {
      type: "tasks_extracted";
      capturedItemId: string;
      tasks: Array<{
        content: string;
        energy?: string;
        tags?: string[];
      }>;
    }
  | { type: "no_tasks_extracted"; rawContent: string }
  | {
      type: "tasks_confirmed";
      count: number;
      tasks: string[];
    }
  | { type: "extraction_cancelled" };

export async function generateActionResponse(
  actionContext: ActionContext,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  let prompt: string;

  switch (actionContext.type) {
    case "reminder_created":
      // timeStr is already formatted with "in X" for timed or "on Tuesday" for day-only
      prompt = `The user just set a reminder for "${actionContext.task}" ${actionContext.timeStr}.${actionContext.isImportant ? " They marked it as important, so I'll nag them until it's done." : ""}${actionContext.isDayOnly ? " This is a day-only reminder (no specific time) - it will appear in their morning review." : ""} Acknowledge this warmly and briefly.`;
      break;
    case "multiple_reminders_created":
      const reminderList = actionContext.reminders
        .map(
          (r) =>
            `- "${r.task}" ${r.timeStr}${r.isImportant ? " (important)" : ""}${r.isDayOnly ? " (day-only)" : ""}`,
        )
        .join("\n");
      prompt = `The user just created ${actionContext.reminders.length} reminders:\n${reminderList}\nAcknowledge this briefly - confirm they're set.`;
      break;
    case "brain_dump_saved":
      prompt = `The user just captured a thought/brain dump: "${actionContext.content}". Acknowledge that it's been saved and they'll see it in their daily summary. Keep it very brief.`;
      break;
    case "inbox_item_added":
      if (actionContext.dayTag) {
        prompt = `The user mentioned something they need to do: "${actionContext.item}" tagged for ${actionContext.dayTag}. It's been added to their Inbox with @${actionContext.dayTag} tag and will appear in their morning review on that day. Acknowledge very briefly.`;
      } else {
        prompt = `The user mentioned something they need to do: "${actionContext.item}". It's been added to their Inbox (${actionContext.inboxCount} item${actionContext.inboxCount === 1 ? "" : "s"} total). Acknowledge very briefly - just confirm it's in the inbox.`;
      }
      break;
    case "task_completed":
      prompt = `The user just marked "${actionContext.task}" as done. Give them a calm, proportional acknowledgment.`;
      break;
    case "task_cancelled":
      prompt = `The user just cancelled the task "${actionContext.task}". Acknowledge neutrally.`;
      break;
    case "multiple_tasks_cancelled": {
      const cancelledTaskList = actionContext.tasks.map((t) => `- "${t}"`).join("\n");
      prompt = `The user just cancelled ${actionContext.tasks.length} tasks:\n${cancelledTaskList}\nAcknowledge neutrally - it's okay to change priorities.`;
      break;
    }
    case "task_list":
      const formattedTasks = actionContext.tasks
        .map(
          (t, i) =>
            `${i + 1}. ${t.content} ${t.scheduledFor}${t.isImportant ? " (important)" : ""}${t.isOverdue ? " (overdue)" : ""}`,
        )
        .join("\n");
      prompt = `Show the user their scheduled reminders in a clear format. Here are the reminders:\n${formattedTasks}\n\nPresent this list clearly with the @day time format. You can add a brief, warm intro or outro but keep it minimal.`;
      break;
    case "no_tasks":
      prompt = `The user has no pending tasks or reminders. Let them know in a warm way.`;
      break;
    case "task_not_found":
      prompt = `The user tried to mark a task as ${actionContext.action === "done" ? "done" : "cancelled"}, but I couldn't find a matching pending task. Gently let them know.`;
      break;
    case "checkin_logged":
      prompt = `The user just completed their daily check-in with a rating of ${actionContext.rating}/5.${actionContext.hasNotes ? " They also included some notes." : ""} Respond appropriately to their rating.`;
      break;
    case "checkin_time_set":
      prompt = `The user just set their daily check-in time to ${actionContext.timeStr}. They'll also get a daily summary and weekly summary on Sundays at this time. Confirm this briefly.`;
      break;
    case "morning_review_time_set":
      prompt = `The user just set their morning review time to ${actionContext.timeStr}. This is when they'll get a daily summary of their inbox items and any overdue tasks. Confirm this briefly.`;
      break;
    case "reminder_with_list_created":
      // timeStr is already formatted with "in X" for timed or "on Tuesday" for day-only
      prompt = `The user just set a reminder for "${actionContext.task}" ${actionContext.timeStr}, with a linked list called "${actionContext.listName}" containing ${actionContext.itemCount} items.${actionContext.isImportant ? " They marked it as important." : ""}${actionContext.isDayOnly ? " This is a day-only reminder (no specific time)." : ""} Acknowledge warmly - mention both the reminder and that you're keeping track of the list items.`;
      break;
    case "list_created":
      prompt = `The user just created a list called "${actionContext.name}" with ${actionContext.itemCount} items. Acknowledge briefly that the list is saved.`;
      break;
    case "lists_shown": {
      const listSummaries = actionContext.lists
        .map((l) => `- ${l.name} - ${l.itemCount}`)
        .join("\n");
      prompt = `Show the user their lists in this exact format (name - count):\n${listSummaries}\n\nJust add a brief intro, then list them exactly as shown above. Keep it minimal.`;
      break;
    }
    case "list_shown": {
      const itemsList = actionContext.items
        .map((i) => `- [${i.isChecked ? "x" : " "}] ${i.content}`)
        .join("\n");
      const reminderInfo = actionContext.linkedTaskContent
        ? `\nThis list is linked to a reminder: "${actionContext.linkedTaskContent}" (${actionContext.linkedTaskTimeStr})`
        : "";
      prompt = `Show the user their "${actionContext.name}" list:\n${itemsList}${reminderInfo}\n\nPresent this clearly.`;
      break;
    }
    case "multiple_lists_shown": {
      const allLists = actionContext.lists
        .map((list) => {
          const items = list.items
            .map((i) => `  - [${i.isChecked ? "x" : " "}] ${i.content}`)
            .join("\n");
          return `**${list.name}**:\n${items}`;
        })
        .join("\n\n");
      prompt = `Show the user the contents of ${actionContext.lists.length} lists:\n\n${allLists}\n\nPresent these lists clearly with the names as headers.`;
      break;
    }
    case "no_lists":
      prompt = `The user has no lists yet. Let them know warmly.`;
      break;
    case "list_not_found":
      prompt = `The user tried to access a list but I couldn't find a matching one. Gently let them know.`;
      break;
    case "list_modified": {
      const itemsStr = actionContext.items?.join(", ") || "";
      if (actionContext.action === "add_items") {
        prompt = `Added ${itemsStr} to the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "remove_items") {
        prompt = `Removed ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "check_items") {
        prompt = `Checked off ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "uncheck_items") {
        prompt = `Unchecked ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "rename") {
        prompt = `Renamed the list from "${actionContext.name}" to "${actionContext.newName}". Acknowledge briefly.`;
      } else {
        prompt = `Modified the "${actionContext.name}" list. Acknowledge briefly.`;
      }
      break;
    }
    case "multiple_lists_modified": {
      const actionDescriptions: Record<string, string> = {
        add_items: "added",
        remove_items: "removed",
        check_items: "checked off",
        uncheck_items: "unchecked",
      };
      const modificationsSummary = actionContext.modifications
        .map(
          (m) =>
            `${actionDescriptions[m.action]} ${m.items.join(", ")} from "${m.listName}"`,
        )
        .join("; ");
      prompt = `Made multiple list changes: ${modificationsSummary}. Acknowledge briefly in one response.`;
      break;
    }
    case "list_deleted":
      prompt = `The user deleted the "${actionContext.name}" list. Acknowledge neutrally.`;
      break;
    case "conversation":
      prompt = `The user said: "${actionContext.message}"\n\nRespond naturally to them.`;
      break;
    case "task_completed_with_list":
      prompt = `The user just completed "${actionContext.task}" which had a linked list "${actionContext.listName}". Both the task and list are now done. Give a calm acknowledgment.`;
      break;
    // V2 cases
    case "energy_logged":
      const energyDescriptions = ["exhausted", "low", "okay", "good", "energized"];
      prompt = `The user logged their energy as ${actionContext.level}/5 (${energyDescriptions[actionContext.level - 1]})${actionContext.context ? ` with context: "${actionContext.context}"` : ""}. Acknowledge briefly and maybe offer a relevant suggestion based on their energy level.`;
      break;
    case "low_energy_mode_set":
      prompt = actionContext.enabled
        ? `The user turned on low-energy mode. They're running low. Acknowledge warmly and let them know I'll only suggest easier tasks.`
        : `The user turned off low-energy mode - they're feeling better. Acknowledge positively.`;
      break;
    case "energy_patterns_shown":
      if (actionContext.patterns.dataPoints < 7) {
        prompt = `The user asked about their energy patterns but we only have ${actionContext.patterns.dataPoints} data points so far. Let them know we're still learning their patterns and to keep logging energy.`;
      } else {
        prompt = `The user's energy patterns: Best hours are around ${actionContext.patterns.bestHours.join(", ")}. Best days tend to be ${actionContext.patterns.bestDays.join(", ")}. Based on ${actionContext.patterns.dataPoints} data points. Summarize this helpfully.`;
      }
      break;
    case "no_energy_data":
      prompt = `The user asked about energy patterns but we don't have any data yet. Encourage them to log their energy throughout the day so we can learn their patterns.`;
      break;
    case "blocks_shown":
      const blockList = actionContext.blocks
        .map((b) => `- ${b.name}: ${b.timeRange} (${b.days}) - ${b.energyProfile} energy`)
        .join("\n");
      prompt = `The user's activity blocks:\n${blockList}\n\nShow these in a friendly, readable format.`;
      break;
    case "block_shown": {
      const blockTaskList = actionContext.tasks.length > 0
        ? `Tasks: ${actionContext.tasks.join(", ")}`
        : "No tasks assigned yet";
      prompt = `Showing the "${actionContext.name}" block (${actionContext.timeRange}, ${actionContext.energyProfile} energy). ${blockTaskList}. Present this clearly.`;
      break;
    }
    case "no_blocks":
      prompt = `The user doesn't have any activity blocks set up yet. Offer to help them set up their daily blocks.`;
      break;
    case "vacation_mode_set":
      prompt = actionContext.enabled
        ? `The user turned on vacation mode${actionContext.until ? ` until ${actionContext.until}` : ""}. Block notifications are paused. Wish them a good break!`
        : `The user turned off vacation mode - they're back! Welcome them back warmly.`;
      break;
    // Capture action contexts
    case "tasks_extracted": {
      const extractedList = actionContext.tasks
        .map((t, i) => {
          const tagStr = t.tags?.join(", ") || "";
          return `${i + 1}. ${t.content}${tagStr ? ` (${tagStr})` : ""}${t.energy ? ` - ${t.energy} energy` : ""}`;
        })
        .join("\n");
      prompt = `I extracted these potential tasks from what the user said:\n\n${extractedList}\n\nPresent these to the user warmly and ask if they look right. They can say "yes" to add all, mention specific numbers, or clarify/correct any.`;
      break;
    }
    case "no_tasks_extracted":
      prompt = `The user said: "${actionContext.rawContent}" but I couldn't identify any clear tasks. Ask them warmly to tell me more specifically what they need to do.`;
      break;
    case "tasks_confirmed": {
      const confirmedList = actionContext.tasks.map((t) => `- ${t}`).join("\n");
      prompt = `Great! The user confirmed ${actionContext.count} task(s):\n${confirmedList}\n\nAcknowledge that these have been added. Be warm but brief.`;
      break;
    }
    case "extraction_cancelled":
      prompt = `The user decided not to add the extracted tasks. Acknowledge this casually - it's totally fine to change their mind.`;
      break;
  }

  // For conversations, don't constrain response length - let the model respond naturally
  // For action acknowledgments, keep it brief
  const isConversation = actionContext.type === "conversation";

  const systemPrompt = isConversation
    ? `${TAMA_PERSONALITY}

Have a natural conversation with the user. Respond as you would to a friend - no length constraints.`
    : `${TAMA_PERSONALITY}

Generate a response to acknowledge an action. Be warm but brief. For task lists, you may format with bullet points or numbers.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: isConversation ? 2000 : 500,
    messages: buildContextMessages(systemPrompt, prompt, conversationContext),
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    // Fallbacks for each type
    switch (actionContext.type) {
      case "reminder_created":
        // timeStr already contains "in X" or "on Tuesday"
        return `Got it, I'll remind you about ${actionContext.task} ${actionContext.timeStr}.`;
      case "multiple_reminders_created":
        return `Set ${actionContext.reminders.length} reminders for you.`;
      case "brain_dump_saved":
        return `Captured that thought.`;
      case "inbox_item_added":
        return `Added to your inbox.`;
      case "task_completed":
        return `Marked ${actionContext.task} as done.`;
      case "task_cancelled":
        return `Cancelled ${actionContext.task}.`;
      case "multiple_tasks_cancelled":
        return `Cancelled ${actionContext.tasks.length} tasks.`;
      case "task_list":
        return actionContext.tasks
          .map(
            (t, i) =>
              `${i + 1}. ${t.content} ${t.scheduledFor}${t.isOverdue ? " (overdue)" : ""}`,
          )
          .join("\n");
      case "no_tasks":
        return `You have no pending tasks.`;
      case "task_not_found":
        return `Couldn't find a matching task. Say "list tasks" to see what's pending.`;
      case "checkin_logged":
        return `Logged your check-in: ${actionContext.rating}/5.`;
      case "checkin_time_set":
        return `Check-in time set to ${actionContext.timeStr}.`;
      case "morning_review_time_set":
        return `Morning review time set to ${actionContext.timeStr}.`;
      case "reminder_with_list_created":
        // timeStr already contains "in X" or "on Tuesday"
        return `Got it, I'll remind you about ${actionContext.task} ${actionContext.timeStr}. Keeping track of ${actionContext.itemCount} items on your ${actionContext.listName} list.`;
      case "list_created":
        return `Created your ${actionContext.name} list with ${actionContext.itemCount} items.`;
      case "lists_shown":
        return actionContext.lists
          .map((l) => `- ${l.name} - ${l.itemCount}`)
          .join("\n");
      case "list_shown":
        return `${actionContext.name}:\n${actionContext.items.map((i) => `${i.isChecked ? "✓" : "○"} ${i.content}`).join("\n")}`;
      case "multiple_lists_shown":
        return actionContext.lists
          .map(
            (list) =>
              `${list.name}:\n${list.items.map((i) => `${i.isChecked ? "✓" : "○"} ${i.content}`).join("\n")}`,
          )
          .join("\n\n");
      case "no_lists":
        return `You don't have any lists yet.`;
      case "list_not_found":
        return `Couldn't find that list. Say "show my lists" to see what's available.`;
      case "list_modified":
        return `Updated your ${actionContext.name} list.`;
      case "multiple_lists_modified":
        return `Updated ${actionContext.modifications.length} lists.`;
      case "list_deleted":
        return `Deleted the ${actionContext.name} list.`;
      case "conversation":
        return `Hey there! I can help with reminders, hold onto thoughts, or keep track of lists. What would you like to do?`;
      case "task_completed_with_list":
        return `Done with ${actionContext.task} and checked off the ${actionContext.listName} list.`;
      // V2 fallbacks
      case "energy_logged":
        return `Logged your energy as ${actionContext.level}/5.`;
      case "low_energy_mode_set":
        return actionContext.enabled
          ? `Low-energy mode is on. I'll suggest easier tasks.`
          : `Low-energy mode is off.`;
      case "energy_patterns_shown":
        return `Your best hours: ${actionContext.patterns.bestHours.join(", ")}. Best days: ${actionContext.patterns.bestDays.join(", ")}.`;
      case "no_energy_data":
        return `No energy data yet. Try logging your energy throughout the day!`;
      case "blocks_shown":
        return actionContext.blocks
          .map((b) => `- ${b.name}: ${b.timeRange} (${b.days})`)
          .join("\n");
      case "block_shown":
        return `${actionContext.name} (${actionContext.timeRange}): ${actionContext.tasks.length > 0 ? actionContext.tasks.join(", ") : "No tasks yet"}`;
      case "no_blocks":
        return `You don't have any activity blocks set up yet.`;
      case "vacation_mode_set":
        return actionContext.enabled
          ? `Vacation mode on${actionContext.until ? ` until ${actionContext.until}` : ""}. Block notifications paused.`
          : `Welcome back! Vacation mode is off.`;
      // Capture fallbacks
      case "tasks_extracted":
        return `Found ${actionContext.tasks.length} potential task(s):\n${actionContext.tasks.map((t, i) => `${i + 1}. ${t.content}`).join("\n")}\n\nLook right?`;
      case "no_tasks_extracted":
        return `Hmm, I couldn't find any clear tasks in there. What specifically do you need to do?`;
      case "tasks_confirmed":
        return `Added ${actionContext.count} task(s) 🐾`;
      case "extraction_cancelled":
        return `No worries, dropped those.`;
    }
  }

  return content;
}

export async function generateConversationSummary(
  messages: {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }[],
  existingSummary?: string,
): Promise<string> {
  const client = getClient();

  // Format messages for the summary prompt
  const formattedMessages = messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `[${time}] ${m.role === "user" ? "User" : "Tama"}: ${m.content}`;
    })
    .join("\n");

  const summaryContext = existingSummary
    ? `EXISTING CONTEXT SUMMARY (from earlier conversation):\n${existingSummary}\n\n---\n\nNEWER MESSAGES TO INCORPORATE (weight these more heavily as they are more recent):\n${formattedMessages}`
    : `MESSAGES TO SUMMARIZE:\n${formattedMessages}`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You are summarizing a conversation between a user with ADHD and their support companion Tama. Create a concise summary that captures:

1. Key topics discussed
2. Any tasks, reminders, or commitments mentioned
3. Emotional context or state the user expressed
4. Any preferences or patterns noticed

Keep the summary factual and concise (2-4 sentences). This summary will be used as context for future conversations, so focus on information that would be helpful to remember.

${existingSummary ? "IMPORTANT: An existing summary from earlier in the conversation is provided. Incorporate that context but weight the newer messages more heavily since they contain more recent information. Create a unified summary that blends both." : ""}`,
      },
      {
        role: "user",
        content: summaryContext,
      },
    ],
    ...getChatParams(),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    // Fallback to a basic summary if LLM fails
    return existingSummary || "Previous conversation context unavailable.";
  }

  return content;
}

// ==========================================
// V2: Task Extraction from Unstructured Input
// ==========================================

const TASK_EXTRACTION_PROMPT = `You are an expert at identifying actionable tasks from messy, unstructured text. Your job is to extract potential tasks from a user's brain dump or rambling thoughts.

For each task you identify:
1. Extract a clear, actionable task description
2. Suggest an energy level required (high/medium/low)
3. Suggest context tags that apply (@home, @computer, @phone, @errands, @work, @anywhere)
4. If it's a complex task, suggest 2-3 subtasks to break it down
5. Assign a confidence score (0-1) based on how clearly it's a task

Guidelines:
- Look for action verbs (call, email, buy, fix, schedule, etc.)
- Obligations and commitments ("need to", "should", "have to", "gotta")
- Time-sensitive mentions ("by Friday", "next week", "soon")
- People to contact or follow up with
- Items to purchase or errands to run
- Appointments or events to schedule

Energy level hints:
- HIGH: Requires focus, creativity, difficult conversations, complex problem-solving
- MEDIUM: Routine work, phone calls, emails, errands
- LOW: Simple tasks, quick wins, mindless organization

Context tag hints:
- @home: Chores, home repairs, personal tasks at home
- @computer: Digital work, emails, online tasks
- @phone: Calls, texts, mobile tasks
- @errands: Shopping, pickups, visits, anything requiring travel
- @work: Professional tasks, work-related
- @anywhere: Can be done from anywhere

Output format: Return a JSON array of extracted tasks. If no tasks are found, return an empty array.

Example input: "ugh need to call the vet about Luna, also mom's birthday next week and the sink is still dripping"

Example output:
[
  {
    "content": "Call vet about Luna",
    "suggestedEnergyLevel": "medium",
    "suggestedContextTags": ["@phone"],
    "suggestedDecomposition": null,
    "confidence": 0.95
  },
  {
    "content": "Get birthday card/gift for mom",
    "suggestedEnergyLevel": "low",
    "suggestedContextTags": ["@errands"],
    "suggestedDecomposition": ["Pick out card", "Choose gift", "Mail or deliver by birthday"],
    "confidence": 0.85
  },
  {
    "content": "Fix leaking sink or call plumber",
    "suggestedEnergyLevel": "medium",
    "suggestedContextTags": ["@home", "@phone"],
    "suggestedDecomposition": ["Diagnose the leak", "Decide: DIY or professional", "Get supplies or schedule plumber"],
    "confidence": 0.8
  }
]`;

export interface TaskExtractionResult {
  tasks: ExtractedTask[];
  rawContent: string;
}

export async function extractTasksFromText(
  rawContent: string,
): Promise<TaskExtractionResult> {
  const client = getClient();

  const response = await client.chat.completions.create({
    model: getIntentModel(),
    max_tokens: 2000,
    messages: [
      {
        role: "system",
        content: TASK_EXTRACTION_PROMPT,
      },
      {
        role: "user",
        content: rawContent,
      },
    ],
    response_format: { type: "json_object" },
    ...getIntentParams(),
  });

  const extractedContent = response.choices[0]?.message?.content;
  if (!extractedContent) {
    return { tasks: [], rawContent };
  }

  try {
    const parsed = JSON.parse(extractedContent);

    // Handle both array and object with tasks property
    const tasksArray = Array.isArray(parsed) ? parsed : (parsed.tasks || []);

    // Validate and normalize the extracted tasks
    const tasks: ExtractedTask[] = tasksArray
      .filter((t: unknown): t is Record<string, unknown> =>
        typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).content === "string"
      )
      .map((t: Record<string, unknown>) => ({
        content: String(t.content),
        suggestedEnergyLevel: validateEnergyLevel(t.suggestedEnergyLevel),
        suggestedContextTags: Array.isArray(t.suggestedContextTags)
          ? t.suggestedContextTags.filter((tag): tag is string => typeof tag === "string")
          : undefined,
        suggestedDecomposition: Array.isArray(t.suggestedDecomposition)
          ? t.suggestedDecomposition.filter((s): s is string => typeof s === "string")
          : undefined,
        confidence: typeof t.confidence === "number" ? t.confidence : 0.5,
      }));

    return { tasks, rawContent };
  } catch (error) {
    console.error("Failed to parse task extraction response:", error);
    return { tasks: [], rawContent };
  }
}

function validateEnergyLevel(level: unknown): EnergyLevel | undefined {
  if (level === "high" || level === "medium" || level === "low") {
    return level;
  }
  return undefined;
}

// Generate a response for showing extracted tasks to user for confirmation
export async function generateExtractionResponse(
  tasks: ExtractedTask[],
  context: ConversationContext,
): Promise<string> {
  const client = getClient();

  if (tasks.length === 0) {
    return await generateActionResponse(
      { type: "conversation", message: "I couldn't find any clear tasks in there. Want to tell me more specifically what you need to do?" },
      context,
    );
  }

  // Build a summary of extracted tasks
  const taskSummary = tasks
    .map((t, i) => {
      const tags = t.suggestedContextTags?.join(", ") || "";
      const energy = t.suggestedEnergyLevel || "?";
      return `${i + 1}. ${t.content}${tags ? ` (${tags})` : ""} - ${energy} energy`;
    })
    .join("\n");

  const systemPrompt = `${TAMA_PERSONALITY}

The user just dumped some thoughts and you extracted potential tasks from them. Present these extracted tasks to the user for confirmation. Be warm and casual. Ask if these look right and if they want to add them.`;

  const prompt = `I found these potential tasks:\n\n${taskSummary}\n\nAsk the user if these look right. They can say "yes" to add all, mention specific numbers to add just those, or clarify/correct any of them.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    ...getChatParams(),
  });

  const responseContent = response.choices[0]?.message?.content;
  if (!responseContent) {
    // Fallback
    return `Caught that 🐾\n\nFound a few things:\n${taskSummary}\n\nThese look right?`;
  }

  return responseContent;
}
