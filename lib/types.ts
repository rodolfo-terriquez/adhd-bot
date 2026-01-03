// Telegram types
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// Intent types from Claude
export type Intent =
  // V1 intents
  | ReminderIntent
  | MultipleRemindersIntent
  | ReminderWithListIntent
  | BrainDumpIntent
  | InboxIntent
  | MarkDoneIntent
  | CancelTaskIntent
  | CancelMultipleTasksIntent
  | ListTasksIntent
  | CreateListIntent
  | ShowListsIntent
  | ShowListIntent
  | ModifyListIntent
  | DeleteListIntent
  | ConversationIntent
  | CheckinResponseIntent
  | SetCheckinTimeIntent
  | SetMorningReviewTimeIntent
  // V2 intents
  | CaptureIntent
  | ConfirmExtractionIntent
  | DecomposeTaskIntent
  | ShowBlocksIntent
  | ShowBlockIntent
  | AssignBlockIntent
  | ModifyBlockIntent
  | BlockTransitionIntent
  | EnergyLogIntent
  | EnergyMatchIntent
  | LowEnergyModeIntent
  | ShowEnergyPatternsIntent
  | EnergyObservationIntent
  | VacationModeIntent
  | WeeklyPlanningIntent
  | DayPlanningIntent
  | BatchTasksIntent
  | ContextTagIntent
  | FilterByContextIntent
  // Habit intents
  | CreateHabitIntent
  | ListHabitsIntent
  | DeleteHabitIntent
  | PauseHabitIntent
  | CompleteHabitIntent
  | MoveHabitToBlockIntent
  | SetHabitPreferredBlockIntent;

// parseIntent can return single intent or multiple intents
export type ParsedIntents = Intent | Intent[];

export interface ReminderIntent {
  type: "reminder";
  task: string;
  delayMinutes: number;
  isImportant: boolean;
  isDayOnly?: boolean; // True for day-only reminders (no specific time)
}

export interface ReminderItem {
  task: string;
  delayMinutes: number;
  isImportant: boolean;
  isDayOnly?: boolean; // True for day-only reminders (no specific time)
}

export interface MultipleRemindersIntent {
  type: "multiple_reminders";
  reminders: ReminderItem[];
}

export interface BrainDumpIntent {
  type: "brain_dump";
  content: string;
}

export type DayTag =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface InboxIntent {
  type: "inbox";
  item: string;
  dayTag?: DayTag;
}

export interface MarkDoneIntent {
  type: "mark_done";
  taskDescription?: string;
}

export interface CancelTaskIntent {
  type: "cancel_task";
  taskDescription?: string;
}

export interface CancelMultipleTasksIntent {
  type: "cancel_multiple_tasks";
  taskDescriptions: string[];
}

export interface ListTasksIntent {
  type: "list_tasks";
}

export interface ConversationIntent {
  type: "conversation";
  message: string; // The user's message or topic to respond to
}

export interface CheckinResponseIntent {
  type: "checkin_response";
  rating: number;
  notes?: string;
}

export interface SetCheckinTimeIntent {
  type: "set_checkin_time";
  hour: number;
  minute: number;
}

export interface SetMorningReviewTimeIntent {
  type: "set_morning_review_time";
  hour: number;
  minute: number;
}

// List intent types
export interface ReminderWithListIntent {
  type: "reminder_with_list";
  task: string;
  listName: string;
  items: string[];
  delayMinutes: number;
  isImportant: boolean;
  isDayOnly?: boolean;
}

export interface CreateListIntent {
  type: "create_list";
  name: string;
  items: string[];
}

export interface ShowListsIntent {
  type: "show_lists";
}

export interface ShowListIntent {
  type: "show_list";
  listDescription?: string;
}

export interface ModifyListIntent {
  type: "modify_list";
  listDescription?: string;
  action:
    | "add_items"
    | "remove_items"
    | "check_items"
    | "uncheck_items"
    | "rename";
  items?: string[];
  newName?: string;
}

export interface DeleteListIntent {
  type: "delete_list";
  listDescription?: string;
}

// Data models for Redis
export interface Task {
  id: string;
  chatId: number;
  content: string;
  isImportant: boolean;
  naggingLevel: number;
  nextReminder: number;
  qstashMessageId?: string;
  linkedListId?: string;
  isDayOnly?: boolean; // True for day-only reminders (no notification, just shows in morning review)
  createdAt: number;
  status: "pending" | "completed";
}

export interface ListItem {
  id: string;
  content: string;
  isChecked: boolean;
  createdAt: number;
}

