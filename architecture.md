# Telegram Bot Architecture

## Overview

This is a Telegram bot designed to help users with ADHD manage tasks, reminders, and thoughts. It's built as a serverless application running on Vercel, using Upstash Redis for storage and QStash for scheduled notifications.

**Key Characteristics:**
- Serverless architecture (Vercel Functions)
- Event-driven (webhooks + scheduled tasks)
- **Agentic loop architecture** - LLM executes tools iteratively to handle multi-step requests
- Conversational AI with personality (Mika - a friendly cat-girl companion)
- 22 tools for reading and modifying user data
- Persistent storage with Redis
- Scheduled reminders with escalation

---

## System Architecture

```
┌─────────────────┐
│  Telegram User  │
└────────┬────────┘
         │ (webhook POST)
         ↓
┌─────────────────────────────────────────────┐
│          Vercel Serverless Functions        │
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │   /api/telegram (webhook handler)    │  │
│  │  - Receives user messages            │  │
│  │  - Transcribes voice messages        │  │
│  │  - Parses intent via LLM             │  │
│  │  - Manages conversation history      │  │
│  │  - Schedules reminders               │  │
│  └──────────────┬───────────────────────┘  │
│                 │                           │
│  ┌──────────────┴───────────────────────┐  │
│  │   /api/notify (QStash callbacks)     │  │
│  │  - Handles scheduled notifications   │  │
│  │  - Sends reminders/nags              │  │
│  │  - Daily check-ins                   │  │
│  │  - Weekly summaries                  │  │
│  │  - Morning reviews                   │  │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │   /api/setup (webhook configuration) │  │
│  │  - Sets Telegram webhook URL         │  │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │   /api/health (health check)         │  │
│  │  - Returns service status            │  │
│  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
         │                    │
         │                    │
    ┌────┴────┐         ┌─────┴──────┐
    │  Redis  │         │   QStash   │
    │ (State) │         │ (Scheduler)│
    └─────────┘         └────────────┘
         ↑                     ↓
         │              (scheduled POST)
         │                     │
         └─────────────────────┘

External Services:
- OpenRouter API (LLM - intent parsing & responses)
- OpenAI Whisper API (voice transcription)
- Telegram Bot API (messaging)
- Braintrust (LLM tracing/observability)
```

---

## Core Components

### 1. API Endpoints (`/api`)

#### `/api/telegram.ts` (Main Webhook Handler)
**Trigger:** POST from Telegram when user sends message
**Flow:**
1. Validates user authorization (if ALLOWED_USERS is set)
2. Registers new users and sets up default schedules + activity blocks
3. Handles voice messages:
   - Downloads audio file from Telegram
   - Transcribes using OpenAI Whisper
   - Shows transcription to user
4. Cancels any pending follow-ups (user has responded)
5. **Runs agent loop** - LLM iteratively executes tools until ready to respond
6. Saves conversation to Redis
7. Returns 200 OK to Telegram

**Agent Loop (replaces intent-based architecture):**
The bot now uses an agentic loop where the LLM can execute tools iteratively:

```
User: "Cancel my dentist task"
→ Agent calls search_reminders({query: "dentist"})
→ Agent receives: [{id: "abc123", content: "Dentist appointment"}]
→ Agent calls cancel_reminder({task_id: "abc123"})
→ Agent receives: {success: true}
→ Agent responds: "Done! I've cancelled your dentist appointment."
```

This allows handling multi-step operations where the LLM needs to gather context before acting.

#### `/api/notify.ts` (QStash Callback Handler)
**Trigger:** POST from QStash at scheduled times
**Flow:**
1. Verifies QStash signature
2. Routes to handler based on notification type
3. Returns 200 OK to QStash

**Notification Types:**
- `reminder` - Initial task reminder
  - Generates LLM reminder message
  - Schedules follow-up in 5-10 minutes
  - If important, schedules first nag
- `nag` - Escalating reminder for important tasks
  - Generates contextual nag message
  - Schedules next nag with increasing delay (1hr → 2hr → 4hr → 6hr → 8hr)
  - Stops at level 5 with final message
