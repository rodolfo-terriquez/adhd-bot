import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  TelegramUpdate,
  Intent,
  ParsedIntents,
  ReminderItem,
  ReminderWithListIntent,
  CreateListIntent,
  ShowListIntent,
  ModifyListIntent,
  DeleteListIntent,
  EnergyLogIntent,
  LowEnergyModeIntent,
  ShowEnergyPatternsIntent,
  EnergyObservationIntent,
  ShowBlocksIntent,
  ShowBlockIntent,
  VacationModeIntent,
  ActivityBlock,
  CaptureIntent,
  ConfirmExtractionIntent,
  ExtractedTask,
} from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import {
  parseIntent,
  generateConversationSummary,
  generateActionResponse,
  ConversationContext,
  extractTasksFromText,
  generateExtractionResponse,
} from "../lib/llm.js";
import * as redis from "../lib/redis.js";
import {
  scheduleReminder,
  scheduleDailyCheckin,
  scheduleWeeklySummary,
  scheduleEndOfDay,
  scheduleMorningReview,
  deleteSchedule,
  cancelScheduledMessage,
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

    // Cancel any pending follow-up since user has responded
    const pendingFollowUp = await redis.clearPendingFollowUp(chatId);
    if (pendingFollowUp?.qstashMessageId) {
      await cancelScheduledMessage(pendingFollowUp.qstashMessageId);
    }

    // Get conversation history, summary, and check-in state for context
    const [conversationData, isAwaitingCheckin] = await Promise.all([
      redis.getConversationData(chatId),
      redis.isAwaitingCheckin(chatId),
    ]);

    // Parse intent using Claude (with recent conversation for context)
    const parsedResult = await parseIntent(
      userText,
      conversationData.messages,
      isAwaitingCheckin,
    );

    // Build conversation context for response generation
    const context: ConversationContext = {
      messages: conversationData.messages,
      summary: conversationData.summary,
    };

    // Normalize to array for consistent handling
    const intents: Intent[] = Array.isArray(parsedResult)
      ? parsedResult
      : [parsedResult];

    // Handle the intent(s)
    let response: string | null = null;

    // Check for batch handling of same-type intents
    if (intents.length > 1 && intents.every((i) => i.type === "show_list")) {
      // Batch show_list intents
      console.log(
        `[${chatId}] Handling batch of ${intents.length} show_list intents`,
      );
      response = await handleShowMultipleLists(
        chatId,
        intents as ShowListIntent[],
        context,
      );
    } else if (
      intents.length > 1 &&
      intents.every((i) => i.type === "modify_list")
    ) {
      // Batch modify_list intents
      console.log(
        `[${chatId}] Handling batch of ${intents.length} modify_list intents`,
      );
      response = await handleModifyMultipleLists(
        chatId,
        intents as ModifyListIntent[],
        context,
      );
    } else {
      // Process intents sequentially (or single intent)
      // Use skipSend for multiple intents to combine into one message
      const shouldSkipSend = intents.length > 1;
      const responses: string[] = [];
      for (const intent of intents) {
        console.log(`[${chatId}] Handling intent: ${intent.type}`);
        const intentResponse = await handleIntent(
          chatId,
          intent,
          context,
          shouldSkipSend,
        );
        if (intentResponse) {
          responses.push(intentResponse);
        }
      }
      response = responses.length > 0 ? responses.join("\n\n") : null;

      // Send combined response for multiple intents
      if (shouldSkipSend && response) {
        await telegram.sendMessage(chatId, response);
      }
    }
    console.log(
      `[${chatId}] Intent(s) handled, response length: ${response?.length ?? 0}`,
    );

    // Save to conversation history
    if (response) {
      await redis.addToConversation(chatId, userText, response);
    }

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

async function handleIntent(
  chatId: number,
  intent: Intent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string | null> {
  switch (intent.type) {
    case "reminder":
      return await handleReminders(chatId, [intent], context, skipSend);

    case "multiple_reminders":
      return await handleReminders(chatId, intent.reminders, context, skipSend);

    case "brain_dump":
      return await handleBrainDump(chatId, intent, context, skipSend);

    case "inbox":
      return await handleInbox(chatId, intent, context, skipSend);

    case "mark_done":
      return await handleMarkDone(chatId, intent, context, skipSend);

    case "cancel_task":
      return await handleCancelTask(chatId, intent, context, skipSend);

    case "cancel_multiple_tasks":
      return await handleCancelMultipleTasks(chatId, intent, context, skipSend);

    case "list_tasks":
      return await handleListTasks(chatId, context, skipSend);

    case "reminder_with_list":
      return await handleReminderWithList(chatId, intent, context, skipSend);

    case "create_list":
      return await handleCreateList(chatId, intent, context, skipSend);

    case "show_lists":
      return await handleShowLists(chatId, context, skipSend);

    case "show_list":
      return await handleShowList(chatId, intent, context, skipSend);

    case "modify_list":
      return await handleModifyList(chatId, intent, context, skipSend);

    case "delete_list":
      return await handleDeleteList(chatId, intent, context, skipSend);

    case "conversation": {
      const response = await generateActionResponse(
        { type: "conversation", message: intent.message },
        context,
      );
      if (!skipSend) {
        if (!skipSend) {
          await telegram.sendMessage(chatId, response);
        }
      }
      return response;
    }

    case "checkin_response":
      return await handleCheckinResponse(chatId, intent, context, skipSend);

    case "set_checkin_time":
      return await handleSetScheduleTime(
        chatId,
        "checkin",
        intent.hour,
        intent.minute,
        context,
        skipSend,
      );

    case "set_morning_review_time":
      return await handleSetScheduleTime(
        chatId,
        "morning_review",
        intent.hour,
        intent.minute,
        context,
        skipSend,
      );

    // V2 Intent Handlers
    case "energy_log":
      return await handleEnergyLog(chatId, intent, context, skipSend);

    case "low_energy_mode":
      return await handleLowEnergyMode(chatId, intent, context, skipSend);

    case "show_energy_patterns":
      return await handleShowEnergyPatterns(chatId, context, skipSend);

    case "energy_observation":
      return await handleEnergyObservation(chatId, intent, context, skipSend);

    case "show_blocks":
      return await handleShowBlocks(chatId, context, skipSend);

    case "show_block":
      return await handleShowBlock(chatId, intent, context, skipSend);

    case "vacation_mode":
      return await handleVacationMode(chatId, intent, context, skipSend);

    // V2 Capture intents
    case "capture":
      return await handleCapture(chatId, intent, context, skipSend);

    case "confirm_extraction":
      return await handleConfirmExtraction(chatId, intent, context, skipSend);

    // V2 intents that are not yet implemented - respond gracefully
    case "decompose_task":
    case "assign_block":
    case "modify_block":
    case "block_transition":
    case "energy_match":
    case "weekly_planning":
    case "day_planning":
    case "batch_tasks":
    case "context_tag":
    case "filter_by_context": {
      const response = await generateActionResponse(
        { type: "conversation", message: "This feature is coming soon! For now, let me know what you need and I can help another way." },
        context,
      );
      if (!skipSend) {
        await telegram.sendMessage(chatId, response);
      }
      return response;
    }

    default: {
      // Safety net for runtime - TypeScript knows this is unreachable
      const unknownIntent = intent as { type: string };
      console.error(
        `Unknown intent type: ${unknownIntent.type}`,
        JSON.stringify(intent),
      );
      return null;
    }
  }
}

async function handleReminders(
  chatId: number,
  reminders: Array<{
    task: string;
    delayMinutes: number;
    isImportant: boolean;
    isDayOnly?: boolean;
  }>,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const createdTasks: {
    task: string;
    timeStr: string;
    isImportant: boolean;
    isDayOnly: boolean;
  }[] = [];

  for (const reminder of reminders) {
    // For day-only reminders, normalize to noon of target day (exact time doesn't matter)
    let effectiveDelayMinutes = reminder.delayMinutes;
    if (reminder.isDayOnly) {
      const normalizedTime = normalizeToNoon(reminder.delayMinutes);
      effectiveDelayMinutes = Math.round((normalizedTime - Date.now()) / 60000);
    }

    // Create the task in Redis
    const task = await redis.createTask(
      chatId,
      reminder.task,
      reminder.isImportant,
      effectiveDelayMinutes,
      reminder.isDayOnly || false,
    );

    // Schedule the reminder via QStash (skip for day-only reminders)
    if (!task.isDayOnly) {
      try {
        const messageId = await scheduleReminder(
          chatId,
          task.id,
          effectiveDelayMinutes,
          false,
        );
        task.qstashMessageId = messageId;
        await redis.updateTask(task);
      } catch (error) {
        console.error("Failed to schedule QStash reminder:", error);
      }
    }

    // For day-only reminders, show day name instead of time delay
    const timeStr = reminder.isDayOnly
      ? `on ${formatDayFromDelay(effectiveDelayMinutes)}`
      : `in ${formatDelay(effectiveDelayMinutes)}`;

    createdTasks.push({
      task: reminder.task,
      timeStr,
      isImportant: reminder.isImportant,
      isDayOnly: reminder.isDayOnly || false,
    });
  }

  // Use appropriate action context based on count
  const actionContext =
    createdTasks.length === 1
      ? {
          type: "reminder_created" as const,
          task: createdTasks[0].task,
          timeStr: createdTasks[0].timeStr,
          isImportant: createdTasks[0].isImportant,
          isDayOnly: createdTasks[0].isDayOnly,
        }
      : {
          type: "multiple_reminders_created" as const,
          reminders: createdTasks,
        };

  const response = await generateActionResponse(actionContext, context);
  if (!skipSend) {
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
  }
  return response;
}

async function handleBrainDump(
  chatId: number,
  intent: { type: "brain_dump"; content: string },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  await redis.createBrainDump(chatId, intent.content);

  const response = await generateActionResponse(
    {
      type: "brain_dump_saved",
      content: intent.content,
    },
    context,
  );
  if (!skipSend) {
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
  }
  return response;
}

async function handleInbox(
  chatId: number,
  intent: { type: "inbox"; item: string; dayTag?: string },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const inbox = await redis.addToInbox(chatId, intent.item, intent.dayTag);

  const response = await generateActionResponse(
    {
      type: "inbox_item_added",
      item: intent.item,
      inboxCount: inbox.items.length,
      dayTag: intent.dayTag,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleMarkDone(
  chatId: number,
  intent: { type: "mark_done"; taskDescription?: string },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(
    chatId,
    intent.taskDescription,
  );

  if (!task) {
    // Fallback: Try to find and check off an Inbox item
    const inbox = await redis.findListByDescription(chatId, "Inbox");
    if (inbox && intent.taskDescription) {
      const result = await redis.checkListItems(
        chatId,
        inbox.id,
        [intent.taskDescription],
        true,
      );
      if (result && result.modifiedItems.length > 0) {
        const response = await generateActionResponse(
          {
            type: "list_modified",
            name: "Inbox",
            action: "check_items",
            items: result.modifiedItems,
          },
          context,
        );
        if (!skipSend) {
          await telegram.sendMessage(chatId, response);
        }
        return response;
      }
    }

    // Neither Task nor Inbox item found
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "done",
      },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // Complete the linked list if exists
  let linkedListName: string | undefined;
  if (task.linkedListId) {
    const list = await redis.completeList(chatId, task.linkedListId);
    if (list) {
      linkedListName = list.name;
    }
  }

  // Complete the task
  await redis.completeTask(chatId, task.id);

  // Use different response type if there was a linked list
  if (linkedListName) {
    const response = await generateActionResponse(
      {
        type: "task_completed_with_list",
        task: task.content,
        listName: linkedListName,
      },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  const response = await generateActionResponse(
    {
      type: "task_completed",
      task: task.content,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleCancelTask(
  chatId: number,
  intent: { type: "cancel_task"; taskDescription?: string },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(
    chatId,
    intent.taskDescription,
  );

  if (!task) {
    // Fallback: Try to remove from Inbox
    const inbox = await redis.findListByDescription(chatId, "Inbox");
    if (inbox && intent.taskDescription) {
      const result = await redis.removeListItems(chatId, inbox.id, [
        intent.taskDescription,
      ]);
      if (result && result.removedItems.length > 0) {
        const response = await generateActionResponse(
          {
            type: "list_modified",
            name: "Inbox",
            action: "remove_items",
            items: result.removedItems,
          },
          context,
        );
        if (!skipSend) {
          await telegram.sendMessage(chatId, response);
        }
        return response;
      }
    }

    // Neither Task nor Inbox item found
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "cancel",
      },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // If task has a linked list, unlink it (keep the list as standalone)
  if (task.linkedListId) {
    const list = await redis.getList(chatId, task.linkedListId);
    if (list) {
      list.linkedTaskId = undefined;
      await redis.updateList(list);
    }
  }

  // Delete the task
  await redis.deleteTask(chatId, task.id);

  const response = await generateActionResponse(
    {
      type: "task_cancelled",
      task: task.content,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleCancelMultipleTasks(
  chatId: number,
  intent: { type: "cancel_multiple_tasks"; taskDescriptions: string[] },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  console.log(
    `[${chatId}] Searching for ${intent.taskDescriptions.length} tasks to cancel`,
  );
  console.log(
    `[${chatId}] Task descriptions:`,
    JSON.stringify(intent.taskDescriptions),
  );

  const tasks = await redis.findTasksByDescriptions(
    chatId,
    intent.taskDescriptions,
  );

  console.log(`[${chatId}] Found ${tasks.length} matching tasks`);
  if (tasks.length > 0) {
    console.log(
      `[${chatId}] Matching task IDs:`,
      tasks.map((t) => t.id),
    );
  }

  if (tasks.length === 0) {
    console.log(`[${chatId}] No tasks found, sending task_not_found response`);
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "cancel",
      },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  const cancelledTasks: string[] = [];

  for (const task of tasks) {
    // Cancel any scheduled reminder/nag for this task
    if (task.qstashMessageId) {
      await cancelScheduledMessage(task.qstashMessageId);
    }

    // Delete the task
    await redis.deleteTask(chatId, task.id);
    cancelledTasks.push(task.content);
  }

  const response = await generateActionResponse(
    {
      type: "multiple_tasks_cancelled",
      tasks: cancelledTasks,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleListTasks(
  chatId: number,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const tasks = await redis.getPendingTasks(chatId);

  if (tasks.length === 0) {
    const response = await generateActionResponse(
      { type: "no_tasks" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  const taskList = tasks.map((t) => ({
    content: t.content,
    scheduledFor: formatScheduledTime(t.nextReminder, t.isDayOnly),
    isImportant: t.isImportant,
    isOverdue: t.nextReminder < Date.now(),
  }));

  const response = await generateActionResponse(
    {
      type: "task_list",
      tasks: taskList,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleReminderWithList(
  chatId: number,
  intent: ReminderWithListIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // For day-only reminders, normalize to noon of target day (exact time doesn't matter)
  let effectiveDelayMinutes = intent.delayMinutes;
  if (intent.isDayOnly) {
    const normalizedTime = normalizeToNoon(intent.delayMinutes);
    effectiveDelayMinutes = Math.round((normalizedTime - Date.now()) / 60000);
  }

  // Create the list first
  const list = await redis.createList(chatId, intent.listName, intent.items);

  // Create the task with linked list
  const task = await redis.createTask(
    chatId,
    intent.task,
    intent.isImportant,
    effectiveDelayMinutes,
    intent.isDayOnly || false,
  );

  // Link the task to the list
  task.linkedListId = list.id;
  await redis.updateTask(task);

  // Update list with task link
  list.linkedTaskId = task.id;
  await redis.updateList(list);

  // Schedule the reminder via QStash (skip for day-only reminders)
  if (!task.isDayOnly) {
    try {
      const messageId = await scheduleReminder(
        chatId,
        task.id,
        effectiveDelayMinutes,
        false,
      );
      task.qstashMessageId = messageId;
      await redis.updateTask(task);
    } catch (error) {
      console.error("Failed to schedule QStash reminder:", error);
    }
  }

  // For day-only reminders, show day name instead of time delay
  const timeStr = intent.isDayOnly
    ? `on ${formatDayFromDelay(effectiveDelayMinutes)}`
    : `in ${formatDelay(effectiveDelayMinutes)}`;

  const response = await generateActionResponse(
    {
      type: "reminder_with_list_created",
      task: intent.task,
      timeStr,
      listName: intent.listName,
      itemCount: intent.items.length,
      isImportant: intent.isImportant,
      isDayOnly: intent.isDayOnly || false,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleCreateList(
  chatId: number,
  intent: CreateListIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const list = await redis.createList(chatId, intent.name, intent.items);

  const response = await generateActionResponse(
    {
      type: "list_created",
      name: list.name,
      itemCount: list.items.length,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowLists(
  chatId: number,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const lists = await redis.getActiveLists(chatId);

  if (lists.length === 0) {
    const response = await generateActionResponse(
      { type: "no_lists" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  const listSummaries = lists.map((list) => ({
    name: list.name,
    itemCount: list.items.length,
    checkedCount: list.items.filter((i) => i.isChecked).length,
    hasReminder: !!list.linkedTaskId,
  }));

  const response = await generateActionResponse(
    {
      type: "lists_shown",
      lists: listSummaries,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowList(
  chatId: number,
  intent: ShowListIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const list = await redis.findListByDescription(
    chatId,
    intent.listDescription,
  );

  if (!list) {
    const response = await generateActionResponse(
      { type: "list_not_found" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Get linked task info if exists
  let linkedTaskContent: string | undefined;
  let linkedTaskTimeStr: string | undefined;
  if (list.linkedTaskId) {
    const task = await redis.getTask(chatId, list.linkedTaskId);
    if (task) {
      linkedTaskContent = task.content;
      linkedTaskTimeStr = formatFutureTime(task.nextReminder);
    }
  }

  const response = await generateActionResponse(
    {
      type: "list_shown",
      name: list.name,
      items: list.items.map((i) => ({
        content: i.content,
        isChecked: i.isChecked,
      })),
      linkedTaskContent,
      linkedTaskTimeStr,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowMultipleLists(
  chatId: number,
  intents: ShowListIntent[],
  context: ConversationContext,
): Promise<string> {
  const listsData: Array<{
    name: string;
    items: { content: string; isChecked: boolean }[];
  }> = [];

  for (const intent of intents) {
    const list = await redis.findListByDescription(
      chatId,
      intent.listDescription,
    );

    if (list) {
      listsData.push({
        name: list.name,
        items: list.items.map((i) => ({
          content: i.content,
          isChecked: i.isChecked,
        })),
      });
    }
  }

  if (listsData.length === 0) {
    const response = await generateActionResponse(
      { type: "no_lists" },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // If only one list found, use single list response
  if (listsData.length === 1) {
    const response = await generateActionResponse(
      {
        type: "list_shown",
        name: listsData[0].name,
        items: listsData[0].items,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Multiple lists - use combined response
  const response = await generateActionResponse(
    {
      type: "multiple_lists_shown",
      lists: listsData,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleModifyMultipleLists(
  chatId: number,
  intents: ModifyListIntent[],
  context: ConversationContext,
): Promise<string> {
  const modifications: Array<{
    listName: string;
    action: "add_items" | "remove_items" | "check_items" | "uncheck_items";
    items: string[];
  }> = [];

  for (const intent of intents) {
    const list = await redis.findListByDescription(
      chatId,
      intent.listDescription,
    );

    if (!list) {
      continue; // Skip lists that weren't found
    }

    let modifiedItems: string[] = [];

    switch (intent.action) {
      case "add_items":
        if (intent.items && intent.items.length > 0) {
          await redis.addListItems(chatId, list.id, intent.items);
          modifiedItems = intent.items;
        }
        break;
      case "remove_items":
        if (intent.items && intent.items.length > 0) {
          const result = await redis.removeListItems(
            chatId,
            list.id,
            intent.items,
          );
          if (result) {
            modifiedItems = result.removedItems;
          }
        }
        break;
      case "check_items":
        if (intent.items && intent.items.length > 0) {
          const result = await redis.checkListItems(
            chatId,
            list.id,
            intent.items,
            true,
          );
          if (result) {
            modifiedItems = result.modifiedItems;
          }
        }
        break;
      case "uncheck_items":
        if (intent.items && intent.items.length > 0) {
          const result = await redis.checkListItems(
            chatId,
            list.id,
            intent.items,
            false,
          );
          if (result) {
            modifiedItems = result.modifiedItems;
          }
        }
        break;
      case "rename":
        // Rename doesn't fit the batch pattern well, handle separately
        if (intent.newName) {
          await redis.renameList(chatId, list.id, intent.newName);
        }
        continue;
    }

    if (modifiedItems.length > 0) {
      modifications.push({
        listName: list.name,
        action: intent.action,
        items: modifiedItems,
      });
    }
  }

  if (modifications.length === 0) {
    const response = await generateActionResponse(
      { type: "list_not_found" },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // If only one modification, use single list response
  if (modifications.length === 1) {
    const mod = modifications[0];
    const response = await generateActionResponse(
      {
        type: "list_modified",
        name: mod.listName,
        action: mod.action,
        items: mod.items,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Multiple modifications - use combined response
  const response = await generateActionResponse(
    {
      type: "multiple_lists_modified",
      modifications,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleModifyList(
  chatId: number,
  intent: ModifyListIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const list = await redis.findListByDescription(
    chatId,
    intent.listDescription,
  );

  if (!list) {
    const response = await generateActionResponse(
      { type: "list_not_found" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  let modifiedItems: string[] = [];

  switch (intent.action) {
    case "add_items":
      if (intent.items && intent.items.length > 0) {
        await redis.addListItems(chatId, list.id, intent.items);
        modifiedItems = intent.items;
      }
      break;
    case "remove_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.removeListItems(
          chatId,
          list.id,
          intent.items,
        );
        if (result) {
          modifiedItems = result.removedItems;
        }
      }
      break;
    case "check_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.checkListItems(
          chatId,
          list.id,
          intent.items,
          true,
        );
        if (result) {
          modifiedItems = result.modifiedItems;
        }
      }
      break;
    case "uncheck_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.checkListItems(
          chatId,
          list.id,
          intent.items,
          false,
        );
        if (result) {
          modifiedItems = result.modifiedItems;
        }
      }
      break;
    case "rename":
      if (intent.newName) {
        await redis.renameList(chatId, list.id, intent.newName);
      }
      break;
  }

  const response = await generateActionResponse(
    {
      type: "list_modified",
      name: list.name,
      action: intent.action,
      items: modifiedItems.length > 0 ? modifiedItems : undefined,
      newName: intent.newName,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleDeleteList(
  chatId: number,
  intent: DeleteListIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const list = await redis.findListByDescription(
    chatId,
    intent.listDescription,
  );

  if (!list) {
    const response = await generateActionResponse(
      { type: "list_not_found" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // If linked to a task, unlink it
  if (list.linkedTaskId) {
    const task = await redis.getTask(chatId, list.linkedTaskId);
    if (task) {
      task.linkedListId = undefined;
      await redis.updateTask(task);
    }
  }

  await redis.deleteList(chatId, list.id);

  const response = await generateActionResponse(
    {
      type: "list_deleted",
      name: list.name,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

function formatDelay(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

// For day-only reminders, normalize to noon of the target day
// We don't need precision - just need to land on the correct day for morning review filtering
function normalizeToNoon(delayMinutes: number): number {
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const roughTargetTime = Date.now() + delayMinutes * 60 * 1000;

  // Get the date in user's timezone
  const targetDateStr = new Date(roughTargetTime).toLocaleDateString("en-US", {
    timeZone: timezone,
  });
  const [month, day, year] = targetDateStr.split("/").map(Number);

  // Find noon (12:00) on that day in user's timezone
  // Search within a reasonable window to find when it's noon in user's timezone
  const baseMidnightUTC = Date.UTC(year, month - 1, day, 0, 0, 0);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  });

  for (let hourOffset = 0; hourOffset < 36; hourOffset++) {
    const testTime = baseMidnightUTC + hourOffset * 60 * 60 * 1000;
    const hour = parseInt(formatter.format(new Date(testTime)));
    if (hour === 12) {
      return testTime;
    }
  }

  // Fallback: just return rough target time
  return roughTargetTime;
}

// Format day name for day-only reminders (e.g., "Tuesday", "tomorrow")
function formatDayFromDelay(delayMinutes: number): string {
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const targetTime = normalizeToNoon(delayMinutes);
  const targetDate = new Date(targetTime);
  const now = new Date();

  // Get date strings in user's timezone
  const targetStr = targetDate.toLocaleDateString("en-US", {
    timeZone: timezone,
  });
  const nowStr = now.toLocaleDateString("en-US", { timeZone: timezone });
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", {
    timeZone: timezone,
  });

  if (targetStr === nowStr) return "today";
  if (targetStr === tomorrowStr) return "tomorrow";

  return targetDate.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: timezone,
  });
}

function formatFutureTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now;

  // Handle overdue tasks - show how long ago
  if (diff <= 0) {
    const elapsed = Math.abs(diff);
    const minutes = Math.floor(elapsed / 60000);

    if (minutes < 1) {
      return "just now";
    }
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

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

function formatScheduledTime(
  timestamp: number,
  isDayOnly: boolean = false,
): string {
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const date = new Date(timestamp);
  const now = new Date();

  // For day-only reminders, don't include the time
  const time = isDayOnly
    ? ""
    : date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone,
      });

  // Get date strings in user's timezone for accurate comparison
  const dateStr = date.toLocaleDateString("en-US", { timeZone: timezone });
  const nowStr = now.toLocaleDateString("en-US", { timeZone: timezone });

  // Check if today (using timezone-aware comparison)
  if (dateStr === nowStr) {
    return isDayOnly ? `@today` : `@today ${time}`;
  }

  // Check if tomorrow (using timezone-aware comparison)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", {
    timeZone: timezone,
  });
  if (dateStr === tomorrowStr) {
    return isDayOnly ? `@tomorrow` : `@tomorrow ${time}`;
  }

  // Use day name (already timezone-aware)
  const dayName = date
    .toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: timezone,
    })
    .toLowerCase();
  return isDayOnly ? `@${dayName}` : `@${dayName} ${time}`;
}

async function handleCheckinResponse(
  chatId: number,
  intent: { type: "checkin_response"; rating: number; notes?: string },
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Save the check-in
  await redis.saveCheckIn(chatId, intent.rating, intent.notes);

  // Clear the awaiting state
  await redis.clearAwaitingCheckin(chatId);

  const response = await generateActionResponse(
    {
      type: "checkin_logged",
      rating: intent.rating,
      hasNotes: !!intent.notes,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

type ScheduleType = "checkin" | "morning_review";

async function handleSetScheduleTime(
  chatId: number,
  scheduleType: ScheduleType,
  hour: number,
  minute: number,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Get existing preferences to check for old schedules
  const existingPrefs = await redis.getUserPreferences(chatId);

  // Create cron expression (minute hour * * *)
  const cronExpression = `${minute} ${hour} * * *`;

  try {
    if (scheduleType === "checkin") {
      // Delete old checkin-related schedules
      if (existingPrefs?.checkinScheduleId) {
        await deleteSchedule(existingPrefs.checkinScheduleId);
      }
      if (existingPrefs?.weeklySummaryScheduleId) {
        await deleteSchedule(existingPrefs.weeklySummaryScheduleId);
      }
      if (existingPrefs?.endOfDayScheduleId) {
        await deleteSchedule(existingPrefs.endOfDayScheduleId);
      }

      // Schedule new check-in, weekly summary, and end of day
      const weeklyCron = `${minute} ${hour} * * 0`; // Same time on Sundays
      const endOfDayCron = `0 0 * * *`; // Midnight

      const checkinScheduleId = await scheduleDailyCheckin(
        chatId,
        cronExpression,
      );
      const weeklySummaryScheduleId = await scheduleWeeklySummary(
        chatId,
        weeklyCron,
      );
      const endOfDayScheduleId = await scheduleEndOfDay(chatId, endOfDayCron);

      // Save preferences
      const prefs = await redis.setCheckinTime(
        chatId,
        hour,
        minute,
        checkinScheduleId,
      );
      prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
      prefs.endOfDayScheduleId = endOfDayScheduleId;
      await redis.saveUserPreferences(prefs);
    } else {
      // morning_review
      // Delete old morning review schedule
      if (existingPrefs?.morningReviewScheduleId) {
        await deleteSchedule(existingPrefs.morningReviewScheduleId);
      }

      // Schedule new morning review
      const morningReviewScheduleId = await scheduleMorningReview(
        chatId,
        cronExpression,
      );

      // Update preferences
      const prefs = existingPrefs || {
        chatId,
        checkinTime: "20:00",
        morningReviewTime: "08:00",
      };
      prefs.morningReviewTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
      prefs.morningReviewScheduleId = morningReviewScheduleId;
      await redis.saveUserPreferences(prefs);
    }
  } catch (error) {
    console.error(`Failed to create ${scheduleType} schedule:`, error);
    const errorResponse =
      "I had trouble setting up the schedule. You can try again later.";
    await telegram.sendMessage(chatId, errorResponse);
    return errorResponse;
  }

  // Format time for display
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const displayMinute = minute.toString().padStart(2, "0");
  const timeStr = `${displayHour}:${displayMinute} ${period}`;

  const actionType =
    scheduleType === "checkin" ? "checkin_time_set" : "morning_review_time_set";

  const response = await generateActionResponse(
    {
      type: actionType,
      timeStr,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
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

// ==========================================
// V2 Intent Handlers
// ==========================================

async function handleEnergyLog(
  chatId: number,
  intent: EnergyLogIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Get current block if any
  const currentBlock = await redis.getCurrentBlock(chatId);

  // Create energy log - this returns the full EnergyLog object
  const energyLog = await redis.createEnergyLog(
    chatId,
    intent.level,
    intent.context,
    currentBlock?.id,
  );

  // Update energy patterns with the created log
  await redis.updateEnergyPattern(chatId, energyLog);

  const response = await generateActionResponse(
    {
      type: "energy_logged",
      level: intent.level,
      context: intent.context,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleEnergyObservation(
  chatId: number,
  intent: EnergyObservationIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Record the energy preference/observation
  await redis.recordEnergyPreference(chatId, {
    timeOfDay: intent.timeOfDay,
    dayOfWeek: intent.dayOfWeek,
    energyLevel: intent.energyLevel,
    isPattern: intent.isPattern,
  });

  // Generate a conversational response that acknowledges we noted this
  // but doesn't make it feel like a formal "logged" action
  const response = await generateActionResponse(
    {
      type: "energy_observation_noted",
      timeOfDay: intent.timeOfDay,
      dayOfWeek: intent.dayOfWeek,
      energyLevel: intent.energyLevel,
      isPattern: intent.isPattern,
      originalMessage: intent.originalMessage,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleLowEnergyMode(
  chatId: number,
  intent: LowEnergyModeIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Update user preferences
  const prefs = await redis.getUserPreferences(chatId);
  if (prefs) {
    prefs.lowEnergyMode = intent.enabled;
    await redis.saveUserPreferences(prefs);
  }

  const response = await generateActionResponse(
    {
      type: "low_energy_mode_set",
      enabled: intent.enabled,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowEnergyPatterns(
  chatId: number,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const pattern = await redis.getEnergyPattern(chatId);

  if (!pattern || pattern.dataPoints === 0) {
    const response = await generateActionResponse(
      { type: "no_energy_data" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Find best hours (top 3 with highest average)
  const hourEntries = Object.entries(pattern.hourlyAverages)
    .map(([hour, avg]) => ({ hour: parseInt(hour), avg }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  const bestHours = hourEntries.map((e) => {
    const hour = e.hour;
    const period = hour >= 12 ? "PM" : "AM";
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${displayHour}${period}`;
  });

  // Find best days
  const dayEntries = Object.entries(pattern.dayOfWeekAverages)
    .map(([day, avg]) => ({ day, avg: avg as number }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 2);

  const bestDays = dayEntries.map(
    (e) => e.day.charAt(0).toUpperCase() + e.day.slice(1),
  );

  const response = await generateActionResponse(
    {
      type: "energy_patterns_shown",
      patterns: {
        bestHours,
        bestDays,
        dataPoints: pattern.dataPoints,
      },
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowBlocks(
  chatId: number,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  let blocks = await redis.getAllBlocks(chatId);

  // If no blocks, initialize default blocks
  if (blocks.length === 0) {
    await redis.initializeDefaultBlocks(chatId);
    blocks = await redis.getAllBlocks(chatId);
  }

  if (blocks.length === 0) {
    const response = await generateActionResponse(
      { type: "no_blocks" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  const blockData = blocks.map((b) => ({
    name: b.name,
    timeRange: `${b.startTime}-${b.endTime}`,
    days: formatDays(b.days),
    energyProfile: b.energyProfile,
  }));

  const response = await generateActionResponse(
    {
      type: "blocks_shown",
      blocks: blockData,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleShowBlock(
  chatId: number,
  intent: ShowBlockIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // If no block name provided, show all blocks instead
  if (!intent.blockName) {
    return handleShowBlocks(chatId, context, skipSend);
  }

  // Find block by name
  const block = await redis.findBlockByName(chatId, intent.blockName);

  if (!block) {
    const response = await generateActionResponse(
      { type: "no_blocks" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Get tasks assigned to this block for today
  const today = new Date().toISOString().split("T")[0];
  const taskIds = await redis.getTasksForBlock(chatId, block.id, today);

  // Get task contents
  const tasks: string[] = [];
  for (const taskId of taskIds) {
    const task = await redis.getTask(chatId, taskId);
    if (task && task.status === "pending") {
      tasks.push(task.content);
    }
  }

  const response = await generateActionResponse(
    {
      type: "block_shown",
      name: block.name,
      timeRange: `${block.startTime}-${block.endTime}`,
      tasks,
      energyProfile: block.energyProfile,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleVacationMode(
  chatId: number,
  intent: VacationModeIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  const prefs = await redis.getUserPreferences(chatId);
  if (prefs) {
    prefs.vacationMode = intent.action === "start";

    // Set auto-resume date if provided
    if (intent.action === "start" && intent.until) {
      const untilDate = new Date(intent.until);
      if (!isNaN(untilDate.getTime())) {
        prefs.vacationUntil = untilDate.getTime();
      }
    } else {
      prefs.vacationUntil = undefined;
    }

    await redis.saveUserPreferences(prefs);
  }

  const response = await generateActionResponse(
    {
      type: "vacation_mode_set",
      enabled: intent.action === "start",
      until: intent.until,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

function formatDays(days: string[]): string {
  if (days.length === 7) return "every day";
  if (days.length === 5 && !days.includes("saturday") && !days.includes("sunday")) {
    return "weekdays";
  }
  if (days.length === 2 && days.includes("saturday") && days.includes("sunday")) {
    return "weekends";
  }

  // Abbreviate day names
  const abbrevMap: Record<string, string> = {
    monday: "Mon",
    tuesday: "Tue",
    wednesday: "Wed",
    thursday: "Thu",
    friday: "Fri",
    saturday: "Sat",
    sunday: "Sun",
  };

  return days.map((d) => abbrevMap[d] || d).join(", ");
}

// ==========================================
// V2 Capture Handlers
// ==========================================

async function handleCapture(
  chatId: number,
  intent: CaptureIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Extract tasks from the raw content
  const extractionResult = await extractTasksFromText(intent.rawContent);

  if (extractionResult.tasks.length === 0) {
    // No tasks found - respond conversationally
    const response = await generateActionResponse(
      { type: "no_tasks_extracted", rawContent: intent.rawContent },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Store the captured item with extracted tasks for confirmation
  const capturedItem = await redis.createCapturedItem(
    chatId,
    intent.rawContent,
    "text",
    extractionResult.tasks,
  );

  // Generate response showing extracted tasks
  const response = await generateActionResponse(
    {
      type: "tasks_extracted",
      capturedItemId: capturedItem.id,
      tasks: extractionResult.tasks.map((t) => ({
        content: t.content,
        energy: t.suggestedEnergyLevel,
        tags: t.suggestedContextTags,
      })),
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
}

async function handleConfirmExtraction(
  chatId: number,
  intent: ConfirmExtractionIntent,
  context: ConversationContext,
  skipSend: boolean = false,
): Promise<string> {
  // Get the captured item
  const capturedItem = await redis.getCapturedItem(chatId, intent.capturedItemId);

  if (!capturedItem || !capturedItem.extractedTasks) {
    // Captured item not found or expired
    const response = await generateActionResponse(
      { type: "conversation", message: "I couldn't find those extracted tasks - they may have expired. Want to tell me again what you need to do?" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Get the accepted tasks
  const acceptedTasks = intent.acceptedTaskIndices
    .filter((i) => i >= 0 && i < capturedItem.extractedTasks!.length)
    .map((i) => {
      const task = capturedItem.extractedTasks![i];
      // Apply any modifications
      if (intent.modifications && intent.modifications[i]) {
        return { ...task, ...intent.modifications[i] };
      }
      return task;
    });

  if (acceptedTasks.length === 0) {
    // User rejected all tasks
    capturedItem.processingStatus = "rejected";
    await redis.updateCapturedItem(capturedItem);

    const response = await generateActionResponse(
      { type: "extraction_cancelled" },
      context,
    );
    if (!skipSend) {
      await telegram.sendMessage(chatId, response);
    }
    return response;
  }

  // Create tasks from accepted extractions
  const createdTaskNames: string[] = [];
  for (const extracted of acceptedTasks) {
    // Create as inbox item (no specific time) with v2 metadata
    const task = await redis.createTask(
      chatId,
      extracted.content,
      false, // not important by default
      0, // no delay - inbox item
      true, // day-only (no specific time)
    );

    // Note: In a more complete implementation, we'd update the task
    // with energyRequired, contextTags, etc. For now we're just creating basic tasks.
    createdTaskNames.push(extracted.content);
  }

  // Mark captured item as confirmed
  capturedItem.processingStatus = "confirmed";
  capturedItem.processedAt = Date.now();
  await redis.updateCapturedItem(capturedItem);

  const response = await generateActionResponse(
    {
      type: "tasks_confirmed",
      count: createdTaskNames.length,
      tasks: createdTaskNames,
    },
    context,
  );
  if (!skipSend) {
    await telegram.sendMessage(chatId, response);
  }
  return response;
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
