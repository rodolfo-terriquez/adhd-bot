/**
 * Tool definitions and executors for the agentic loop.
 * Each tool wraps existing Redis/QStash operations.
 */

import type { ToolDefinition, DayOfWeek } from "./types.js";
import * as redis from "./redis.js";
import { scheduleReminder, cancelScheduledMessage } from "./qstash.js";

// Get user's timezone from env
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

// Helper to get current time context
function getCurrentTimeContext(): string {
  const now = new Date();
  const timezone = getUserTimezone();
  return now.toLocaleString("en-US", {
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
}

// ==========================================
// Tool Definitions (OpenAI function calling format)
// ==========================================

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // READ TOOLS
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "Get all pending reminders/tasks. Returns task ID, content, scheduled time, importance, and status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_reminders",
      description: "Search for reminders/tasks matching a description. Use this to find specific tasks before operating on them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term to match against task content" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lists",
      description: "Get all the user's lists (including Inbox). Returns list names, item counts, and whether they have linked reminders.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_list_items",
      description: "Get all items in a specific list by name.",
      parameters: {
        type: "object",
        properties: {
          list_name: { type: "string", description: "Name of the list to retrieve" },
        },
        required: ["list_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_habits",
      description: "Get all habits, their schedules, and today's completion status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_energy_patterns",
      description: "Get the user's energy patterns - when they tend to have high/low energy.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in the user's timezone.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  // WRITE TOOLS
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a new reminder/task that will notify the user at a specified time.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "What to remind the user about" },
          delay_minutes: { type: "number", description: "Minutes from now to send the reminder" },
          is_important: { type: "boolean", description: "If true, will nag repeatedly until acknowledged" },
          is_day_only: { type: "boolean", description: "If true, shows in morning review but doesn't send notification" },
        },
        required: ["content", "delay_minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_reminder",
      description: "Mark a reminder/task as complete by its ID.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID of the task to complete" },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Cancel/delete a reminder by its ID.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID of the task to cancel" },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_inbox",
      description: "Add an item to the user's Inbox (for things without a specific time).",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "Content to add to inbox" },
          day_tag: { type: "string", description: "Optional day to associate (monday, tuesday, etc.)" },
        },
        required: ["item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_list",
      description: "Create a new list with optional initial items.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the list" },
          items: { type: "array", items: { type: "string" }, description: "Initial items to add to the list" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_list",
      description: "Add, remove, check, or uncheck items in a list.",
      parameters: {
        type: "object",
        properties: {
          list_name: { type: "string", description: "Name of the list to modify" },
          action: {
            type: "string",
            enum: ["add_items", "remove_items", "check_items", "uncheck_items"],
            description: "What operation to perform",
          },
          items: {
            type: "array",
            items: { type: "string" },
            description: "Items to add/remove/check/uncheck",
          },
        },
        required: ["list_name", "action", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_list",
      description: "Delete an entire list.",
      parameters: {
        type: "object",
        properties: {
          list_name: { type: "string", description: "Name of the list to delete" },
        },
        required: ["list_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_habit",
      description: "Create a recurring habit.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the habit" },
          days: {
            type: "string",
            description: "Schedule: 'daily', 'weekdays', 'weekends', or comma-separated days like 'monday,wednesday,friday'",
          },
          preferred_block: { type: "string", description: "Optional preferred time block (morning, afternoon, evening)" },
        },
        required: ["name", "days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_habit",
      description: "Mark a habit as completed for today.",
      parameters: {
        type: "object",
        properties: {
          habit_name: { type: "string", description: "Name of the habit to complete" },
        },
        required: ["habit_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_habit",
      description: "Delete a habit.",
      parameters: {
        type: "object",
        properties: {
          habit_name: { type: "string", description: "Name of the habit to delete" },
        },
        required: ["habit_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_energy",
      description: "Log the user's current energy level.",
      parameters: {
        type: "object",
        properties: {
          level: { type: "number", description: "Energy 1-5 (1=exhausted, 5=energized)" },
          context: { type: "string", description: "Optional context about why" },
        },
        required: ["level"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_brain_dump",
      description: "Save a brain dump / note to self for later review.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The thought to capture" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_checkin",
      description: "Save a daily check-in response.",
      parameters: {
        type: "object",
        properties: {
          rating: { type: "number", description: "Rating 1-5" },
          notes: { type: "string", description: "Optional notes" },
        },
        required: ["rating"],
      },
    },
  },
];

// ==========================================
// Tool Executors
// ==========================================

type ToolExecutor = (chatId: number, input: Record<string, unknown>) => Promise<string>;

// Helper to parse days string into DayOfWeek array
function parseDaysString(days: string): DayOfWeek[] {
  const daysLower = days.toLowerCase().trim();

  if (daysLower === "daily") {
    return ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  }
  if (daysLower === "weekdays") {
    return ["monday", "tuesday", "wednesday", "thursday", "friday"];
  }
  if (daysLower === "weekends") {
    return ["saturday", "sunday"];
  }

  // Parse comma-separated days
  const validDays: DayOfWeek[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const parsedDays = daysLower.split(",").map(d => d.trim()) as DayOfWeek[];
  return parsedDays.filter(d => validDays.includes(d));
}

// Format days array for display
function formatDays(days: DayOfWeek[]): string {
  if (days.length === 7) return "daily";
  if (days.length === 5 && !days.includes("saturday") && !days.includes("sunday")) return "weekdays";
  if (days.length === 2 && days.includes("saturday") && days.includes("sunday")) return "weekends";
  return days.join(", ");
}

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  // READ TOOLS
  list_reminders: async (chatId) => {
    const tasks = await redis.getPendingTasks(chatId);
    if (tasks.length === 0) {
      return JSON.stringify({ tasks: [], message: "No pending reminders" });
    }
    return JSON.stringify({
      tasks: tasks.map(t => ({
        id: t.id,
        content: t.content,
        scheduledFor: formatTimestamp(t.nextReminder),
        isImportant: t.isImportant,
        isDayOnly: t.isDayOnly || false,
        isOverdue: t.nextReminder < Date.now(),
      })),
    });
  },

  search_reminders: async (chatId, input) => {
    const query = String(input.query || "").toLowerCase();
    const tasks = await redis.getPendingTasks(chatId);
    const matches = tasks.filter(t =>
      t.content.toLowerCase().includes(query) ||
      query.includes(t.content.toLowerCase())
    );

    if (matches.length === 0) {
      return JSON.stringify({ tasks: [], message: `No reminders matching "${query}"` });
    }

    return JSON.stringify({
      tasks: matches.map(t => ({
        id: t.id,
        content: t.content,
        scheduledFor: formatTimestamp(t.nextReminder),
        isImportant: t.isImportant,
        isDayOnly: t.isDayOnly || false,
      })),
    });
  },

  list_lists: async (chatId) => {
    const lists = await redis.getActiveLists(chatId);
    if (lists.length === 0) {
      return JSON.stringify({ lists: [], message: "No lists" });
    }
    return JSON.stringify({
      lists: lists.map(l => ({
        name: l.name,
        itemCount: l.items.length,
        checkedCount: l.items.filter(i => i.isChecked).length,
        hasLinkedReminder: !!l.linkedTaskId,
      })),
    });
  },

  get_list_items: async (chatId, input) => {
    const listName = String(input.list_name || "");
    const list = await redis.findListByDescription(chatId, listName);

    if (!list) {
      return JSON.stringify({ error: true, message: `List "${listName}" not found` });
    }

    return JSON.stringify({
      name: list.name,
      items: list.items.map(i => ({
        content: i.content,
        isChecked: i.isChecked,
      })),
    });
  },

  get_habits: async (chatId) => {
    const habits = await redis.getAllHabits(chatId);
    if (habits.length === 0) {
      return JSON.stringify({ habits: [], message: "No habits" });
    }

    const habitsWithStatus = await Promise.all(habits.map(async h => ({
      id: h.id,
      name: h.name,
      days: formatDays(h.days),
      status: h.status,
      completedToday: await redis.isHabitCompletedToday(chatId, h.id),
    })));

    return JSON.stringify({ habits: habitsWithStatus });
  },

  get_energy_patterns: async (chatId) => {
    const pattern = await redis.getEnergyPattern(chatId);

    if (pattern.dataPoints < 3) {
      return JSON.stringify({
        message: "Not enough data yet. Log energy throughout the day to learn patterns.",
        dataPoints: pattern.dataPoints,
      });
    }

    // Find best hours
    const hourlyEntries = Object.entries(pattern.hourlyAverages);
    const sortedHours = hourlyEntries.sort((a, b) => Number(b[1]) - Number(a[1]));
    const bestHours = sortedHours.slice(0, 3).map(([hour]) => {
      const h = parseInt(hour);
      return h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
    });

    // Find best days
    const dayEntries = Object.entries(pattern.dayOfWeekAverages);
    const sortedDays = dayEntries.sort((a, b) => Number(b[1]) - Number(a[1]));
    const bestDays = sortedDays.slice(0, 2).map(([day]) => day);

    return JSON.stringify({
      bestHours,
      bestDays,
      dataPoints: pattern.dataPoints,
    });
  },

  get_current_time: async () => {
    return JSON.stringify({
      currentTime: getCurrentTimeContext(),
      timezone: getUserTimezone(),
    });
  },

  // WRITE TOOLS
  create_reminder: async (chatId, input) => {
    const content = String(input.content);
    const delayMinutes = Number(input.delay_minutes);
    const isImportant = Boolean(input.is_important);
    const isDayOnly = Boolean(input.is_day_only);

    const task = await redis.createTask(chatId, content, isImportant, delayMinutes, isDayOnly);

    // Schedule QStash notification if not day-only
    if (!isDayOnly) {
      const messageId = await scheduleReminder(chatId, task.id, delayMinutes, false);
      task.qstashMessageId = messageId;
      await redis.updateTask(task);
    }

    return JSON.stringify({
      success: true,
      taskId: task.id,
      content: task.content,
      scheduledFor: formatTimestamp(task.nextReminder),
      isDayOnly,
    });
  },

  complete_reminder: async (chatId, input) => {
    const taskId = String(input.task_id);
    const task = await redis.getTask(chatId, taskId);

    if (!task) {
      return JSON.stringify({ error: true, message: "Task not found" });
    }

    // Cancel scheduled reminder if exists
    if (task.qstashMessageId) {
      await cancelScheduledMessage(task.qstashMessageId);
    }

    await redis.completeTask(chatId, taskId);

    return JSON.stringify({
      success: true,
      completedTask: task.content,
    });
  },

  cancel_reminder: async (chatId, input) => {
    const taskId = String(input.task_id);
    const task = await redis.getTask(chatId, taskId);

    if (!task) {
      return JSON.stringify({ error: true, message: "Task not found" });
    }

    // Cancel scheduled reminder if exists
    if (task.qstashMessageId) {
      await cancelScheduledMessage(task.qstashMessageId);
    }

    await redis.deleteTask(chatId, taskId);

    return JSON.stringify({
      success: true,
      cancelledTask: task.content,
    });
  },

  add_to_inbox: async (chatId, input) => {
    const item = String(input.item);
    const dayTag = input.day_tag ? String(input.day_tag) : undefined;

    const inbox = await redis.addToInbox(chatId, item, dayTag);

    return JSON.stringify({
      success: true,
      item,
      dayTag,
      inboxCount: inbox.items.length,
    });
  },

  create_list: async (chatId, input) => {
    const name = String(input.name);
    const items = Array.isArray(input.items) ? input.items.map(String) : [];

    const list = await redis.createList(chatId, name, items);

    return JSON.stringify({
      success: true,
      listName: list.name,
      itemCount: list.items.length,
    });
  },

  modify_list: async (chatId, input) => {
    const listName = String(input.list_name);
    const action = String(input.action);
    const items = Array.isArray(input.items) ? input.items.map(String) : [];

    const list = await redis.findListByDescription(chatId, listName);
    if (!list) {
      return JSON.stringify({ error: true, message: `List "${listName}" not found` });
    }

    let result;
    switch (action) {
      case "add_items":
        result = await redis.addListItems(chatId, list.id, items);
        return JSON.stringify({ success: true, listName: list.name, action: "added", items });

      case "remove_items":
        result = await redis.removeListItems(chatId, list.id, items);
        return JSON.stringify({
          success: true,
          listName: list.name,
          action: "removed",
          removedItems: result?.removedItems || [],
        });

      case "check_items":
        result = await redis.checkListItems(chatId, list.id, items, true);
        return JSON.stringify({
          success: true,
          listName: list.name,
          action: "checked",
          modifiedItems: result?.modifiedItems || [],
        });

      case "uncheck_items":
        result = await redis.checkListItems(chatId, list.id, items, false);
        return JSON.stringify({
          success: true,
          listName: list.name,
          action: "unchecked",
          modifiedItems: result?.modifiedItems || [],
        });

      default:
        return JSON.stringify({ error: true, message: `Unknown action: ${action}` });
    }
  },

  delete_list: async (chatId, input) => {
    const listName = String(input.list_name);
    const list = await redis.findListByDescription(chatId, listName);

    if (!list) {
      return JSON.stringify({ error: true, message: `List "${listName}" not found` });
    }

    await redis.deleteList(chatId, list.id);

    return JSON.stringify({
      success: true,
      deletedList: list.name,
    });
  },

  create_habit: async (chatId, input) => {
    const name = String(input.name);
    const daysString = String(input.days);
    const days = parseDaysString(daysString);

    if (days.length === 0) {
      return JSON.stringify({ error: true, message: "Invalid days format" });
    }

    // Find preferred block if specified
    let preferredBlockId: string | undefined;
    if (input.preferred_block) {
      const block = await redis.findBlockByName(chatId, String(input.preferred_block));
      if (block) {
        preferredBlockId = block.id;
      }
    }

    const habit = await redis.createHabit(chatId, name, days, preferredBlockId);

    return JSON.stringify({
      success: true,
      habitId: habit.id,
      name: habit.name,
      days: formatDays(habit.days),
    });
  },

  complete_habit: async (chatId, input) => {
    const habitName = String(input.habit_name);
    const habit = await redis.findHabitByName(chatId, habitName);

    if (!habit) {
      return JSON.stringify({ error: true, message: `Habit "${habitName}" not found` });
    }

    // Check if already completed today
    if (await redis.isHabitCompletedToday(chatId, habit.id)) {
      return JSON.stringify({
        success: false,
        message: `${habit.name} is already completed for today`,
      });
    }

    await redis.completeHabit(chatId, habit.id);

    // Get weekly count
    const completions = await redis.getHabitCompletionsForWeek(chatId, habit.id);

    return JSON.stringify({
      success: true,
      habitName: habit.name,
      weeklyCount: completions.length,
    });
  },

  delete_habit: async (chatId, input) => {
    const habitName = String(input.habit_name);
    const habit = await redis.findHabitByName(chatId, habitName);

    if (!habit) {
      return JSON.stringify({ error: true, message: `Habit "${habitName}" not found` });
    }

    await redis.deleteHabit(chatId, habit.id);

    return JSON.stringify({
      success: true,
      deletedHabit: habit.name,
    });
  },

  log_energy: async (chatId, input) => {
    const level = Math.min(5, Math.max(1, Number(input.level))) as 1 | 2 | 3 | 4 | 5;
    const context = input.context ? String(input.context) : undefined;

    // Get current block if any
    const currentBlock = await redis.getCurrentBlock(chatId);

    await redis.createEnergyLog(chatId, level, context, currentBlock?.id);

    const energyDescriptions = ["exhausted", "low", "okay", "good", "energized"];

    return JSON.stringify({
      success: true,
      level,
      description: energyDescriptions[level - 1],
      context,
    });
  },

  save_brain_dump: async (chatId, input) => {
    const content = String(input.content);

    await redis.createBrainDump(chatId, content);

    return JSON.stringify({
      success: true,
      content,
    });
  },

  save_checkin: async (chatId, input) => {
    const rating = Math.min(5, Math.max(1, Number(input.rating)));
    const notes = input.notes ? String(input.notes) : undefined;

    await redis.saveCheckIn(chatId, rating, notes);

    // Clear awaiting checkin flag
    await redis.clearAwaitingCheckin(chatId);

    return JSON.stringify({
      success: true,
      rating,
      hasNotes: !!notes,
    });
  },
};

// Execute a tool by name
export async function executeTool(
  chatId: number,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  const executor = TOOL_EXECUTORS[toolName];

  if (!executor) {
    return {
      result: JSON.stringify({ error: true, message: `Unknown tool: ${toolName}` }),
      isError: true,
    };
  }

  try {
    const result = await executor(chatId, input);
    return { result, isError: false };
  } catch (error) {
    console.error(`Tool ${toolName} failed:`, error);
    return {
      result: JSON.stringify({
        error: true,
        message: error instanceof Error ? error.message : "Operation failed",
      }),
      isError: true,
    };
  }
}