- `follow_up` - Gentle nudge after reminder (if no response)
  - Only sends if user hasn't responded
  - Clears pending follow-up state
- `daily_checkin` - Evening check-in prompt
  - Asks user to rate day (1-5)
  - Marks awaiting check-in state
- `weekly_summary` - Sunday evening insights
  - Aggregates check-ins, brain dumps, completed tasks
  - Generates LLM insights
- `end_of_day` - Midnight message
  - Asks if user wants to remember anything for tomorrow
- `morning_review` - Morning briefing
  - Shows today's scheduled tasks (both day-only and timed reminders)
  - Shows general inbox items
  - Shows overdue tasks
  - Suggests scheduling or dropping items

#### `/api/setup.ts` (Webhook Setup)
**Trigger:** GET request (browser or curl)
**Purpose:** Configures Telegram webhook URL to point to this deployment
**Usage:** Visit `https://your-app.vercel.app/api/setup?url=https://your-app.vercel.app`

#### `/api/health.ts` (Health Check)
**Trigger:** GET request
**Purpose:** Returns service status and environment variable checks

#### `/api/index.ts` (Landing Page)
**Trigger:** GET request to root
**Purpose:** Displays HTML landing page with bot info

---

### 2. Library Modules (`/lib`)

#### `types.ts`
Defines all TypeScript interfaces and types:
- Telegram types (messages, updates, users)
- Intent types (15+ different intents)
- Data models (Task, List, BrainDump, CheckIn, UserPreferences)
- Notification payloads
- Conversation history types

#### `redis.ts`
**Purpose:** Data persistence layer using Upstash Redis
**Key Functions:**

**Tasks:**
- `createTask()` - Stores new task with reminder time and isDayOnly flag
- `getTask()` - Retrieves task by ID
- `updateTask()` - Updates task state
- `completeTask()` - Marks task done, increments daily counter
- `deleteTask()` - Removes task
- `getPendingTasks()` - Gets all pending tasks sorted by reminder time
- `findTaskByDescription()` - Fuzzy search with metadata normalization
- `findTasksByDescriptions()` - Fuzzy search for multiple tasks
- `getOverdueTasks()` - Gets tasks past reminder time
- `getTodaysTasks()` - Gets tasks scheduled for today (00:00-23:59)

**Lists:**
- `createList()` - Creates checklist with items
- `getList()` - Retrieves list by ID
- `updateList()` - Updates list
- `deleteList()` - Removes list
- `getActiveLists()` - Gets all active lists
- `findListByDescription()` - Fuzzy search for list
- `addListItems()` - Adds items to list
- `removeListItems()` - Removes items from list
- `checkListItems()` - Checks/unchecks items
- `renameList()` - Renames list
- `completeList()` - Marks list complete

**Inbox (special list):**
- `getOrCreateInbox()` - Gets or creates "Inbox" list
- `addToInbox()` - Adds item with optional day tag (@monday, @tuesday, etc.)
- `getUncheckedInboxItems()` - Gets unchecked inbox items
- `getInboxItemsForDay()` - Gets items tagged for specific day

**Brain Dumps:**
- `createBrainDump()` - Stores thought/note
- `getTodaysDumps()` - Gets today's brain dumps
- `getDumpsByDate()` - Gets dumps for specific date
- `getWeeklyDumps()` - Gets last 7 days of dumps

**Check-ins:**
- `saveCheckIn()` - Stores daily rating and notes
- `getCheckIn()` - Gets check-in for specific date
- `getWeeklyCheckIns()` - Gets last 7 days of check-ins
- `getWeeklyCompletedTaskCount()` - Counts completed tasks this week

**User Preferences:**
- `getUserPreferences()` - Gets user's schedule preferences
- `saveUserPreferences()` - Saves schedule preferences
- `setCheckinTime()` - Updates check-in time

