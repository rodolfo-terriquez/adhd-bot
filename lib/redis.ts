import { Redis } from "@upstash/redis";
import type {
  Task,
  BrainDump,
  CheckIn,
  UserPreferences,
  List,
  ListItem,
  // V2 types
  ActivityBlock,
  EnergyLog,
  EnergyPattern,
  CapturedItem,
  ExtractedTask,
  DayOfWeek,
} from "./types.js";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (!redisClient) {
    redisClient = Redis.fromEnv();
  }
  return redisClient;
}

// Key prefix for multi-project support (allows sharing the same Redis instance)
// Set REDIS_KEY_PREFIX env var to isolate data between projects (e.g., "v2:" for the new version)
const getKeyPrefix = (): string => process.env.REDIS_KEY_PREFIX || "";

// Key patterns (all include prefix for multi-project isolation)
const TASK_KEY = (chatId: number, taskId: string) => `${getKeyPrefix()}task:${chatId}:${taskId}`;
const TASKS_SET_KEY = (chatId: number) => `${getKeyPrefix()}tasks:${chatId}`;
const DUMP_KEY = (chatId: number, dumpId: string) => `${getKeyPrefix()}dump:${chatId}:${dumpId}`;
const DUMPS_SET_KEY = (chatId: number, date: string) =>
  `${getKeyPrefix()}dumps:${chatId}:${date}`;
const CHECKIN_KEY = (chatId: number, date: string) =>
  `${getKeyPrefix()}checkin:${chatId}:${date}`;
const CHECKINS_SET_KEY = (chatId: number) => `${getKeyPrefix()}checkins:${chatId}`;
const USER_PREFS_KEY = (chatId: number) => `${getKeyPrefix()}user_prefs:${chatId}`;
const AWAITING_CHECKIN_KEY = (chatId: number) => `${getKeyPrefix()}awaiting_checkin:${chatId}`;
const PENDING_FOLLOW_UP_KEY = (chatId: number) => `${getKeyPrefix()}pending_follow_up:${chatId}`;
const COMPLETED_TASKS_KEY = (chatId: number, date: string) =>
  `${getKeyPrefix()}completed:${chatId}:${date}`;

// List key patterns
const LIST_KEY = (chatId: number, listId: string) => `${getKeyPrefix()}list:${chatId}:${listId}`;
const LISTS_SET_KEY = (chatId: number) => `${getKeyPrefix()}lists:${chatId}`;

// V2 key patterns
const BLOCK_KEY = (chatId: number, blockId: string) => `${getKeyPrefix()}block:${chatId}:${blockId}`;
const BLOCKS_SET_KEY = (chatId: number) => `${getKeyPrefix()}blocks:${chatId}`;
const ENERGY_LOG_KEY = (chatId: number, logId: string) => `${getKeyPrefix()}energy_log:${chatId}:${logId}`;
const ENERGY_LOGS_SET_KEY = (chatId: number, date: string) => `${getKeyPrefix()}energy_logs:${chatId}:${date}`;
const ENERGY_PATTERN_KEY = (chatId: number) => `${getKeyPrefix()}energy_pattern:${chatId}`;
const CAPTURED_KEY = (chatId: number, capturedId: string) => `${getKeyPrefix()}captured:${chatId}:${capturedId}`;
const CAPTURED_PENDING_KEY = (chatId: number) => `${getKeyPrefix()}captured_pending:${chatId}`;
const BLOCK_TASKS_KEY = (chatId: number, blockId: string, date: string) => `${getKeyPrefix()}block_tasks:${chatId}:${blockId}:${date}`;
const CURRENT_BLOCK_KEY = (chatId: number) => `${getKeyPrefix()}current_block:${chatId}`;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

// Task operations
export async function createTask(
  chatId: number,
  content: string,
  isImportant: boolean,
  delayMinutes: number,
  isDayOnly: boolean = false,
): Promise<Task> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();

  const task: Task = {
    id,
    chatId,
    content,
    isImportant,
    naggingLevel: 0,
    nextReminder: now + delayMinutes * 60 * 1000,
    isDayOnly,
    createdAt: now,
    status: "pending",
  };

  await redis.set(TASK_KEY(chatId, id), JSON.stringify(task));
  await redis.sadd(TASKS_SET_KEY(chatId), id);

  return task;
}