export interface List {
  id: string;
  chatId: number;
  name: string;
  items: ListItem[];
  linkedTaskId?: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "completed";
}

export interface BrainDump {
  id: string;
  chatId: number;
  content: string;
  createdAt: number;
}

// QStash notification payload
export interface NotificationPayload {
  chatId: number;
  taskId: string;
  blockId?: string; // For block-related notifications
  type:
    | "reminder"
    | "nag"
    | "daily_checkin"
    | "weekly_summary"
    | "follow_up"
    | "end_of_day"
    | "morning_review"
    // V2 block notifications
    | "block_start"
    | "block_end"
    | "energy_check";
}

// Daily check-in data
export interface CheckIn {
  id: string;
  chatId: number;
  date: string; // YYYY-MM-DD
  rating: number; // 1-5 scale
  notes?: string;
  createdAt: number;
}

// User preferences for check-in scheduling
export interface UserPreferences {
  chatId: number;
  checkinTime: string; // "HH:MM" format, default "20:00"
  morningReviewTime: string; // "HH:MM" format, default "08:00"
  checkinScheduleId?: string;
  weeklySummaryScheduleId?: string;
  endOfDayScheduleId?: string;
  morningReviewScheduleId?: string;

  // V2 fields
  defaultBlocks?: string[]; // IDs of default activity blocks
  autoExtractTasks?: boolean; // default: true
  confirmBreakdowns?: boolean; // default: true
  confirmScheduling?: boolean; // default: true
  energyCheckFrequency?: "per_block" | "morning_evening" | "manual";
  transitionNudges?: boolean;
  weeklyPlanningDay?: DayOfWeek; // default: sunday
  weeklyPlanningTime?: string; // "HH:MM" format
  preferredTaskBatchSize?: number; // default: 3
  lowEnergyMode?: boolean;
  learningEnabled?: boolean; // default: true
  vacationMode?: boolean; // Pauses all block notifications
  vacationUntil?: number; // Auto-resume timestamp
}

// ==========================================
// V2 Data Models
// ==========================================

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type EnergyLevel = "high" | "medium" | "low" | "variable";

// Activity blocks that structure the day
export interface ActivityBlock {
  id: string;
  chatId: number;
  name: string; // "Morning routine", "Focus time"
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  days: DayOfWeek[]; // Which days this block applies
  energyProfile: EnergyLevel; // Expected energy level during this block
  taskCategories: string[]; // ["admin", "creative", "errands"]
  flexLevel: "fixed" | "flexible" | "soft"; // How strictly to enforce timing
  isDefault: boolean; // System-provided vs user-created
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
}

// Track energy throughout the day
export interface EnergyLog {
  id: string;
  chatId: number;
  timestamp: number;
  level: 1 | 2 | 3 | 4 | 5; // 1 = exhausted, 5 = energized
  context?: string; // "just woke up", "after lunch"
  blockId?: string; // Which block they were in when logged
  createdAt: number;
}

// Learned patterns about user's energy
export interface EnergyPattern {
  chatId: number;
  hourlyAverages: Record<number, number>; // hour (0-23) -> avg energy
  dayOfWeekAverages: Partial<Record<DayOfWeek, number>>;
  blockAverages: Record<string, number>; // blockId -> avg
  taskTypeSuccessRates: Record<string, Record<string, number>>; // task type -> energy -> completion rate
  lastUpdated: number;
  dataPoints: number;
}

// Recurring habits
export interface Habit {
  id: string;
  chatId: number;
  name: string; // "Meditate", "Exercise"
  description?: string; // Optional longer description
  days: DayOfWeek[]; // ["monday", "wednesday", "friday"]
  preferredBlockId?: string; // Block to auto-assign to
  energyRequired?: EnergyLevel; // For block matching if no preferred block
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
}

// Habit completion record
export interface HabitCompletion {
  id: string;
  habitId: string;
  chatId: number;
  date: string; // "YYYY-MM-DD"
  completedAt: number; // Timestamp
}

// Raw unprocessed input before task extraction
export interface CapturedItem {
  id: string;
  chatId: number;
  rawContent: string;
  source: "text" | "voice";
  extractedTasks?: ExtractedTask[];
  processingStatus: "pending" | "processed" | "confirmed" | "rejected";
  createdAt: number;
  processedAt?: number;
}

export interface ExtractedTask {
  content: string;
  suggestedEnergyLevel?: EnergyLevel;
  suggestedContextTags?: string[]; // @home, @computer, @errands
  suggestedDecomposition?: string[]; // Subtasks for complex items
  confidence: number; // 0-1
}