**Conversation Memory:**
- `getConversationData()` - Gets messages + summary
- `addToConversation()` - Appends user/assistant pair
- `clearConversation()` - Resets conversation
- `setSummarizationCallback()` - Registers LLM summarization function

**Key Patterns:**
- Automatic summarization: When conversation reaches 30 message pairs, oldest 20 pairs are summarized and replaced with summary text, keeping 10 most recent pairs verbatim
- TTL management: Brain dumps expire in 30 days, check-ins in 90 days
- Set-based indexing: Uses Redis sets for O(1) membership checks

#### `agent.ts` (NEW - Agentic Loop)
**Purpose:** Core agent loop that processes user messages
**Key Function:**
- `runAgentLoop()` - Main entry point for processing user messages
  - Takes user message + conversation context
  - Builds system prompt with Mika personality + tool instructions
  - Loops: call LLM → execute tools → feed results back
  - Terminates when LLM returns text without tool calls
  - Returns final response string

**Safeguards:**
- Max 10 iterations
- 25 second timeout (buffer before Vercel timeout)
- Max 3 consecutive tool errors → graceful exit

#### `tools.ts` (NEW - Tool Definitions & Executors)
**Purpose:** Defines 30 tools available to the agent
**Tool Categories:**

**Read Tools (context gathering):**
- `list_reminders` - Get all pending tasks
- `search_reminders` - Find tasks by description
- `list_lists` - Get all user lists
- `get_list_items` - Get items in a specific list
- `get_habits` - Get habits with today's status
- `get_energy_patterns` - Get learned energy patterns
- `get_current_time` - Get time in user's timezone
- `get_blocks` - Get all activity blocks with tasks/habits assigned (auto-initializes defaults if none exist)
- `get_body_doubling_status` - Get current body doubling session status

**Write Tools (state changes):**
- `create_reminder` - Create task + schedule QStash
- `complete_reminder` - Mark task done
- `cancel_reminder` - Delete task + cancel QStash
- `add_to_inbox` - Add item to inbox
- `create_list` - Create new list
- `modify_list` - Add/remove/check items
- `delete_list` - Delete list
- `create_habit` - Create recurring habit
- `complete_habit` - Mark habit done for today
- `delete_habit` - Delete habit
- `log_energy` - Log energy level
- `save_brain_dump` - Save a note
- `save_checkin` - Save daily check-in
- `start_body_doubling` - Start a focus session with periodic check-ins
- `update_body_doubling_focus` - Change focus task during active session
- `end_body_doubling` - End the current body doubling session
- `create_block` - Create a new activity block
- `modify_block` - Rename, change time/duration, or update days/energy profile
- `delete_block` - Delete an activity block

Each tool has:
- OpenAI function definition (name, description, parameters)
- Executor function that calls existing Redis/QStash operations

#### `llm.ts`
**Purpose:** All LLM interactions (OpenRouter API)
**Configuration:**
- Configurable model
- Custom parameters (temperature, reasoning)
- Timezone-aware prompts
- Conversation context injection
- Braintrust tracing

**Key Functions:**

**Agent Support:**
- `callLLMWithTools()` - LLM call with tool definitions for agentic loop
  - Returns tool calls or text response
  - Used by agent.ts for iterative processing

**Message Generation:**
- `generateReminderMessage()` - First reminder notification
- `generateNaggingMessage()` - Escalating reminder (levels 0-4)
- `generateFinalNagMessage()` - Last nag before stopping
- `generateFollowUpMessage()` - Brief nudge after no response
- `generateCheckinPrompt()` - Daily check-in request
- `generateEndOfDayMessage()` - Evening reflection prompt
- `generateMorningReviewMessage()` - Morning briefing
- `generateWeeklyInsights()` - Sunday summary with patterns
- `generateConversationSummary()` - Summarizes old messages

**Mika Personality:**
All LLM calls inject the "Mika" personality:
- Warm, patient, genuinely curious
- Cares about user wellbeing, not productivity
- Short conversational style
- Soft nudges, not commands
- Small celebrations
- Never uses em dashes (formatting quirk)
- Uses 🐾 emoji naturally

