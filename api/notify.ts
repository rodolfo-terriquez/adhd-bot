import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { NotificationPayload } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import * as redis from "../lib/redis.js";
import {
  scheduleReminder,
  scheduleFollowUp,
  verifySignature,
} from "../lib/qstash.js";
import {
  generateNaggingMessage,
  calculateNextNagDelay,
  generateCheckinPrompt,
  generateWeeklyInsights,
  generateFollowUpMessage,
  generateReminderMessage,
  generateFinalNagMessage,
  generateEndOfDayMessage,
  generateMorningReviewMessage,
  generateBlockStartMessage,
  generateBlockEndMessage,
  generateEnergyCheckMessage,
  ConversationContext,
  WeeklyHabitStats,
} from "../lib/llm.js";

// Helper to get conversation context for a chat
async function getContext(chatId: number): Promise<ConversationContext> {
  const conversationData = await redis.getConversationData(chatId);
  return {
    messages: conversationData.messages,
    summary: conversationData.summary,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Verify QStash signature
    const signature = req.headers["upstash-signature"] as string;
    const rawBody = JSON.stringify(req.body);

    if (signature) {
      const isValid = await verifySignature(signature, rawBody);
      if (!isValid) {
        console.error("Invalid QStash signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    const payload = req.body as NotificationPayload;

    switch (payload.type) {
      case "reminder":
        await handleReminder(payload);
        break;

      case "nag":
        await handleNag(payload);
        break;

      case "daily_checkin":
        await handleDailyCheckin(payload);
        break;

      case "weekly_summary":
        await handleWeeklySummary(payload);
        break;

      case "follow_up":
        await handleFollowUp(payload);
        break;

      case "end_of_day":
        await handleEndOfDay(payload);
        break;

      case "morning_review":
        await handleMorningReview(payload);
        break;

      // V2 Block notifications
      case "block_start":
        await handleBlockStart(payload);
        break;

      case "block_end":
        await handleBlockEnd(payload);
        break;

      case "energy_check":
        await handleEnergyCheck(payload);
        break;

      default:
        console.warn("Unknown notification type:", payload);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleReminder(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Get the task
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed or deleted, no action needed
    return;
  }

  // Get conversation context for personality-consistent messaging
  const context = await getContext(chatId);

  // Generate and send the reminder using the LLM for personality-consistent messaging
  const reminderMessage = await generateReminderMessage(task.content, context);
  await telegram.sendMessage(chatId, reminderMessage);

  // Schedule a follow-up in 5-10 minutes in case user doesn't respond
  try {
    const followUpMessageId = await scheduleFollowUp(chatId, taskId);
    await redis.setPendingFollowUp(
      chatId,
      taskId,
      task.content,
      followUpMessageId,
    );
  } catch (error) {
    console.error("Failed to schedule follow-up:", error);
  }

  // If important, schedule the first nag
  if (task.isImportant) {
    const nextDelay = calculateNextNagDelay(0, true);
    const messageId = await scheduleReminder(chatId, taskId, nextDelay, true);

    // Update task with new nag info
    task.naggingLevel = 1;
    task.nextReminder = Date.now() + nextDelay * 60 * 1000;
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  }
}

async function handleNag(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Get the task
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed, no more nagging needed
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a contextual nagging message
  const nagMessage = await generateNaggingMessage(
    task,
    task.naggingLevel,
    context,
  );

  await telegram.sendMessage(chatId, nagMessage);

  // Schedule the next nag with escalating delay
  const nextDelay = calculateNextNagDelay(task.naggingLevel, task.isImportant);

  // Cap nagging at level 5 (about 24 hours of nagging)
  if (task.naggingLevel < 5) {
    const messageId = await scheduleReminder(chatId, taskId, nextDelay, true);

    task.naggingLevel += 1;
    task.nextReminder = Date.now() + nextDelay * 60 * 1000;
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  } else {
    // Final nag - stop nagging but keep task pending
    const finalMessage = await generateFinalNagMessage(task.content, context);
    await telegram.sendMessage(chatId, finalMessage);
  }
}

async function handleDailyCheckin(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a friendly check-in prompt
  const prompt = await generateCheckinPrompt(context);

  await telegram.sendMessage(chatId, prompt);

  // Mark that we're awaiting a check-in response
  await redis.markAwaitingCheckin(chatId);
}

async function handleWeeklySummary(
  payload: NotificationPayload,
): Promise<void> {
  const { chatId } = payload;

  // Get weekly check-ins, brain dumps, and habit stats
  const [checkIns, dumps, completedTaskCount, habitStats] = await Promise.all([
    redis.getWeeklyCheckIns(chatId),
    redis.getWeeklyDumps(chatId),
    redis.getWeeklyCompletedTaskCount(chatId),
    redis.getWeeklyHabitStats(chatId),
  ]);

  // Only send if there's any data
  if (checkIns.length === 0 && dumps.length === 0 && completedTaskCount === 0 && habitStats.length === 0) {
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Format habit stats for the weekly insights
  const formattedHabitStats: WeeklyHabitStats[] = habitStats.map((h) => ({
    name: h.habit.name,
    completed: h.completedDays,
    scheduled: h.scheduledDays,
  }));

  // Generate weekly insights
  const insights = await generateWeeklyInsights(
    checkIns,
    dumps,
    completedTaskCount,
    context,
    formattedHabitStats.length > 0 ? formattedHabitStats : undefined,
  );

  await telegram.sendMessage(chatId, insights);
}

async function handleFollowUp(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Check if there's still a pending follow-up (user hasn't responded)
  const pendingFollowUp = await redis.getPendingFollowUp(chatId);

  if (!pendingFollowUp || pendingFollowUp.taskId !== taskId) {
    // User already responded or follow-up was cancelled, skip
    return;
  }

  // Get the task to make sure it's still pending
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed, no follow-up needed
    await redis.clearPendingFollowUp(chatId);
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Generate and send a gentle follow-up message
  const followUpMessage = await generateFollowUpMessage(task.content, context);
  await telegram.sendMessage(chatId, followUpMessage);

  // Clear the pending follow-up (we only send one follow-up per reminder)
  await redis.clearPendingFollowUp(chatId);
}

async function handleEndOfDay(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a gentle end-of-day message
  const message = await generateEndOfDayMessage(context);

  await telegram.sendMessage(chatId, message);
}

async function handleMorningReview(
  payload: NotificationPayload,
): Promise<void> {
  const { chatId } = payload;

  // Get inbox items, overdue tasks, today's tasks, energy patterns, and habits
  const [inboxItems, overdueTasks, todaysTasks, energyPattern, blocks, todaysHabits] = await Promise.all([
    redis.getUncheckedInboxItems(chatId),
    redis.getOverdueTasks(chatId),
    redis.getTodaysTasks(chatId),
    redis.getEnergyPattern(chatId),
    redis.getActiveBlocks(chatId),
    redis.getHabitsForToday(chatId),
  ]);

  // Schedule habits to blocks for today (auto-assigns based on preferences/energy)
  await redis.scheduleHabitsToBlocks(chatId);

  // Get conversation context
  const context = await getContext(chatId);

  // Format overdue tasks with time info
  const formattedOverdue = overdueTasks.map((task) => ({
    content: task.content,
    overdueTime: formatOverdueTime(task.nextReminder),
  }));

  // Format today's tasks with time info
  const formattedToday = todaysTasks.map((task) => ({
    content: task.content,
    scheduledTime: formatScheduledTime(task.nextReminder, task.isDayOnly),
  }));

  // Build energy insights if we have enough data
  let energyInsights: {
    predictedMorningEnergy: "high" | "medium" | "low";
    predictedAfternoonEnergy: "high" | "medium" | "low";
    bestTimeForHardTasks?: string;
    dataPoints: number;
  } | undefined;

  if (energyPattern.dataPoints >= 3) {
    // Get today's day of week
    const dayNames: Array<"sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"> =
      ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const today = dayNames[new Date().getDay()];

    // Predict morning energy (average of hours 8-11)
    const morningHours = [8, 9, 10, 11];
    const morningAvg = morningHours.reduce((sum, h) =>
      sum + (energyPattern.hourlyAverages[h] || 3), 0) / morningHours.length;

    // Predict afternoon energy (average of hours 14-17)
    const afternoonHours = [14, 15, 16, 17];
    const afternoonAvg = afternoonHours.reduce((sum, h) =>
      sum + (energyPattern.hourlyAverages[h] || 3), 0) / afternoonHours.length;

    const toLevel = (avg: number): "high" | "medium" | "low" => {
      if (avg >= 3.5) return "high";
      if (avg <= 2.5) return "low";
      return "medium";
    };

    // Find best time for hard tasks (highest energy block)
    let bestTimeForHardTasks: string | undefined;
    if (blocks.length > 0) {
      const blockScores = blocks
        .filter(b => b.days.includes(today) && b.energyProfile !== "low")
        .map(b => ({
          block: b,
          score: energyPattern.blockAverages[b.id] ||
            (b.energyProfile === "high" ? 4 : 3),
        }))
        .sort((a, b) => b.score - a.score);

      if (blockScores.length > 0) {
        const best = blockScores[0].block;
        bestTimeForHardTasks = `${best.name} (${best.startTime}-${best.endTime})`;
      }
    }

    energyInsights = {
      predictedMorningEnergy: toLevel(morningAvg),
      predictedAfternoonEnergy: toLevel(afternoonAvg),
      bestTimeForHardTasks,
      dataPoints: energyPattern.dataPoints,
    };
  }

  // Format habits with completion status and assigned block
  const habits = await Promise.all(
    todaysHabits.map(async (habit) => {
      const completed = await redis.isHabitCompletedToday(chatId, habit.id);
      // Find which block this habit is assigned to for today
      let blockName: string | undefined;
      for (const block of blocks) {
        const blockHabits = await redis.getHabitsForBlock(chatId, block.id);
        if (blockHabits.includes(habit.id)) {
          blockName = block.name;
          break;
        }
      }
      return {
        name: habit.name,
        completed,
        block: blockName,
      };
    }),
  );

  // Generate the morning review message
  const message = await generateMorningReviewMessage(
    {
      inboxItems: inboxItems.map((item) => ({ content: item.content })),
      overdueTasks: formattedOverdue,
      todaysTasks: formattedToday,
      energyInsights,
      habits: habits.length > 0 ? habits : undefined,
    },
    context,
  );

  await telegram.sendMessage(chatId, message);
}

function formatScheduledTime(timestamp: number, isDayOnly: boolean = false): string {
  // For day-only reminders, show "anytime" or similar
  if (isDayOnly) {
    return "anytime";
  }

  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: process.env.USER_TIMEZONE || "America/Los_Angeles",
  });
  return time;
}

function formatOverdueTime(timestamp: number): string {
  const now = Date.now();
  const elapsed = now - timestamp;
  const minutes = Math.floor(elapsed / 60000);

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ==========================================
// V2 Block Notification Handlers
// ==========================================

async function handleBlockStart(payload: NotificationPayload): Promise<void> {
  const { chatId, blockId } = payload;

  if (!blockId) {
    console.error("Block start notification missing blockId");
    return;
  }

  // Check if user has vacation mode enabled
  const prefs = await redis.getUserPreferences(chatId);
  if (prefs?.vacationMode) {
    console.log(`Skipping block start for ${chatId} - vacation mode enabled`);
    return;
  }

  // Get the block
  const block = await redis.getActivityBlock(chatId, blockId);
  if (!block || block.status !== "active") {
    return;
  }

  // Get tasks assigned to this block for today
  const today = new Date().toISOString().split("T")[0];
  const taskIds = await redis.getTasksForBlock(chatId, blockId, today);

  // Get task details
  const tasks: Array<{ content: string; energy?: string }> = [];
  for (const taskId of taskIds) {
    const task = await redis.getTask(chatId, taskId);
    if (task && task.status === "pending") {
      tasks.push({
        content: task.content,
        // Note: energyRequired would come from TaskV2 if we had it
      });
    }
  }

  // Get habits assigned to this block for today
  const habitIds = await redis.getHabitsForBlock(chatId, blockId, today);
  const habits: Array<{ name: string; completed: boolean }> = [];
  for (const habitId of habitIds) {
    const habit = await redis.getHabit(chatId, habitId);
    if (habit && habit.status === "active") {
      const completed = await redis.isHabitCompletedToday(chatId, habit.id);
      habits.push({ name: habit.name, completed });
    }
  }

  // Set this as the current block
  await redis.setCurrentBlock(chatId, blockId);

  // Get conversation context
  const context = await getContext(chatId);

  // Generate and send the block start message
  const message = await generateBlockStartMessage(
    {
      blockName: block.name,
      timeRange: `${block.startTime}-${block.endTime}`,
      energyProfile: block.energyProfile,
      tasks,
      habits: habits.length > 0 ? habits : undefined,
    },
    context,
  );

  await telegram.sendMessage(chatId, message);
}

async function handleBlockEnd(payload: NotificationPayload): Promise<void> {
  const { chatId, blockId } = payload;

  if (!blockId) {
    console.error("Block end notification missing blockId");
    return;
  }

  // Check if user has vacation mode enabled
  const prefs = await redis.getUserPreferences(chatId);
  if (prefs?.vacationMode) {
    console.log(`Skipping block end for ${chatId} - vacation mode enabled`);
    return;
  }

  // Get the block
  const block = await redis.getActivityBlock(chatId, blockId);
  if (!block) {
    return;
  }

  // Get tasks assigned to this block for today
  const today = new Date().toISOString().split("T")[0];
  const taskIds = await redis.getTasksForBlock(chatId, blockId, today);

  // Separate completed and remaining tasks
  const completedTasks: string[] = [];
  const remainingTasks: string[] = [];

  for (const taskId of taskIds) {
    const task = await redis.getTask(chatId, taskId);
    if (task) {
      if (task.status === "completed") {
        completedTasks.push(task.content);
      } else {
        remainingTasks.push(task.content);
      }
    }
  }

  // Get habits assigned to this block and separate by completion
  const habitIds = await redis.getHabitsForBlock(chatId, blockId, today);
  const completedHabits: string[] = [];
  const incompleteHabits: string[] = [];

  for (const habitId of habitIds) {
    const habit = await redis.getHabit(chatId, habitId);
    if (habit && habit.status === "active") {
      const completed = await redis.isHabitCompletedToday(chatId, habit.id);
      if (completed) {
        completedHabits.push(habit.name);
      } else {
        incompleteHabits.push(habit.name);
      }
    }
  }

  // Find next block (simple implementation - would need proper scheduling logic)
  const allBlocks = await redis.getAllBlocks(chatId);
  const currentIndex = allBlocks.findIndex((b) => b.id === blockId);
  const nextBlock = currentIndex >= 0 && currentIndex < allBlocks.length - 1
    ? allBlocks[currentIndex + 1]
    : undefined;

  // Clear current block
  await redis.clearCurrentBlock(chatId);

  // Get conversation context
  const context = await getContext(chatId);

  // Generate and send the block end message
  const message = await generateBlockEndMessage(
    {
      blockName: block.name,
      completedTasks,
      remainingTasks,
      completedHabits: completedHabits.length > 0 ? completedHabits : undefined,
      incompleteHabits: incompleteHabits.length > 0 ? incompleteHabits : undefined,
      nextBlockName: nextBlock?.name,
    },
    context,
  );

  await telegram.sendMessage(chatId, message);
}

async function handleEnergyCheck(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Check if user has vacation mode enabled
  const prefs = await redis.getUserPreferences(chatId);
  if (prefs?.vacationMode) {
    console.log(`Skipping energy check for ${chatId} - vacation mode enabled`);
    return;
  }

  // Get current block name if any
  const currentBlock = await redis.getCurrentBlock(chatId);

  // Get conversation context
  const context = await getContext(chatId);

  // Generate and send the energy check message
  const message = await generateEnergyCheckMessage(currentBlock?.name, context);

  await telegram.sendMessage(chatId, message);
}