// V2 Task fields (extends existing Task)
export interface TaskV2 extends Task {
  energyRequired?: EnergyLevel;
  contextTags?: string[]; // @home, @computer, @errands, @phone
  parentTaskId?: string; // For decomposition
  childTaskIds?: string[];
  blockAssignment?: string; // Assigned block ID
  estimatedMinutes?: number;
  actualMinutes?: number; // Tracked after completion
  source?: "manual" | "extracted" | "recurring";
  decompositionLevel?: number; // 0 = top-level
  snoozeCount?: number;
}

// ==========================================
// V2 Intent Types
// ==========================================

// Capture intents
export interface CaptureIntent {
  type: "capture";
  rawContent: string;
}

export interface ConfirmExtractionIntent {
  type: "confirm_extraction";
  capturedItemId: string;
  acceptedTaskIndices: number[];
  rejectedTaskIndices?: number[];
  modifications?: Record<number, Partial<ExtractedTask>>;
}

export interface DecomposeTaskIntent {
  type: "decompose_task";
  taskDescription?: string;
  suggestedSubtasks?: string[];
}

// Block intents
export interface ShowBlocksIntent {
  type: "show_blocks";
}

export interface ShowBlockIntent {
  type: "show_block";
  blockName?: string;
}

export interface AssignBlockIntent {
  type: "assign_block";
  taskDescription: string;
  blockName: string;
}

export interface ModifyBlockIntent {
  type: "modify_block";
  blockName: string;
  action: "create" | "edit" | "delete" | "pause" | "resume";
  changes?: Partial<ActivityBlock>;
}

export interface BlockTransitionIntent {
  type: "block_transition";
  action: "start" | "end" | "skip" | "extend";
  blockName?: string;
  extensionMinutes?: number;
}

// Energy intents
export interface EnergyLogIntent {
  type: "energy_log";
  level: 1 | 2 | 3 | 4 | 5;
  context?: string;
}

export interface EnergyMatchIntent {
  type: "energy_match";
  currentEnergy?: EnergyLevel;
}

export interface LowEnergyModeIntent {
  type: "low_energy_mode";
  enabled: boolean;
}

export interface ShowEnergyPatternsIntent {
  type: "show_energy_patterns";
}

// Implicit energy observation from conversation (e.g., "I feel energized in the evenings")
export interface EnergyObservationIntent {
  type: "energy_observation";
  timeOfDay?: "morning" | "midday" | "afternoon" | "evening" | "night";
  dayOfWeek?: DayOfWeek;
  energyLevel: "high" | "medium" | "low";
  isPattern: boolean; // true if user says "usually", "always", "tend to" vs current state
  originalMessage: string; // Keep the original for context
}

// Vacation mode intent
export interface VacationModeIntent {
  type: "vacation_mode";
  action: "start" | "end";
  until?: string; // Date string for auto-resume
}

// Planning intents
export interface WeeklyPlanningIntent {
  type: "weekly_planning";
  action: "start" | "continue" | "complete" | "skip";
}

export interface DayPlanningIntent {
  type: "day_planning";
  action: "start" | "review" | "adjust";
}

export interface BatchTasksIntent {
  type: "batch_tasks";
  taskDescriptions?: string[];
  autoDetect?: boolean;
}

// Context tag intents
export interface ContextTagIntent {
  type: "context_tag";
  taskDescription?: string;
  action: "add" | "remove";
  tags: string[];
}

export interface FilterByContextIntent {
  type: "filter_by_context";
  tags: string[];
  showOnly?: boolean;
}

// Habit intents
export interface CreateHabitIntent {
  type: "create_habit";
  name: string;
  days: DayOfWeek[] | "daily" | "weekdays" | "weekends";
  preferredBlock?: string; // "morning", "evening", block name
}

export interface ListHabitsIntent {
  type: "list_habits";
}

export interface DeleteHabitIntent {
  type: "delete_habit";
  habitName: string;
}

export interface PauseHabitIntent {
  type: "pause_habit";
  habitName: string;
  pause: boolean; // true = pause, false = resume
}

export interface CompleteHabitIntent {
  type: "complete_habit";
  habitName: string;
}

export interface MoveHabitToBlockIntent {
  type: "move_habit_to_block";
  habitName: string;
  blockName: string;
}

export interface SetHabitPreferredBlockIntent {
  type: "set_habit_preferred_block";
  habitName: string;
  blockName: string | null; // null to clear preferred block
}

// ==========================================
// Agent Loop Types (Agentic Architecture)
// ==========================================

export interface AgentConfig {
  maxIterations: number;
  maxTokens: number;
  model: string;
}

// OpenAI function calling format
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
        items?: { type: string };
      }>;
      required: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