**Context Handling:**
Every LLM call receives:
1. Current timestamp and timezone
2. Tama personality prompt
3. Conversation summary (if exists)
4. Recent messages (up to 10)
5. Task-specific prompt

#### `telegram.ts`
**Purpose:** Telegram Bot API wrapper
**Key Functions:**
- `sendMessage()` - Sends text message (tries Markdown first, falls back to plain)
- `getFilePath()` - Gets file path for voice message
- `downloadFile()` - Downloads file from Telegram
- `setWebhook()` - Configures webhook URL
- `sendDocument()` - Sends file (used for debug exports)
- `formatScheduledTime()` - Formats task time as "@day [time]"
  - Day-only reminders: "@tuesday" (no time)
  - Timed reminders: "@tuesday 3:00 PM"

#### `whisper.ts`
**Purpose:** OpenAI Whisper API wrapper for voice transcription
**Key Function:**
- `transcribeAudio()` - Converts audio buffer (OGG format) to text

#### `qstash.ts`
**Purpose:** Upstash QStash wrapper for scheduling
**Key Functions:**
- `scheduleReminder()` - One-time delayed notification
- `scheduleDailyCheckin()` - Daily cron at user's time
- `scheduleWeeklySummary()` - Sunday cron at user's time
- `scheduleEndOfDay()` - Daily midnight cron
- `scheduleMorningReview()` - Daily morning cron at user's time
- `scheduleFollowUp()` - Random 5-10 min delay for natural feel
- `deleteSchedule()` - Removes recurring schedule
- `cancelScheduledMessage()` - Cancels one-time message
- `verifySignature()` - Validates QStash webhook signature

**Timezone Handling:**
All cron expressions are prefixed with `CRON_TZ={timezone}` for user-specific timing

---

## Data Flow

### User Sends Message (Agentic Loop)
```
1. User → Telegram API
2. Telegram API → /api/telegram (webhook)
3. /api/telegram:
   a. If voice: Download → Whisper → Transcribe
   b. Load conversation history from Redis
   c. Run agent loop:
      - LLM decides: need more info? → call read tool
      - LLM decides: perform action? → call write tool
      - Tool results fed back to LLM
      - Loop continues until LLM responds with text
   d. Save conversation to Redis
4. /api/telegram → Telegram API → User

Example: "Reschedule my dentist to Monday"
  Loop 1: LLM calls search_reminders({query: "dentist"})
  Loop 2: LLM calls cancel_reminder({id: "..."}) + create_reminder({...monday})
  Loop 3: LLM responds: "Done! Moved your dentist appointment to Monday."
```

### Scheduled Reminder Fires
```
1. QStash → /api/notify (at scheduled time)
2. /api/notify:
   a. Load task from Redis
   b. Check if still pending (not completed)
   c. Load conversation context from Redis
   d. Generate reminder via LLM
   e. Send via Telegram API
   f. Schedule follow-up (5-10 min)
   g. If important: Schedule next nag (escalating delay)
   h. Update task in Redis
3. /api/notify → QStash (200 OK)
```

### User Marks Task Done
```
1. User says "done" → /api/telegram
2. /api/telegram:
   a. Parse intent: mark_done
   b. Find matching task in Redis (fuzzy search)
   c. Cancel scheduled QStash message
   d. Complete task in Redis
   e. Increment daily completion counter
   f. If linked list: Complete list too
   g. Generate confirmation via LLM
   h. Send to user
   i. Save conversation to Redis
```

### Daily Check-in
```
1. QStash → /api/notify (8 PM daily)
2. /api/notify:
   a. Load conversation context
   b. Generate check-in prompt via LLM
   c. Send to user
   d. Mark "awaiting check-in" in Redis
3. User replies with rating → /api/telegram
4. /api/telegram:
   a. Parse intent: checkin_response
   b. Extract rating (1-5) and notes
   c. Save check-in to Redis
   d. Clear "awaiting check-in" flag
   e. Generate response via LLM
   f. Send confirmation
```