export async function getTask(
  chatId: number,
  taskId: string,
): Promise<Task | null> {
  const redis = getClient();
  const data = await redis.get<string>(TASK_KEY(chatId, taskId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateTask(task: Task): Promise<void> {
  const redis = getClient();
  await redis.set(TASK_KEY(task.chatId, task.id), JSON.stringify(task));
}

export async function completeTask(
  chatId: number,
  taskId: string,
): Promise<Task | null> {
  const redis = getClient();
  const task = await getTask(chatId, taskId);
  if (!task) return null;

  task.status = "completed";

  // Save completed task with TTL (7 days for debugging/inspection)
  const TTL_7_DAYS = 7 * 24 * 60 * 60;
  await redis.set(TASK_KEY(chatId, task.id), JSON.stringify(task), { ex: TTL_7_DAYS });

  await redis.srem(TASKS_SET_KEY(chatId), taskId);

  // Track completion count for the day
  const todayKey = getTodayKey();
  const completedKey = COMPLETED_TASKS_KEY(chatId, todayKey);
  await redis.incr(completedKey);
  // Set expiration for 8 days (enough for weekly summary)
  await redis.expire(completedKey, 8 * 24 * 60 * 60);

  return task;
}

export async function deleteTask(
  chatId: number,
  taskId: string,
): Promise<Task | null> {
  const redis = getClient();
  const task = await getTask(chatId, taskId);
  if (!task) return null;

  // Remove from pending tasks set
  await redis.srem(TASKS_SET_KEY(chatId), taskId);
  // Delete the task data
  await redis.del(TASK_KEY(chatId, taskId));

  return task;
}

export async function getPendingTasks(chatId: number): Promise<Task[]> {
  const redis = getClient();
  const taskIds = await redis.smembers<string[]>(TASKS_SET_KEY(chatId));

  if (!taskIds || taskIds.length === 0) return [];

  const tasks: Task[] = [];
  for (const taskId of taskIds) {
    const task = await getTask(chatId, taskId);
    if (task && task.status === "pending") {
      tasks.push(task);
    }
  }

  return tasks.sort((a, b) => a.nextReminder - b.nextReminder);
}

// Helper function to strip scheduling metadata from task descriptions
// Removes patterns like "@sunday 2:29 PM", "@today 10:00 AM", "(overdue)", "(important)"
// Also normalizes apostrophes to improve matching
function stripSchedulingMetadata(description: string): string {
  return description
    .toLowerCase()
    .replace(/@\w+\s+[\d:]+\s+[ap]m/gi, '') // Remove @day time patterns
    .replace(/\(overdue\)/gi, '') // Remove (overdue)
    .replace(/\(important\)/gi, '') // Remove (important)
    .replace(/['']/g, '') // Remove apostrophes for better matching
    .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
    .trim();
}

export async function findTaskByDescription(
  chatId: number,
  description?: string,
): Promise<Task | null> {
  const tasks = await getPendingTasks(chatId);
  if (tasks.length === 0) return null;

  // If no description, return the most recent task
  if (!description) {
    return tasks[tasks.length - 1];
  }

  // Try to find a matching task (fuzzy match)
  // Strip scheduling metadata and normalize both description and task content
  const normalizedDesc = stripSchedulingMetadata(description);
  const matchedTask = tasks.find((t) => {
    const normalizedTaskContent = stripSchedulingMetadata(t.content);
    return (
      normalizedTaskContent.includes(normalizedDesc) ||
      normalizedDesc.includes(normalizedTaskContent)
    );
  });

  return matchedTask || tasks[tasks.length - 1];
}

export async function findTasksByDescriptions(
  chatId: number,
  descriptions: string[],
): Promise<Task[]> {
  const tasks = await getPendingTasks(chatId);
  console.log(`[Redis] findTasksByDescriptions: ${descriptions.length} descriptions, ${tasks.length} pending tasks`);

  if (tasks.length === 0) return [];

  const matchedTasks: Task[] = [];
  const usedTaskIds = new Set<string>();

  for (const description of descriptions) {
    // Strip scheduling metadata and normalize both description and task content
    const normalizedDesc = stripSchedulingMetadata(description);
    console.log(`[Redis] Searching for: "${description}" → normalized: "${normalizedDesc}"`);

    const matchedTask = tasks.find((t) => {
      if (usedTaskIds.has(t.id)) return false;
      const normalizedTaskContent = stripSchedulingMetadata(t.content);
      const matches = normalizedTaskContent.includes(normalizedDesc) ||
                      normalizedDesc.includes(normalizedTaskContent);

      console.log(`[Redis]   vs task: "${t.content}" → normalized: "${normalizedTaskContent}" → match: ${matches}`);
      return matches;
    });

    if (matchedTask) {
      console.log(`[Redis] ✓ Matched: ${matchedTask.id}`);
      matchedTasks.push(matchedTask);
      usedTaskIds.add(matchedTask.id);
    } else {
      console.log(`[Redis] ✗ No match found for: "${description}"`);
    }
  }

  return matchedTasks;
}

export async function getOverdueTasks(chatId: number): Promise<Task[]> {
  const tasks = await getPendingTasks(chatId);
  const now = Date.now();

  return tasks.filter((task) => task.nextReminder < now);
}

export async function getTodaysTasks(chatId: number): Promise<Task[]> {
  const tasks = await getPendingTasks(chatId);

  // Get start and end of today in user's timezone
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const now = new Date();

  // Start of today (00:00:00)
  const startOfDay = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  startOfDay.setHours(0, 0, 0, 0);

  // End of today (23:59:59)
  const endOfDay = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  endOfDay.setHours(23, 59, 59, 999);

  const startTimestamp = startOfDay.getTime();
  const endTimestamp = endOfDay.getTime();

  // Return tasks scheduled for today (between start and end of day)
  return tasks.filter(
    (task) => task.nextReminder >= startTimestamp && task.nextReminder <= endTimestamp
  );
}

// List operations
export async function createList(
  chatId: number,
  name: string,
  itemContents: string[],
  linkedTaskId?: string,
): Promise<List> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();

  const items: ListItem[] = itemContents.map((content) => ({
    id: generateId(),
    content,
    isChecked: false,
    createdAt: now,
  }));

  const list: List = {
    id,
    chatId,
    name,
    items,
    linkedTaskId,
    createdAt: now,
    updatedAt: now,
    status: "active",
  };

  await redis.set(LIST_KEY(chatId, id), JSON.stringify(list));
  await redis.sadd(LISTS_SET_KEY(chatId), id);

  return list;
}

// Inbox is a special list with a reserved name
const INBOX_NAME = "Inbox";

export async function getOrCreateInbox(chatId: number): Promise<List> {
  // First, try to find existing inbox
  const lists = await getActiveLists(chatId);
  const inbox = lists.find((l) => l.name === INBOX_NAME);

  if (inbox) {
    return inbox;
  }

  // Create new inbox list
  return createList(chatId, INBOX_NAME, []);
}

export async function addToInbox(
  chatId: number,
  item: string,
  dayTag?: string,
): Promise<List> {
  const inbox = await getOrCreateInbox(chatId);

  // Append day tag to content if provided (e.g., "doctor appointment @tuesday")
  const displayContent = dayTag ? `${item} @${dayTag}` : item;

  const newItem: ListItem = {
    id: generateId(),
    content: displayContent,
    isChecked: false,
    createdAt: Date.now(),
  };

  inbox.items.push(newItem);
  await updateList(inbox);

  return inbox;
}

export async function getUncheckedInboxItems(
  chatId: number,
): Promise<ListItem[]> {
  const lists = await getActiveLists(chatId);
  const inbox = lists.find((l) => l.name === INBOX_NAME);

  if (!inbox) return [];

  return inbox.items.filter((item) => !item.isChecked);
}

export async function getInboxItemsForDay(
  chatId: number,
  day: string,
): Promise<ListItem[]> {
  const lists = await getActiveLists(chatId);
  const inbox = lists.find((l) => l.name === INBOX_NAME);

  if (!inbox) return [];

  const dayLower = day.toLowerCase();
  return inbox.items.filter(
    (item) =>
      !item.isChecked && item.content.toLowerCase().includes(`@${dayLower}`),
  );
}

export async function getList(
  chatId: number,
  listId: string,
): Promise<List | null> {
  const redis = getClient();
  const data = await redis.get<string>(LIST_KEY(chatId, listId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateList(list: List): Promise<void> {
  const redis = getClient();
  list.updatedAt = Date.now();
  await redis.set(LIST_KEY(list.chatId, list.id), JSON.stringify(list));
}

export async function deleteList(
  chatId: number,
  listId: string,
): Promise<List | null> {
  const redis = getClient();
  const list = await getList(chatId, listId);
  if (!list) return null;

  await redis.srem(LISTS_SET_KEY(chatId), listId);
  await redis.del(LIST_KEY(chatId, listId));

  return list;
}

export async function getActiveLists(chatId: number): Promise<List[]> {
  const redis = getClient();
  const listIds = await redis.smembers<string[]>(LISTS_SET_KEY(chatId));

  if (!listIds || listIds.length === 0) return [];

  const lists: List[] = [];
  for (const listId of listIds) {
    const list = await getList(chatId, listId);
    if (list && list.status === "active") {
      lists.push(list);
    }
  }

  return lists.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findListByDescription(
  chatId: number,
  description?: string,
): Promise<List | null> {
  const lists = await getActiveLists(chatId);
  if (lists.length === 0) return null;

  // If no description, return the most recently updated list
  if (!description) {
    return lists[0];
  }

  const normalizedDesc = description.toLowerCase().trim();

  // Try exact substring match first
  let matchedList = lists.find(
    (l) =>
      l.name.toLowerCase().includes(normalizedDesc) ||
      normalizedDesc.includes(l.name.toLowerCase()),
  );

  if (matchedList) return matchedList;

  // Try word-based matching - check if any significant word from the description
  // appears in the list name
  const descWords = normalizedDesc.split(/\s+/).filter((w) => w.length > 2); // Skip short words like "my", "the", "a"

  matchedList = lists.find((l) => {
    const listNameLower = l.name.toLowerCase();
    return descWords.some((word) => listNameLower.includes(word));
  });

  if (matchedList) return matchedList;

  // Try matching against list items as a last resort
  matchedList = lists.find((l) => {
    return l.items.some((item) => {
      const itemLower = item.content.toLowerCase();
      return (
        itemLower.includes(normalizedDesc) ||
        descWords.some((word) => itemLower.includes(word))
      );
    });
  });

  return matchedList || null;
}

export async function completeList(
  chatId: number,
  listId: string,
): Promise<List | null> {
  const list = await getList(chatId, listId);
  if (!list) return null;

  list.status = "completed";
  // Check all items
  list.items = list.items.map((item) => ({ ...item, isChecked: true }));
  await updateList(list);

  // Remove from active lists set
  const redis = getClient();
  await redis.srem(LISTS_SET_KEY(chatId), listId);

  return list;
}

export async function addListItems(
  chatId: number,
  listId: string,
  itemContents: string[],
): Promise<List | null> {
  const list = await getList(chatId, listId);
  if (!list || list.status !== "active") return null;

  const now = Date.now();
  const newItems: ListItem[] = itemContents.map((content) => ({
    id: generateId(),
    content,
    isChecked: false,
    createdAt: now,
  }));

  list.items.push(...newItems);
  await updateList(list);

  return list;
}

export async function removeListItems(
  chatId: number,
  listId: string,
  itemDescriptions: string[],
): Promise<{ list: List; removedItems: string[] } | null> {
  const list = await getList(chatId, listId);
  if (!list || list.status !== "active") return null;

  const removedItems: string[] = [];
  const normalizedDescriptions = itemDescriptions.map((d) => d.toLowerCase());

  list.items = list.items.filter((item) => {
    const normalizedContent = item.content.toLowerCase();
    const shouldRemove = normalizedDescriptions.some(
      (desc) =>
        normalizedContent.includes(desc) || desc.includes(normalizedContent),
    );
    if (shouldRemove) {
      removedItems.push(item.content);
    }
    return !shouldRemove;
  });

  await updateList(list);

  return { list, removedItems };
}

export async function checkListItems(
  chatId: number,
  listId: string,
  itemDescriptions: string[],
  checked: boolean,
): Promise<{ list: List; modifiedItems: string[] } | null> {
  const list = await getList(chatId, listId);
  if (!list || list.status !== "active") return null;

  const modifiedItems: string[] = [];
  const normalizedDescriptions = itemDescriptions.map((d) => d.toLowerCase());

  list.items = list.items.map((item) => {
    const normalizedContent = item.content.toLowerCase();
    const shouldModify = normalizedDescriptions.some(
      (desc) =>
        normalizedContent.includes(desc) || desc.includes(normalizedContent),
    );
    if (shouldModify && item.isChecked !== checked) {
      modifiedItems.push(item.content);
      return { ...item, isChecked: checked };
    }
    return item;
  });

  await updateList(list);

  return { list, modifiedItems };
}

export async function renameList(
  chatId: number,
  listId: string,
  newName: string,
): Promise<List | null> {
  const list = await getList(chatId, listId);
  if (!list || list.status !== "active") return null;

  list.name = newName;
  await updateList(list);

  return list;
}

// Brain dump operations
export async function createBrainDump(
  chatId: number,
  content: string,
): Promise<BrainDump> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();
  const TTL_14_DAYS = 14 * 24 * 60 * 60;

  const dump: BrainDump = {
    id,
    chatId,
    content,
    createdAt: now,
  };

  await redis.set(DUMP_KEY(chatId, id), JSON.stringify(dump));
  await redis.sadd(DUMPS_SET_KEY(chatId, todayKey), id);
  // Set expiration for dumps and their index set (14 days)
  await redis.expire(DUMP_KEY(chatId, id), TTL_14_DAYS);
  await redis.expire(DUMPS_SET_KEY(chatId, todayKey), TTL_14_DAYS);

  return dump;
}

export async function getTodaysDumps(chatId: number): Promise<BrainDump[]> {
  return getDumpsByDate(chatId, getTodayKey());
}

export async function getDumpsByDate(
  chatId: number,
  dateKey: string,
): Promise<BrainDump[]> {
  const redis = getClient();
  const dumpIds = await redis.smembers<string[]>(
    DUMPS_SET_KEY(chatId, dateKey),
  );

  if (!dumpIds || dumpIds.length === 0) return [];

  const dumps: BrainDump[] = [];
  for (const dumpId of dumpIds) {
    const data = await redis.get<string>(DUMP_KEY(chatId, dumpId));
    if (data) {
      const dump = typeof data === "string" ? JSON.parse(data) : data;
      dumps.push(dump);
    }
  }

  return dumps.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getWeeklyDumps(chatId: number): Promise<BrainDump[]> {
  const dumps: BrainDump[] = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const dayDumps = await getDumpsByDate(chatId, dateKey);
    dumps.push(...dayDumps);
  }

  return dumps.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getWeeklyCompletedTaskCount(
  chatId: number,
): Promise<number> {
  const redis = getClient();
  const today = new Date();
  let total = 0;

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const count = await redis.get<number>(COMPLETED_TASKS_KEY(chatId, dateKey));
    if (count) {
      total +=
        typeof count === "number" ? count : parseInt(count as string, 10) || 0;
    }
  }

  return total;
}

// Chat IDs for daily summary (store all active chats)
const ACTIVE_CHATS_KEY = () => `${getKeyPrefix()}active_chats`;

export async function registerChat(chatId: number): Promise<boolean> {
  const redis = getClient();
  // sadd returns the number of elements added (1 if new, 0 if already exists)
  const added = await redis.sadd(ACTIVE_CHATS_KEY(), chatId.toString());
  return added === 1;
}

export async function getActiveChats(): Promise<number[]> {
  const redis = getClient();
  const chatIds = await redis.smembers<string[]>(ACTIVE_CHATS_KEY());
  return (chatIds || []).map((id) => parseInt(id, 10));
}

// Conversation memory
const CONVERSATION_KEY = (chatId: number) => `${getKeyPrefix()}conversation:${chatId}`;
const MAX_CONVERSATION_PAIRS = 30; // Trigger summarization at 30 pairs
const RECENT_PAIRS_TO_KEEP = 10; // Keep 10 most recent pairs verbatim after summarization

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationData {
  messages: ConversationMessage[];
  summary?: string; // Rolling summary of older context
  summaryUpdatedAt?: number; // When the summary was last updated
}

export async function getConversationData(
  chatId: number,
): Promise<ConversationData> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);
  const data = await redis.get<string>(key);

  if (!data) return { messages: [] };

  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    // Handle legacy format (just an array of messages)
    if (Array.isArray(parsed)) {
      return { messages: parsed };
    }
    return parsed as ConversationData;
  } catch {
    return { messages: [] };
  }
}

export async function getConversationHistory(
  chatId: number,
): Promise<ConversationMessage[]> {
  const data = await getConversationData(chatId);
  return data.messages;
}

export async function getConversationSummary(
  chatId: number,
): Promise<string | undefined> {
  const data = await getConversationData(chatId);
  return data.summary;
}

// Callback for triggering summarization (set by the caller to avoid circular imports)
let summarizationCallback:
  | ((
      messages: ConversationMessage[],
      existingSummary?: string,
    ) => Promise<string>)
  | null = null;

export function setSummarizationCallback(
  callback: (
    messages: ConversationMessage[],
    existingSummary?: string,
  ) => Promise<string>,
): void {
  summarizationCallback = callback;
}

export async function addToConversation(
  chatId: number,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);

  // Get existing conversation data
  const conversationData = await getConversationData(chatId);
  const { messages, summary } = conversationData;

  // Add new messages
  const now = Date.now();
  messages.push(
    { role: "user", content: userMessage, timestamp: now },
    { role: "assistant", content: assistantResponse, timestamp: now },
  );

  // Check if we need to summarize (at 30 message pairs = 60 messages)
  const messagePairs = messages.length / 2;

  if (messagePairs >= MAX_CONVERSATION_PAIRS && summarizationCallback) {
    // Get the oldest 20 pairs (40 messages) to summarize
    const messagesToSummarize = messages.slice(
      0,
      (MAX_CONVERSATION_PAIRS - RECENT_PAIRS_TO_KEEP) * 2,
    );
    // Keep the newest 10 pairs (20 messages) verbatim
    const recentMessages = messages.slice(-(RECENT_PAIRS_TO_KEEP * 2));

    // Save immediately with trimmed messages (don't wait for summarization to complete)
    const tempData: ConversationData = {
      messages: recentMessages,
      summary,
      summaryUpdatedAt: conversationData.summaryUpdatedAt,
    };
    await redis.set(key, JSON.stringify(tempData));

    // Generate new summary in background, then update ONLY the summary field
    // We re-read current data to avoid overwriting messages added while summarizing
    summarizationCallback(messagesToSummarize, summary)
      .then(async (newSummary) => {
        // Re-read current conversation to preserve any messages added during summarization
        const currentData = await getConversationData(chatId);
        const updatedData: ConversationData = {
          messages: currentData.messages, // Keep current messages, not stale reference
          summary: newSummary,
          summaryUpdatedAt: Date.now(),
        };
        await redis.set(key, JSON.stringify(updatedData));
      })
      .catch((err) => {
        console.error("Failed to generate conversation summary:", err);
      });
  } else {
    // Normal save - just update messages
    const updatedData: ConversationData = {
      messages,
      summary,
      summaryUpdatedAt: conversationData.summaryUpdatedAt,
    };
    await redis.set(key, JSON.stringify(updatedData));
  }
}

export async function clearConversation(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(CONVERSATION_KEY(chatId));
}

// Check-in operations
export async function saveCheckIn(
  chatId: number,
  rating: number,
  notes?: string,
): Promise<CheckIn> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();
  const TTL_90_DAYS = 90 * 24 * 60 * 60;

  const checkIn: CheckIn = {
    id,
    chatId,
    date: todayKey,
    rating,
    notes,
    createdAt: now,
  };

  await redis.set(CHECKIN_KEY(chatId, todayKey), JSON.stringify(checkIn));
  await redis.sadd(CHECKINS_SET_KEY(chatId), todayKey);
  // Set expiration for check-ins and the index set (90 days)
  await redis.expire(CHECKIN_KEY(chatId, todayKey), TTL_90_DAYS);
  await redis.expire(CHECKINS_SET_KEY(chatId), TTL_90_DAYS);

  return checkIn;
}

