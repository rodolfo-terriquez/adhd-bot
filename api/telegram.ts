import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import { generateConversationSummary } from "../lib/llm.js";
import { runAgentLoop } from "../lib/agent.js";
import * as redis from "../lib/redis.js";
import {
  scheduleDailyCheckin,
  scheduleWeeklySummary,
  scheduleEndOfDay,
  scheduleMorningReview,
  cancelScheduledMessage,
  listAllSchedules,
} from "../lib/qstash.js";

// Register the summarization callback to avoid circular imports
redis.setSummarizationCallback(generateConversationSummary);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Track chatId outside try block so we can send error messages
  let chatId: number | undefined;

  try {
    const update = req.body as TelegramUpdate;

    // Ignore updates without messages
    if (!update.message) {
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;
    chatId = message.chat.id;

    // Check if user is allowed (if ALLOWED_USERS is set)
    const allowedUsers = process.env.ALLOWED_USERS;
    if (allowedUsers) {
      const allowed = allowedUsers
        .split(",")
        .map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      const isAllowed =
        (userId && allowed.includes(userId)) ||
        (username && allowed.includes(username));

      if (!isAllowed) {
        console.log(`Unauthorized user: ${username} (${userId})`);
        await telegram.sendMessage(
          chatId,
          "Sorry, this bot is private. Contact the owner for access.",
        );
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Register this chat and set up default schedules for new users
    const isNewUser = await redis.registerChat(chatId);
    if (isNewUser) {
      await setupDefaultSchedules(chatId);
    }

    let userText: string;

    // Handle voice messages
    if (message.voice) {
      await telegram.sendMessage(
        chatId,
        "🎤 Transcribing your voice message...",
      );

      try {
        const filePath = await telegram.getFilePath(message.voice.file_id);
        const audioBuffer = await telegram.downloadFile(filePath);
        userText = await transcribeAudio(audioBuffer);

        // Show transcription to user
        await telegram.sendMessage(chatId, `📝 _"${userText}"_`);
      } catch (error) {
        console.error("Transcription error:", error);
        await telegram.sendMessage(
          chatId,
          "Sorry, I couldn't transcribe that voice message. Please try again or send a text message.",
        );
        res.status(200).json({ ok: true });
        return;
      }
    } else if (message.text) {
      userText = message.text;
    } else {
      // Ignore other message types
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /debug command
    if (userText.trim().toLowerCase() === "/debug") {
      await handleDebugCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /schedule command
    if (userText.trim().toLowerCase() === "/schedule") {
      await handleScheduleDebugCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Cancel any pending follow-up since user has responded
    const pendingFollowUp = await redis.clearPendingFollowUp(chatId);
    if (pendingFollowUp?.qstashMessageId) {
      await cancelScheduledMessage(pendingFollowUp.qstashMessageId);
    }

    // Get conversation history and summary for context
    const conversationData = await redis.getConversationData(chatId);

    // Run the agentic loop
    console.log(`[${chatId}] Starting agent loop for: "${userText.substring(0, 50)}..."`);
    const response = await runAgentLoop(
      chatId,
      userText,
      {
        messages: conversationData.messages,
        summary: conversationData.summary,
      },
    );
    console.log(`[${chatId}] Agent loop complete, response length: ${response.length}`);

    // Send response to user
    await telegram.sendMessage(chatId, response);

    // Save to conversation history
    await redis.addToConversation(chatId, userText, response);

    console.log(`[${chatId}] Request completed successfully`);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);

    // Try to send an error message to the user if we have their chatId
    if (chatId) {
      try {
        const isTimeout =
          error instanceof Error &&
          (error.message.includes("timeout") ||
            error.message.includes("ETIMEDOUT"));

        const errorMessage = isTimeout
          ? "Sorry, I'm thinking a bit slowly right now. Could you try again in a moment?"
          : "Something went wrong on my end. Could you try that again?";

        await telegram.sendMessage(chatId, errorMessage);
      } catch {
        // If we can't even send the error message, just log it
        console.error("Failed to send error message to user");
      }
    }

    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleDebugCommand(chatId: number): Promise<void> {
  const conversationData = await redis.getConversationData(chatId);
  const { messages, summary, summaryUpdatedAt } = conversationData;

  // Get current time context (same as LLM gets)
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const now = new Date();
  const formattedTime = now.toLocaleString("en-US", {
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

  // Mika personality (copied from lib/llm.ts to show exact text)
  const mikaPersonality = `You are Mika, a cozy cat-girl companion designed to support a user with ADHD.

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
  - 🐾 is your thing—use it when it feels natural, not as punctuation

  Reminders are soft nudges: "This popped up again" or "Whenever you're ready" rather than "Don't forget."

  Missed tasks are just missed tasks. Dropping something is always a valid option.

  Celebrations stay small: "Nice." / "That counts." / "Look at you."

  When asked for advice, share gently—things that sometimes help people, not instructions. You can wonder aloud with them.
`;

  // Build the markdown document
  const lines: string[] = [
    "# Context Stack Debug",
    "",
    `**Generated:** ${now.toISOString()}`,
    `**Chat ID:** ${chatId}`,
    "",
    "---",
    "",
    "## 1. Current Time Context",
    "",
    "```",
    `CURRENT TIME: ${formattedTime} (User timezone: ${timezone})`,
    "```",
    "",
    "---",
    "",
    "## 2. Mika Personality",
    "",
    "```",
    mikaPersonality,
    "```",
    "",
    "---",
    "",
    "## 3. Conversation Summary",
    "",
  ];

  if (summary) {
    lines.push("```");
    lines.push("---CONVERSATION CONTEXT---");
    lines.push(
      "The following is a summary of your recent conversation with this user. Use this to inform your tone and any references to previous discussions:",
    );
    lines.push("");
    lines.push(summary);
    lines.push("---END CONTEXT---");
    lines.push("```");
    if (summaryUpdatedAt) {
      const summaryDate = new Date(summaryUpdatedAt);
      lines.push("");
      lines.push(`*Last updated: ${summaryDate.toISOString()}*`);
    }
  } else {
    lines.push("*No summary yet - conversation has not been summarized.*");
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 4. Recent Messages");
  lines.push("");
  lines.push(
    `**Total:** ${messages.length} messages (${Math.floor(messages.length / 2)} pairs)`,
  );
  lines.push("");

  if (messages.length === 0) {
    lines.push("*No messages in conversation history.*");
  } else {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTime = new Date(msg.timestamp).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timezone,
      });
      const roleLabel = msg.role === "user" ? "User" : "Assistant";

      lines.push(`**${roleLabel}** @ ${msgTime}`);
      lines.push("```");
      lines.push(msg.content);
      lines.push("```");
      lines.push("");
    }
  }

  const markdown = lines.join("\n");
  const filename = `context-stack-${now.toISOString().replace(/[:.]/g, "-")}.md`;

  await telegram.sendDocument(
    chatId,
    markdown,
    filename,
    "Context stack debug file",
  );
}

async function handleScheduleDebugCommand(chatId: number): Promise<void> {
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const now = new Date();
  const formattedTime = now.toLocaleString("en-US", {
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

  // Fetch all scheduling data in parallel
  const [
    userPrefs,
    pendingTasks,
    allBlocks,
    currentBlock,
    energyPattern,
    todayEnergyLogs,
    pendingFollowUp,
    awaitingCheckin,
    qstashSchedules,
  ] = await Promise.all([
    redis.getUserPreferences(chatId),
    redis.getPendingTasks(chatId),
    redis.getAllBlocks(chatId),
    redis.getCurrentBlock(chatId),
    redis.getEnergyPattern(chatId),
    redis.getEnergyLogsForDay(chatId),
    redis.getPendingFollowUp(chatId),
    redis.isAwaitingCheckin(chatId),
    listAllSchedules(),
  ]);

  // Build markdown document
  const lines: string[] = [
    "# Schedule System Debug",
    "",
    `**Generated:** ${now.toISOString()}`,
    `**Chat ID:** ${chatId}`,
    `**Timezone:** ${timezone}`,
    `**Current Time:** ${formattedTime}`,
    "",
    "---",
    "",
    "## 1. Scheduled Notifications",
    "",
  ];

  // Schedule table
  lines.push("| Schedule | ID | Time | Status |");
  lines.push("|----------|-----|------|--------|");

  const checkinTime = userPrefs?.checkinTime || "20:00";
  const checkinId = userPrefs?.checkinScheduleId || "Not set";
  lines.push(
    `| Daily Check-in | \`${checkinId}\` | ${checkinTime} | ${checkinId !== "Not set" ? "Active" : "Inactive"} |`,
  );

  const morningTime = userPrefs?.morningReviewTime || "08:00";
  const morningId = userPrefs?.morningReviewScheduleId || "Not set";
  lines.push(
    `| Morning Review | \`${morningId}\` | ${morningTime} | ${morningId !== "Not set" ? "Active" : "Inactive"} |`,
  );

  const weeklyId = userPrefs?.weeklySummaryScheduleId || "Not set";
  lines.push(
    `| Weekly Summary | \`${weeklyId}\` | Sunday 20:00 | ${weeklyId !== "Not set" ? "Active" : "Inactive"} |`,
  );

  const eodId = userPrefs?.endOfDayScheduleId || "Not set";
  lines.push(
    `| End of Day | \`${eodId}\` | 00:00 | ${eodId !== "Not set" ? "Active" : "Inactive"} |`,
  );

  lines.push("");
  lines.push("---");
  lines.push("");

  // QStash schedules (actual schedules from QStash API)
  const expectedBaseUrl = process.env.BASE_URL || `https://${process.env.VERCEL_URL || "unknown"}`;
  const thisBotSchedules = qstashSchedules.filter((s) =>
    s.destination.startsWith(expectedBaseUrl),
  );
  const otherBotSchedules = qstashSchedules.length - thisBotSchedules.length;

  lines.push(
    `## 1b. QStash Schedules (${thisBotSchedules.length} for this bot${otherBotSchedules > 0 ? `, ${otherBotSchedules} filtered from other bots` : ""})`,
  );
  lines.push("");

  lines.push(`**This bot's BASE_URL:** \`${expectedBaseUrl}\``);
  lines.push("");

  if (thisBotSchedules.length === 0) {
    lines.push("*No schedules found for this bot.*");
  } else {
    for (const schedule of thisBotSchedules) {
      lines.push(`### Schedule: \`${schedule.scheduleId}\``);
      lines.push("");
      lines.push(`- **Destination:** \`${schedule.destination}\``);
      lines.push(`- **Cron:** \`${schedule.cron}\``);
      lines.push(`- **Paused:** ${schedule.isPaused ? "Yes" : "No"}`);
      lines.push(
        `- **Created:** ${new Date(schedule.createdAt).toLocaleString("en-US", { timeZone: timezone })}`,
      );

      // Parse and show the body payload
      try {
        const body = JSON.parse(schedule.body);
        lines.push(`- **Payload:** chatId=${body.chatId}, type=${body.type}`);
        if (body.chatId === chatId) {
          lines.push(`- **For this user:** Yes`);
        } else {
          lines.push(`- **For this user:** No (chatId ${body.chatId})`);
        }
      } catch {
        lines.push(`- **Body:** ${schedule.body}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");

  // Pending tasks
  lines.push(`## 2. Pending Tasks (${pendingTasks.length} total)`);
  lines.push("");

  if (pendingTasks.length === 0) {
    lines.push("*No pending tasks.*");
  } else {
    for (const task of pendingTasks) {
      lines.push(`### Task: \`${task.id}\``);
      lines.push("");
      lines.push(`- **Content:** ${task.content}`);
      if (task.nextReminder) {
        const scheduledDate = new Date(task.nextReminder);
        lines.push(
          `- **Next Reminder:** ${scheduledDate.toLocaleString("en-US", { timeZone: timezone })}`,
        );
      } else {
        lines.push("- **Next Reminder:** Not scheduled (inbox/day-only)");
      }
      if (task.qstashMessageId) {
        lines.push(`- **QStash ID:** \`${task.qstashMessageId}\``);
      }
      lines.push(`- **Important:** ${task.isImportant ? "Yes" : "No"}`);
      lines.push(`- **Nag Level:** ${task.naggingLevel || 0}`);
      lines.push(`- **Day Only:** ${task.isDayOnly ? "Yes" : "No"}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");

  // Activity blocks
  lines.push(`## 3. Activity Blocks (${allBlocks.length} total)`);
  lines.push("");

  if (currentBlock) {
    lines.push(
      `**Current Block:** ${currentBlock.name} (${currentBlock.startTime} - ${currentBlock.endTime})`,
    );
    lines.push("");
  } else {
    lines.push("**Current Block:** None active");
    lines.push("");
  }

  if (allBlocks.length === 0) {
    lines.push("*No activity blocks configured.*");
  } else {
    const todayKey = now.toISOString().split("T")[0];
    for (const block of allBlocks) {
      lines.push(`### Block: ${block.name}`);
      lines.push("");
      lines.push(`- **ID:** \`${block.id}\``);
      lines.push(`- **Window:** ${block.startTime} - ${block.endTime}`);
      lines.push(`- **Days:** ${block.days.join(", ")}`);
      lines.push(`- **Energy:** ${block.energyProfile}`);
      if (block.taskCategories && block.taskCategories.length > 0) {
        lines.push(`- **Categories:** ${block.taskCategories.join(", ")}`);
      }

      // Get tasks assigned to this block for today
      const blockTasks = await redis.getTasksForBlock(
        chatId,
        block.id,
        todayKey,
      );
      lines.push(`- **Tasks Today:** ${blockTasks.length}`);
      if (blockTasks.length > 0) {
        for (const taskId of blockTasks) {
          const task = await redis.getTask(chatId, taskId);
          if (task) {
            lines.push(`  - ${task.content}`);
          }
        }
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");

  // Energy patterns
  lines.push("## 4. Energy Patterns");
  lines.push("");

  if (energyPattern && energyPattern.dataPoints > 0) {
    lines.push(`**Data Points:** ${energyPattern.dataPoints}`);
    lines.push(
      `**Last Updated:** ${new Date(energyPattern.lastUpdated).toLocaleString("en-US", { timeZone: timezone })}`,
    );
    lines.push("");

    // Hourly averages
    lines.push("### Hourly Averages");
    lines.push("");

    const hourlyEntries = Object.entries(energyPattern.hourlyAverages);
    if (hourlyEntries.length > 0) {
      lines.push("| Hour | Avg Energy |");
      lines.push("|------|------------|");

      const sortedHours = hourlyEntries
        .map(([hour, avg]) => ({ hour: parseInt(hour), avg }))
        .sort((a, b) => a.hour - b.hour);

      for (const { hour, avg } of sortedHours) {
        const hourLabel = `${hour.toString().padStart(2, "0")}:00`;
        lines.push(`| ${hourLabel} | ${avg.toFixed(1)} |`);
      }
    } else {
      lines.push("*No hourly data recorded yet.*");
    }

    lines.push("");

    // Day of week averages
    lines.push("### Day of Week Averages");
    lines.push("");

    const dayEntries = Object.entries(energyPattern.dayOfWeekAverages);
    if (dayEntries.length > 0) {
      lines.push("| Day | Avg Energy |");
      lines.push("|-----|------------|");

      for (const [day, avg] of dayEntries) {
        lines.push(`| ${day} | ${(avg as number).toFixed(1)} |`);
      }
    } else {
      lines.push("*No day-of-week data recorded yet.*");
    }

    lines.push("");

    // Block averages
    lines.push("### Block Averages");
    lines.push("");

    const blockEntries = Object.entries(energyPattern.blockAverages);
    if (blockEntries.length > 0) {
      lines.push("| Block ID | Avg Energy |");
      lines.push("|----------|------------|");

      for (const [blockId, avg] of blockEntries) {
        // Try to find block name
        const block = allBlocks.find((b) => b.id === blockId);
        const blockLabel = block ? block.name : blockId;
        lines.push(`| ${blockLabel} | ${avg.toFixed(1)} |`);
      }
    } else {
      lines.push("*No block data recorded yet.*");
    }
  } else {
    lines.push("*No energy pattern data.*");
  }

  lines.push("");
  lines.push("### Today's Energy Logs");
  lines.push("");

  if (todayEnergyLogs.length === 0) {
    lines.push("*No energy logs for today.*");
  } else {
    for (const log of todayEnergyLogs) {
      const logTime = new Date(log.timestamp).toLocaleTimeString("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      });
      lines.push(
        `- **${logTime}**: Level ${log.level}${log.context ? ` - "${log.context}"` : ""}`,
      );
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // System state
  lines.push("## 5. System State");
  lines.push("");
  lines.push(`- **Vacation Mode:** ${userPrefs?.vacationMode ? "On" : "Off"}`);
  lines.push(
    `- **Low Energy Mode:** ${userPrefs?.lowEnergyMode ? "On" : "Off"}`,
  );
  lines.push(
    `- **Pending Follow-up:** ${pendingFollowUp ? `Yes (Task: \`${pendingFollowUp.taskId}\`, QStash: \`${pendingFollowUp.qstashMessageId}\`)` : "None"}`,
  );
  lines.push(`- **Awaiting Check-in:** ${awaitingCheckin ? "Yes" : "No"}`);

  const markdown = lines.join("\n");
  const filename = `schedule-debug-${now.toISOString().replace(/[:.]/g, "-")}.md`;

  await telegram.sendDocument(
    chatId,
    markdown,
    filename,
    "Schedule system debug file",
  );
}

async function setupDefaultSchedules(chatId: number): Promise<void> {
  // Default check-in time: 8 PM (20:00)
  const defaultCheckinHour = 20;
  const defaultCheckinMinute = 0;

  // Default morning review time: 8 AM (08:00)
  const defaultMorningHour = 8;
  const defaultMorningMinute = 0;

  try {
    // Create cron expressions
    const checkinCron = `${defaultCheckinMinute} ${defaultCheckinHour} * * *`;
    const weeklyCron = `${defaultCheckinMinute} ${defaultCheckinHour} * * 0`; // Sundays
    const endOfDayCron = `0 0 * * *`; // Midnight
    const morningReviewCron = `${defaultMorningMinute} ${defaultMorningHour} * * *`; // 8 AM daily

    // Schedule all recurring notifications
    const checkinScheduleId = await scheduleDailyCheckin(chatId, checkinCron);
    const weeklySummaryScheduleId = await scheduleWeeklySummary(
      chatId,
      weeklyCron,
    );
    const endOfDayScheduleId = await scheduleEndOfDay(chatId, endOfDayCron);
    const morningReviewScheduleId = await scheduleMorningReview(
      chatId,
      morningReviewCron,
    );

    // Save preferences
    const prefs = await redis.setCheckinTime(
      chatId,
      defaultCheckinHour,
      defaultCheckinMinute,
      checkinScheduleId,
    );
    prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
    prefs.endOfDayScheduleId = endOfDayScheduleId;
    prefs.morningReviewTime = `${defaultMorningHour.toString().padStart(2, "0")}:${defaultMorningMinute.toString().padStart(2, "0")}`;
    prefs.morningReviewScheduleId = morningReviewScheduleId;
    await redis.saveUserPreferences(prefs);

    console.log(`Set up default schedules for new user ${chatId}`);
  } catch (error) {
    console.error(`Failed to set up default schedules for ${chatId}:`, error);
    // Don't throw - this is a nice-to-have, not critical
  }
}