### Morning Review
```
1. QStash → /api/notify (8 AM daily)
2. /api/notify:
   a. Load from Redis:
      - Today's scheduled tasks (00:00-23:59, includes day-only and timed)
      - All unchecked inbox items (general tasks)
      - Overdue tasks
   b. Load conversation context
   c. Format task times:
      - Day-only: "anytime"
      - Timed: "3:00 PM"
   d. Generate review message via LLM
   e. Send to user
```

---

## Key Design Patterns

### 1. Agentic Loop Architecture
User messages are processed through an iterative tool-calling loop:
- LLM can call read tools to gather context before acting
- LLM can call multiple write tools to perform complex operations
- Loop continues until LLM is ready to respond with text
- Handles multi-step operations naturally (e.g., "reschedule X to Y" = search → cancel → create)

### 2. Conversation Context Injection
Every LLM call receives conversation history and summary, allowing coherent multi-turn conversations without re-explaining context.

### 3. Lazy Summarization
Conversations are automatically summarized when they grow too large (30 pairs), keeping recent messages verbatim for accuracy while compressing older context.

### 4. Follow-up Pattern
After sending a reminder, the bot schedules a gentle follow-up (5-10 min later) in case the user doesn't respond. If the user does respond, the follow-up is cancelled.

### 5. Escalating Reminders
Important tasks trigger a nagging schedule with increasing delays (1h → 2h → 4h → 6h → 8h), stopping at level 5 to avoid annoyance.

### 6. Fuzzy Matching with Metadata Normalization
Task and list lookups use fuzzy string matching (substring, word-based) to handle imprecise user references. The `stripSchedulingMetadata()` function normalizes both search queries and stored content by:
- Removing scheduling metadata ("@sunday 2:29 PM", "(overdue)", "(important)")
- Normalizing apostrophes and whitespace
- Case-insensitive matching
This allows matching "Lili has appointment" against "Lili has appointment on Tuesday @sunday 2:29 PM (overdue)".

### 7. Day-Only vs Timed Reminders
Reminders have two modes controlled by the `isDayOnly` flag:
- **Day-only** (isDayOnly: true): "Remind me about X on Tuesday"
  - Scheduled to end of day (11:59 PM) for filtering purposes
  - NO QStash notification scheduled
  - Only appears in morning review for that day
  - Displayed as "@tuesday" without time
- **Timed** (isDayOnly: false): "Remind me about X at 3pm"
  - Scheduled to specific time
  - QStash notification sent at that time
  - Also appears in morning review for that day
  - Displayed as "@today 3:00 PM" with time

### 8. Dual-Use Inbox
The "Inbox" is a special list that serves as both:
- A capture inbox for quick thoughts
- General tasks without specific dates

### 9. Personality Consistency
All LLM-generated text uses the same "Tama" personality prompt to maintain consistent tone and style across all interactions.

### 10. Graceful Fallbacks
- Markdown parsing fails → retry without parse_mode
- Intent parsing fails → treat as conversation
- LLM unavailable → use hardcoded fallback messages
- Schedule deletion fails → log and continue

### 11. Serverless Constraints
- 10-second timeout on Vercel → all operations optimized
- Stateless functions → all state in Redis
- No background jobs → QStash handles scheduling

---

## Redis Schema

### Keys

**Tasks:**
- `task:{chatId}:{taskId}` → Task JSON
- `tasks:{chatId}` → Set of task IDs

**Lists:**
- `list:{chatId}:{listId}` → List JSON
- `lists:{chatId}` → Set of list IDs

**Brain Dumps:**
- `dump:{chatId}:{dumpId}` → BrainDump JSON
- `dumps:{chatId}:{date}` → Set of dump IDs for date (TTL: 30 days)

**Check-ins:**
- `checkin:{chatId}:{date}` → CheckIn JSON (TTL: 90 days)
- `checkins:{chatId}` → Set of check-in dates (TTL: 90 days)

**User Preferences:**
- `user_prefs:{chatId}` → UserPreferences JSON