export async function getCheckIn(
  chatId: number,
  date: string,
): Promise<CheckIn | null> {
  const redis = getClient();
  const data = await redis.get<string>(CHECKIN_KEY(chatId, date));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function getWeeklyCheckIns(chatId: number): Promise<CheckIn[]> {
  const checkIns: CheckIn[] = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const checkIn = await getCheckIn(chatId, dateKey);
    if (checkIn) {
      checkIns.push(checkIn);
    }
  }

  return checkIns.sort((a, b) => a.createdAt - b.createdAt);
}

// User preferences operations
export async function getUserPreferences(
  chatId: number,
): Promise<UserPreferences | null> {
  const redis = getClient();
  const data = await redis.get<string>(USER_PREFS_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function saveUserPreferences(
  prefs: UserPreferences,
): Promise<void> {
  const redis = getClient();
  await redis.set(USER_PREFS_KEY(prefs.chatId), JSON.stringify(prefs));
}

export async function setCheckinTime(
  chatId: number,
  hour: number,
  minute: number,
  scheduleId?: string,
): Promise<UserPreferences> {
  const existing = await getUserPreferences(chatId);
  const prefs: UserPreferences = {
    chatId,
    checkinTime: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
    morningReviewTime: existing?.morningReviewTime || "08:00",
    checkinScheduleId: scheduleId || existing?.checkinScheduleId,
    weeklySummaryScheduleId: existing?.weeklySummaryScheduleId,
    endOfDayScheduleId: existing?.endOfDayScheduleId,
    morningReviewScheduleId: existing?.morningReviewScheduleId,
  };
  await saveUserPreferences(prefs);
  return prefs;
}

// Awaiting check-in state
const AWAITING_CHECKIN_TTL = 60 * 60; // 1 hour

export async function markAwaitingCheckin(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.set(AWAITING_CHECKIN_KEY(chatId), "1", {
    ex: AWAITING_CHECKIN_TTL,
  });
}

export async function isAwaitingCheckin(chatId: number): Promise<boolean> {
  const redis = getClient();
  const value = await redis.get(AWAITING_CHECKIN_KEY(chatId));
  return value === 1 || value === "1";
}

export async function clearAwaitingCheckin(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(AWAITING_CHECKIN_KEY(chatId));
}

// Pending follow-up tracking
export interface PendingFollowUp {
  taskId: string;
  taskContent: string;
  qstashMessageId: string;
  scheduledAt: number;
}

const PENDING_FOLLOW_UP_TTL = 30 * 60; // 30 minutes

export async function setPendingFollowUp(
  chatId: number,
  taskId: string,
  taskContent: string,
  qstashMessageId: string,
): Promise<void> {
  const redis = getClient();
  const followUp: PendingFollowUp = {
    taskId,
    taskContent,
    qstashMessageId,
    scheduledAt: Date.now(),
  };
  await redis.set(PENDING_FOLLOW_UP_KEY(chatId), JSON.stringify(followUp), {
    ex: PENDING_FOLLOW_UP_TTL,
  });
}

export async function getPendingFollowUp(
  chatId: number,
): Promise<PendingFollowUp | null> {
  const redis = getClient();
  const data = await redis.get<string>(PENDING_FOLLOW_UP_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function clearPendingFollowUp(
  chatId: number,
): Promise<PendingFollowUp | null> {
  const redis = getClient();
  const followUp = await getPendingFollowUp(chatId);
  await redis.del(PENDING_FOLLOW_UP_KEY(chatId));
  return followUp;
}

// ==========================================
// V2: Activity Block Operations
// ==========================================

export async function createActivityBlock(
  chatId: number,
  block: Omit<ActivityBlock, "id" | "chatId" | "createdAt" | "updatedAt">,
): Promise<ActivityBlock> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();

  const newBlock: ActivityBlock = {
    ...block,
    id,
    chatId,
    createdAt: now,
    updatedAt: now,
  };

  await redis.set(BLOCK_KEY(chatId, id), JSON.stringify(newBlock));
  await redis.sadd(BLOCKS_SET_KEY(chatId), id);

  return newBlock;
}

export async function getActivityBlock(
  chatId: number,
  blockId: string,
): Promise<ActivityBlock | null> {
  const redis = getClient();
  const data = await redis.get<string>(BLOCK_KEY(chatId, blockId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateActivityBlock(block: ActivityBlock): Promise<void> {
  const redis = getClient();
  block.updatedAt = Date.now();
  await redis.set(BLOCK_KEY(block.chatId, block.id), JSON.stringify(block));
}

export async function deleteActivityBlock(
  chatId: number,
  blockId: string,
): Promise<ActivityBlock | null> {
  const redis = getClient();
  const block = await getActivityBlock(chatId, blockId);
  if (!block) return null;

  await redis.srem(BLOCKS_SET_KEY(chatId), blockId);
  await redis.del(BLOCK_KEY(chatId, blockId));

  return block;
}

export async function getActiveBlocks(chatId: number): Promise<ActivityBlock[]> {
  const redis = getClient();
  const blockIds = await redis.smembers<string[]>(BLOCKS_SET_KEY(chatId));

  if (!blockIds || blockIds.length === 0) return [];

  const blocks: ActivityBlock[] = [];
  for (const blockId of blockIds) {
    const block = await getActivityBlock(chatId, blockId);
    if (block && block.status === "active") {
      blocks.push(block);
    }
  }

  // Sort by start time
  return blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export async function getAllBlocks(chatId: number): Promise<ActivityBlock[]> {
  const redis = getClient();
  const blockIds = await redis.smembers<string[]>(BLOCKS_SET_KEY(chatId));

  if (!blockIds || blockIds.length === 0) return [];

  const blocks: ActivityBlock[] = [];
  for (const blockId of blockIds) {
    const block = await getActivityBlock(chatId, blockId);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export async function findBlockByName(
  chatId: number,
  name: string,
): Promise<ActivityBlock | null> {
  const blocks = await getAllBlocks(chatId);
  const normalizedName = name.toLowerCase().trim();

  return blocks.find(
    (b) => b.name.toLowerCase().includes(normalizedName) ||
           normalizedName.includes(b.name.toLowerCase())
  ) || null;
}

export async function getCurrentBlock(chatId: number): Promise<ActivityBlock | null> {
  const blocks = await getActiveBlocks(chatId);
  if (blocks.length === 0) return null;

  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const now = new Date();
  const currentTime = now.toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  const dayNames: DayOfWeek[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const currentDay = dayNames[now.getDay()];

  for (const block of blocks) {
    if (!block.days.includes(currentDay)) continue;
    if (currentTime >= block.startTime && currentTime < block.endTime) {
      return block;
    }
  }

  return null;
}

// Explicitly set the current block (for block start notifications)
export async function setCurrentBlock(chatId: number, blockId: string): Promise<void> {
  const redis = getClient();
  // Set with 24 hour TTL (will be cleared when block ends)
  await redis.set(CURRENT_BLOCK_KEY(chatId), blockId, { ex: 24 * 60 * 60 });
}

export async function clearCurrentBlock(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(CURRENT_BLOCK_KEY(chatId));
}

// Default blocks for new users
const DEFAULT_BLOCKS: Omit<ActivityBlock, "id" | "chatId" | "createdAt" | "updatedAt">[] = [
  {
    name: "Morning Routine",
    startTime: "07:00",
    endTime: "09:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    energyProfile: "low",
    taskCategories: ["personal", "routine"],
    flexLevel: "soft",
    isDefault: true,
    status: "active",
  },
  {
    name: "Focus Time",
    startTime: "09:00",
    endTime: "12:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    energyProfile: "high",
    taskCategories: ["work", "creative", "thinking"],
    flexLevel: "flexible",
    isDefault: true,
    status: "active",
  },
  {
    name: "Midday",
    startTime: "12:00",
    endTime: "14:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    energyProfile: "medium",
    taskCategories: ["errands", "calls", "admin"],
    flexLevel: "flexible",
    isDefault: true,
    status: "active",
  },
  {
    name: "Afternoon",
    startTime: "14:00",
    endTime: "17:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    energyProfile: "medium",
    taskCategories: ["work", "admin"],
    flexLevel: "flexible",
    isDefault: true,
    status: "active",
  },
  {
    name: "Evening",
    startTime: "17:00",
    endTime: "21:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    energyProfile: "low",
    taskCategories: ["personal", "errands", "relaxation"],
    flexLevel: "soft",
    isDefault: true,
    status: "active",
  },
  {
    name: "Weekend",
    startTime: "09:00",
    endTime: "18:00",
    days: ["saturday", "sunday"],
    energyProfile: "variable",
    taskCategories: ["personal", "errands", "projects"],
    flexLevel: "soft",
    isDefault: true,
    status: "active",
  },
];

export async function initializeDefaultBlocks(chatId: number): Promise<ActivityBlock[]> {
  const existingBlocks = await getAllBlocks(chatId);
  if (existingBlocks.length > 0) {
    return existingBlocks;
  }

  const createdBlocks: ActivityBlock[] = [];
  for (const blockTemplate of DEFAULT_BLOCKS) {
    const block = await createActivityBlock(chatId, blockTemplate);
    createdBlocks.push(block);
  }

  return createdBlocks;
}

// ==========================================
// V2: Energy Log Operations
// ==========================================

const ENERGY_LOG_TTL = 90 * 24 * 60 * 60; // 90 days

export async function createEnergyLog(
  chatId: number,
  level: 1 | 2 | 3 | 4 | 5,
  context?: string,
  blockId?: string,
): Promise<EnergyLog> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();

  const log: EnergyLog = {
    id,
    chatId,
    timestamp: now,
    level,
    context,
    blockId,
    createdAt: now,
  };

  await redis.set(ENERGY_LOG_KEY(chatId, id), JSON.stringify(log), { ex: ENERGY_LOG_TTL });
  await redis.sadd(ENERGY_LOGS_SET_KEY(chatId, todayKey), id);
  await redis.expire(ENERGY_LOGS_SET_KEY(chatId, todayKey), ENERGY_LOG_TTL);

  // Update energy pattern
  await updateEnergyPattern(chatId, log);

  return log;
}

export async function getEnergyLogsForDay(
  chatId: number,
  date?: string,
): Promise<EnergyLog[]> {
  const redis = getClient();
  const dateKey = date || getTodayKey();
  const logIds = await redis.smembers<string[]>(ENERGY_LOGS_SET_KEY(chatId, dateKey));

  if (!logIds || logIds.length === 0) return [];

  const logs: EnergyLog[] = [];
  for (const logId of logIds) {
    const data = await redis.get<string>(ENERGY_LOG_KEY(chatId, logId));
    if (data) {
      const log = typeof data === "string" ? JSON.parse(data) : data;
      logs.push(log);
    }
  }

  return logs.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getLatestEnergyLog(chatId: number): Promise<EnergyLog | null> {
  const logs = await getEnergyLogsForDay(chatId);
  if (logs.length === 0) return null;
  return logs[logs.length - 1];
}

// ==========================================
// V2: Energy Pattern Operations
// ==========================================

export async function getEnergyPattern(chatId: number): Promise<EnergyPattern> {
  const redis = getClient();
  const data = await redis.get<string>(ENERGY_PATTERN_KEY(chatId));

  if (!data) {
    // Return empty pattern
    return {
      chatId,
      hourlyAverages: {},
      dayOfWeekAverages: {},
      blockAverages: {},
      taskTypeSuccessRates: {},
      lastUpdated: Date.now(),
      dataPoints: 0,
    };
  }

  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function saveEnergyPattern(
  chatId: number,
  pattern: EnergyPattern,
): Promise<void> {
  const redis = getClient();
  pattern.lastUpdated = Date.now();
  await redis.set(ENERGY_PATTERN_KEY(chatId), JSON.stringify(pattern));
}

// Exponential moving average for learning
function exponentialMovingAverage(
  current: number | undefined,
  newValue: number,
  alpha: number = 0.1,
): number {
  if (current === undefined) return newValue;
  return alpha * newValue + (1 - alpha) * current;
}

export async function updateEnergyPattern(
  chatId: number,
  log: EnergyLog,
): Promise<void> {
  const pattern = await getEnergyPattern(chatId);

  // Update hourly average
  const hour = new Date(log.timestamp).getHours();
  pattern.hourlyAverages[hour] = exponentialMovingAverage(
    pattern.hourlyAverages[hour],
    log.level,
    0.1,
  );

  // Update day-of-week average
  const dayNames: DayOfWeek[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayOfWeek = dayNames[new Date(log.timestamp).getDay()];
  pattern.dayOfWeekAverages[dayOfWeek] = exponentialMovingAverage(
    pattern.dayOfWeekAverages[dayOfWeek],
    log.level,
    0.1,
  );

  // Update block average if applicable
  if (log.blockId) {
    pattern.blockAverages[log.blockId] = exponentialMovingAverage(
      pattern.blockAverages[log.blockId],
      log.level,
      0.15,
    );
  }

  pattern.dataPoints++;

  await saveEnergyPattern(chatId, pattern);
}

export function predictEnergy(
  pattern: EnergyPattern,
  hour: number,
  dayOfWeek: DayOfWeek,
  blockId?: string,
): number {
  const hourWeight = 0.4;
  const dayWeight = 0.3;
  const blockWeight = blockId && pattern.blockAverages[blockId] ? 0.3 : 0;

  let prediction =
    (pattern.hourlyAverages[hour] || 3) * hourWeight +
    (pattern.dayOfWeekAverages[dayOfWeek] || 3) * dayWeight;

  if (blockId && pattern.blockAverages[blockId]) {
    prediction += pattern.blockAverages[blockId] * blockWeight;
  } else {
    // Normalize if no block weight
    prediction = prediction / (hourWeight + dayWeight);
  }

  return Math.round(prediction * 10) / 10;
}

// ==========================================
// V2: Captured Item Operations
// ==========================================

const CAPTURED_TTL = 24 * 60 * 60; // 24 hours

export async function createCapturedItem(
  chatId: number,
  rawContent: string,
  source: "text" | "voice",
  extractedTasks?: ExtractedTask[],
): Promise<CapturedItem> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();

  const item: CapturedItem = {
    id,
    chatId,
    rawContent,
    source,
    extractedTasks,
    processingStatus: extractedTasks ? "processed" : "pending",
    createdAt: now,
    processedAt: extractedTasks ? now : undefined,
  };

  await redis.set(CAPTURED_KEY(chatId, id), JSON.stringify(item), { ex: CAPTURED_TTL });
  await redis.sadd(CAPTURED_PENDING_KEY(chatId), id);
  await redis.expire(CAPTURED_PENDING_KEY(chatId), CAPTURED_TTL);

  return item;
}

export async function getCapturedItem(
  chatId: number,
  capturedId: string,
): Promise<CapturedItem | null> {
  const redis = getClient();
  const data = await redis.get<string>(CAPTURED_KEY(chatId, capturedId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateCapturedItem(item: CapturedItem): Promise<void> {
  const redis = getClient();
  await redis.set(CAPTURED_KEY(item.chatId, item.id), JSON.stringify(item), { ex: CAPTURED_TTL });
}

export async function getPendingCapturedItems(chatId: number): Promise<CapturedItem[]> {
  const redis = getClient();
  const itemIds = await redis.smembers<string[]>(CAPTURED_PENDING_KEY(chatId));

  if (!itemIds || itemIds.length === 0) return [];

  const items: CapturedItem[] = [];
  for (const itemId of itemIds) {
    const item = await getCapturedItem(chatId, itemId);
    if (item && item.processingStatus === "pending") {
      items.push(item);
    }
  }

  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function clearCapturedItem(
  chatId: number,
  capturedId: string,
): Promise<void> {
  const redis = getClient();
  await redis.srem(CAPTURED_PENDING_KEY(chatId), capturedId);
  await redis.del(CAPTURED_KEY(chatId, capturedId));
}

// ==========================================
// V2: Block-Task Assignment
// ==========================================

export async function assignTaskToBlock(
  chatId: number,
  taskId: string,
  blockId: string,
  date?: string,
): Promise<void> {
  const redis = getClient();
  const dateKey = date || getTodayKey();

  await redis.sadd(BLOCK_TASKS_KEY(chatId, blockId, dateKey), taskId);
  // Set TTL to end of day + 1 day buffer
  await redis.expire(BLOCK_TASKS_KEY(chatId, blockId, dateKey), 2 * 24 * 60 * 60);
}

export async function getTasksForBlock(
  chatId: number,
  blockId: string,
  date?: string,
): Promise<string[]> {
  const redis = getClient();
  const dateKey = date || getTodayKey();

  const taskIds = await redis.smembers<string[]>(BLOCK_TASKS_KEY(chatId, blockId, dateKey));
  return taskIds || [];
}

export async function removeTaskFromBlock(
  chatId: number,
  taskId: string,
  blockId: string,
  date?: string,
): Promise<void> {
  const redis = getClient();
  const dateKey = date || getTodayKey();

  await redis.srem(BLOCK_TASKS_KEY(chatId, blockId, dateKey), taskId);
}