**Conversation:**
- `conversation:{chatId}` → ConversationData JSON (messages + summary)

**State Flags:**
- `awaiting_checkin:{chatId}` → "1" (TTL: 1 hour)
- `pending_follow_up:{chatId}` → PendingFollowUp JSON (TTL: 30 min)

**Counters:**
- `completed:{chatId}:{date}` → Integer (TTL: 8 days)

**Global Sets:**
- `active_chats` → Set of all chat IDs

### Data Structures

**Task:**
```json
{
  "id": "timestamp-random",
  "chatId": 123456,
  "content": "Call dentist",
  "isImportant": true,
  "isDayOnly": false,
  "naggingLevel": 0,
  "nextReminder": 1234567890000,
  "qstashMessageId": "msg_...",
  "linkedListId": "list-id",
  "createdAt": 1234567890000,
  "status": "pending"
}
```

**Note:** `isDayOnly` determines reminder behavior:
- `true`: Only appears in morning review, no notification
- `false`: Sends QStash notification + appears in morning review

**List:**
```json
{
  "id": "timestamp-random",
  "chatId": 123456,
  "name": "Groceries",
  "items": [
    {
      "id": "item-id",
      "content": "Milk",
      "isChecked": false,
      "createdAt": 1234567890000
    }
  ],
  "linkedTaskId": "task-id",
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000,
  "status": "active"
}
```

**ConversationData:**
```json
{
  "messages": [
    {
      "role": "user",
      "content": "Remind me to call mom in 2 hours",
      "timestamp": 1234567890000
    },
    {
      "role": "assistant",
      "content": "Got it, I'll remind you about calling mom in 2 hours.",
      "timestamp": 1234567890000
    }
  ],
  "summary": "User has been setting reminders for family calls...",
  "summaryUpdatedAt": 1234567890000
}
```

---

## Environment Variables

### Required
- `TELEGRAM_BOT_TOKEN` - From @BotFather
- `OPENAI_API_KEY` - For Whisper transcription
- `OPENROUTER_API_KEY` - For LLM access
- `UPSTASH_REDIS_REST_URL` - Redis connection
- `UPSTASH_REDIS_REST_TOKEN` - Redis auth
- `QSTASH_TOKEN` - QStash API token
- `QSTASH_CURRENT_SIGNING_KEY` - Webhook verification
- `QSTASH_NEXT_SIGNING_KEY` - Webhook verification
- `BASE_URL` - Production URL for QStash callbacks

### Optional
- `OPENROUTER_MODEL_CHAT` - Default: "x-ai/grok-3-fast"
- `OPENROUTER_MODEL_INTENT` - Default: same as chat model
- `OPENROUTER_CHAT_PARAMS` - JSON object with API params
- `OPENROUTER_INTENT_PARAMS` - JSON object with API params
- `ALLOWED_USERS` - Comma-separated usernames/IDs
- `USER_TIMEZONE` - Default: "America/Los_Angeles"
- `BRAINTRUST_API_KEY` - For LLM tracing

---

## Limitations & Constraints

1. **Vercel Timeout:** 10 seconds max per function invocation
   - All LLM calls have 20s timeout
   - QStash used for long-running tasks

2. **Single User Focus:**
   - Designed for personal use
   - No multi-user conflict handling
   - Optional allowlist via ALLOWED_USERS

3. **No Push Notifications:**
   - Bot only sends messages via scheduled QStash callbacks
   - Cannot send unsolicited messages outside schedules

4. **Memory Limits:**
   - Conversation summarization at 30 pairs (60 messages)
   - Only 10 most recent messages kept verbatim

5. **Timezone Assumptions:**
   - Single timezone per deployment
   - All users share same timezone setting

6. **No Edit Support:**
   - Cannot edit sent messages
   - All corrections require new messages

7. **Voice Transcription:**
   - Only supports Telegram voice messages (OGG format)
   - English language assumed

---

## Special Features

### 1. Day-Only vs Timed Reminder Detection
The bot distinguishes between day-only and timed reminders:
- "Doctor on Tuesday" → Day-only reminder (isDayOnly: true)
  - Appears in Tuesday's morning review only
  - No notification sent
  - Displayed as "@tuesday"
- "Doctor Tuesday at 3pm" → Timed reminder (isDayOnly: false)
  - Notification sent at 3pm
  - Also appears in Tuesday's morning review
  - Displayed as "@tuesday 3:00 PM"
- "Buy groceries" → Inbox item (no date)
  - Appears in every morning review until checked off

### 2. Debug Command
Send `/debug` to get a markdown file with:
- Current time context
- Tama personality prompt
- Conversation summary
- All recent messages

### 3. List Batching
When user says "Show me my grocery list and packing list", the bot:
- Parses as multiple show_list intents
- Batch processes them
- Returns combined response

### 4. Inbox Integration
When marking tasks done, the bot:
1. First checks scheduled reminders
2. If not found, falls back to checking inbox items
3. Provides unified interface for both

### 5. Smart Follow-ups
After sending a reminder, the bot:
- Waits 5-10 minutes
- Checks if user responded
- Only sends follow-up if no response
- Cancels follow-up when user responds

### 6. List-Task Linking
Reminders can have linked lists:
```
"Remind me to go grocery shopping in 2 hours, I need milk, eggs, and bread"
→ Creates reminder + linked "grocery shopping" list
→ When reminder is marked done, list is auto-completed
```

### 7. Body Doubling
Virtual co-working feature for focus sessions:
- User says "body double with me on [task]" or "help me focus on [task]"
- Bot starts a session with configurable check-in interval (default 25 min)
- Periodic check-ins use LLM to generate natural, varied messages
- User can update focus task mid-session or end with "I'm done"
- Session stats tracked (duration, check-ins) and included in weekly summary

### 8. Activity Blocks
Time-based day organization:
- 6 default blocks: Morning Routine, Focus Time, Midday Break, Afternoon Push, Wind Down, Evening
- Each block has: time range, active days, energy profile (low/medium/high), task categories
- Tasks and habits can be assigned to blocks
- `get_blocks` tool auto-initializes defaults if none exist
- Block start/end notifications available via QStash

---

## Error Handling

### Graceful Degradation
- LLM timeout → hardcoded fallback message
- Markdown parsing error → retry as plain text
- QStash schedule deletion → log and continue
- Redis unavailable → function throws 500

### User-Friendly Errors
- Transcription fails → "couldn't transcribe, try again"
- Timeout → "thinking slowly, try again in a moment"
- Unknown error → "something went wrong, try again"

### Logging
All errors logged to console with context:
- Chat ID
- Error message
- Stack trace
- Function context

---

## Deployment

1. Push to Vercel (auto-deploys from Git)
2. Set environment variables in Vercel dashboard
3. Visit `/api/setup?url=https://your-app.vercel.app`
4. Test with Telegram bot

### Local Development
```bash
npm run dev  # Starts Vercel dev server
```

For local testing with Telegram:
- Use ngrok to expose localhost
- Set webhook to ngrok URL
- Hot reload supported

---

## Future Considerations

1. **Multi-user Support:**
   - Per-user timezones
   - User preferences storage
   - Conflict handling

2. **Rich Formatting:**
   - Inline keyboards for quick actions
   - Buttons for "Done", "Snooze", "Cancel"
   - Calendar pickers for scheduling

3. **Recurring Tasks:**
   - Daily/weekly task templates
   - Habit tracking
   - Streak counters

4. **Integrations:**
   - Google Calendar sync
   - Todoist export
   - Email summaries

5. **Analytics:**
   - Task completion rates
   - Most productive times
   - Sentiment analysis

6. **Voice Response:**
   - Text-to-speech for reminders
   - Voice-only mode

---

## Recent Improvements

1. **Agentic Loop Architecture (January 2026):**
   - Replaced single-shot intent parsing with iterative tool-calling loop
   - LLM can now execute multiple tools to handle complex requests
   - Better handling of vague requests (searches first, then acts)
   - 27 tools defined for all bot operations
   - Handles multi-step operations (e.g., "reschedule X to Y")
   - Safeguards: max 10 iterations, 25s timeout, consecutive error limit

2. **Day-Only Reminders:**
   - Added isDayOnly flag to distinguish day-only from timed reminders
   - Day-only reminders only appear in morning review (no notifications)
   - Timed reminders send notifications AND appear in morning review
   - Fixed display formatting (day-only shows "@tuesday", timed shows "@tuesday 3:00 PM")

3. **Fuzzy Matching Improvements:**
   - Added stripSchedulingMetadata() to normalize task descriptions
   - Removes "@day time", "(overdue)", "(important)" from comparisons
   - Better matching of user references to stored tasks

4. **Body Doubling Feature:**
   - Virtual co-working sessions where bot checks in periodically
   - Tools: `start_body_doubling`, `update_body_doubling_focus`, `end_body_doubling`, `get_body_doubling_status`
   - Configurable check-in interval (default 25 minutes)
   - LLM generates natural, varied check-in messages (not formulaic)
   - Tracks session duration and check-in count
   - Weekly stats included in Sunday summary

5. **Activity Blocks:**
   - Time-based organization of the day (e.g., Morning Routine, Focus Time)
   - 6 default blocks auto-created for new users
   - `get_blocks` tool retrieves all blocks with assigned tasks/habits
   - Blocks have energy profiles (low/medium/high) for smart task scheduling
   - Tasks and habits can be assigned to specific blocks

## Issues to Watch

1. **LLM Parameter Configuration:**
   - OPENROUTER_*_PARAMS accept JSON for custom parameters
   - Complex nested JSON may have parsing issues

2. **Conversation Summarization:**
   - Async background summarization
   - Race conditions possible if messages added during summarization
   - Mitigated by re-reading current state before saving summary

3. **Timezone Handling:**
   - Single timezone assumption
   - May cause issues for users in different zones

4. **Follow-up Cancellation:**
   - Race condition between follow-up timer and user response
   - Mitigated by checking pending follow-up state

5. **Intent Classification Edge Cases:**
   - "What's in my inbox" vs "Add X to inbox" distinction
   - "Clear those reminders" (scheduled tasks) vs "Clear those items" (list items)
   - Improved with examples but edge cases may still exist

---

## Testing Scenarios

### Happy Path
1. User: "Remind me to call mom in 2 hours"
2. Bot: Confirms reminder
3. 2 hours later: Bot sends reminder
4. User: "done"
5. Bot: Confirms completion

### Voice Message
1. User: [Voice message]
2. Bot: "Transcribing..."
3. Bot: Shows transcription
4. Bot: Responds to content

### Daily Check-in
1. 8 PM: Bot asks "How was your day?"
2. User: "3 - was okay"
3. Bot: Logs check-in

### Morning Review
1. 8 AM: Bot shows today's items + overdue tasks
2. User can schedule, complete, or ignore

### List Management
1. User: "Make a grocery list with milk and eggs"
2. Bot: Creates list
3. User: "Add bread to grocery list"
4. Bot: Adds item
5. User: "Show grocery list"
6. Bot: Displays list
7. User: "I got the milk"
8. Bot: Checks off milk

---

## Code Quality Notes

### Strengths
- Clear separation of concerns (API, lib, types)
- TypeScript for type safety
- Consistent error handling patterns
- LLM personality consistency
- Comprehensive intent handling

### Areas for Improvement
- No unit tests
- No integration tests
- Some functions are quite long (handleIntent, etc.)
- Could benefit from more code comments
- No CI/CD pipeline
- Hardcoded constants (MAX_CONVERSATION_PAIRS, etc.)

### Technical Debt
- Duplicate `if (!skipSend)` checks in multiple places
- No abstraction for Redis key patterns
- LLM prompts are embedded in code (could be external)
- No rate limiting
- No request validation/sanitization
