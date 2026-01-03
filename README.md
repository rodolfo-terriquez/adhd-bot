# ADHD Support Telegram Bot

A Telegram bot designed to help manage ADHD through natural language task reminders, voice message transcription, brain dump capture, habits tracking, energy awareness, and intelligent gentle nagging. Powered by "Mika", a warm cat-girl companion who helps without judgment.

## Architecture

### Agentic Loop

The bot uses an **agentic loop architecture** where the LLM can execute multiple tools iteratively to handle complex, multi-step requests. This allows natural handling of vague or context-dependent commands.

**Example: "Cancel my dentist task"**
```
User: "Cancel my dentist task"
→ Agent searches for tasks matching "dentist"
→ Agent finds: "Dentist appointment - Tomorrow 2pm"
→ Agent cancels the task
→ Agent responds: "Done! I've cancelled your dentist appointment reminder."
```

The agent has access to 22 tools for reading and modifying user data:
- **Read tools**: `list_reminders`, `search_reminders`, `list_lists`, `get_list_items`, `get_habits`, `get_energy_patterns`
- **Write tools**: `create_reminder`, `complete_reminder`, `cancel_reminder`, `add_to_inbox`, `create_list`, `modify_list`, `delete_list`, `create_habit`, `complete_habit`, `delete_habit`, `log_energy`, `save_brain_dump`

This approach handles ambiguous requests gracefully - the LLM gathers context before acting, rather than guessing.

## Features

### Core Features
- **Voice Message Transcription**: Send voice notes for hands-free interaction using OpenAI Whisper
- **Natural Language Reminders**: "Remind me to call the dentist in 2 hours" or "Doctor appointment on Tuesday"
- **Brain Dump Capture**: Quickly capture thoughts with daily summaries
- **Smart Gentle Nagging**: Escalating reminders for important tasks until done
- **Inbox System**: Capture items without a specific time - they appear in every morning review
- **Lists**: Create and manage checklists (grocery lists, packing lists, etc.)

### Habits (New!)
- **Recurring Activities**: Track habits that repeat on specific days
- **Flexible Scheduling**: Daily, weekdays, weekends, or custom days (Mon/Wed/Fri)
- **Morning Review Integration**: See today's habits with completion checkboxes
- **Weekly Stats**: Track habit completion rates in weekly summaries

### Energy & Time Management
- **Energy Logging**: Track your energy levels throughout the day (1-5 scale)
- **Energy Patterns**: Learn when you're most productive over time
- **Activity Blocks**: Define time blocks for different types of work
- **Energy Matching**: Get task suggestions based on your current energy
- **Low Energy Mode**: When you're dragging, get only easy tasks suggested

### Daily Rhythms
- **Morning Review**: Daily summary of habits, tasks, inbox items, and overdue reminders
- **Daily Check-in**: Evening prompt to rate your day (1-5) with optional notes
- **Weekly Summary**: Patterns, insights, and habit completion stats
- **End of Day**: Gentle prompt to capture anything for tomorrow
- **Vacation Mode**: Pause all notifications when you need a break

## Tech Stack

- **Runtime**: Vercel Serverless Functions (TypeScript)
- **LLM**: OpenRouter (configurable models for intent parsing vs chat)
- **Transcription**: OpenAI Whisper
- **Database**: Upstash Redis
- **Scheduler**: Upstash QStash
- **Bot Interface**: Telegram Bot API

## Setup

### 1. Create Required Accounts

1. **Telegram Bot**: Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow the prompts
   - Save the bot token

2. **Vercel**: Sign up at [vercel.com](https://vercel.com)

3. **OpenAI**: Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)

4. **OpenRouter**: Get an API key from [openrouter.ai](https://openrouter.ai/keys)

5. **Upstash**: Sign up at [console.upstash.com](https://console.upstash.com/)
   - Create a Redis database
   - Enable QStash

### 2. Clone and Configure

```bash
# Clone the repository
git clone <your-repo-url>
cd telegram-bot

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
```

Fill in all the values in `.env.local`.

### 3. Deploy to Vercel

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
# Or use: vercel env add TELEGRAM_BOT_TOKEN
```

### 4. Set Telegram Webhook

After deployment, set your webhook URL:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.vercel.app/api/telegram"}'
```

## Usage

### Reminders
- "Remind me to take my meds in 30 minutes"
- "In 2 hours remind me to call mom"
- "Doctor appointment on Tuesday" (day-only, shows in morning review)
- "Important: submit the report by 5pm - nag me" (enables gentle nagging)

### Inbox Items
- "Buy groceries" (no time = goes to inbox)
- "Pick up prescription" (appears in every morning review until scheduled or done)

### Brain Dumps
- "Dump: random thought about the project"
- "Note to self: look into that new framework"
- Just send any stream of consciousness text

### Habits
- "Add habit: meditate every morning"
- "I want to exercise on Mon/Wed/Fri"
- "Habit: take vitamins daily"
- "Show my habits" / "List habits"
- "Done with meditation" (marks habit complete for today)
- "Pause exercise habit" / "Resume meditation"
- "Remove the reading habit"

### Lists
- "Create a grocery list: milk, eggs, bread"
- "Show my lists"
- "What's in my grocery list?"
- "Add cheese to the grocery list"
- "Remove milk from the list"
- "Check off eggs"

### Energy Tracking
- "Energy 3" / "Feeling like a 4"
- "Low energy right now" / "Pretty energized"
- "Show my energy patterns"
- "Low energy mode" (only suggests easy tasks)
- "I usually feel energized in the evenings" (learns patterns)

### Managing Tasks
- "Done" - marks the most recent task complete
- "Finished calling mom" - marks a specific task complete
- "List tasks" / "Show reminders" - shows all pending reminders
- "What do I have pending?" - shows tasks

### Settings
- "Set check-in time to 8pm"
- "Set morning review to 7am"
- "Vacation mode" / "I'm on vacation until Monday"
- "Back from vacation"

### Voice Messages
Just send a voice note! The bot will transcribe it and process it like text.

### Debug Commands
- `/debug` - Export conversation context as markdown file
- `/schedule` - Export scheduling system state (QStash schedules, tasks, blocks)

## Development

```bash
# Run locally with Vercel dev
npm run dev

# Type check
npm run type-check
```

For local development, you'll need to use a tool like ngrok to expose your local server for Telegram webhooks.

## System Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Telegram  │────▶│    Vercel    │────▶│ OpenRouter  │
│     App     │     │   Functions  │     │    (LLM)    │
└─────────────┘     └──────────────┘     └─────────────┘
       │                   │                    │
       │                   ▼                    │
       │            ┌──────────────┐            │
       │            │   Whisper    │◀───────────┘
       │            │(Transcribe)  │
       │            └──────────────┘
       │                   │
       │                   ▼
       │            ┌──────────────┐
       │            │    Redis     │
       │            │  (Storage)   │
       │            └──────────────┘
       │                   │
       │                   ▼
       │            ┌──────────────┐
       │◀───────────│   QStash    │
       │            │ (Scheduler)  │
                    └──────────────┘
```

### Agent Loop Flow

```
┌────────────────────────────────────────────────────────┐
│                    Agent Loop                          │
│                                                        │
│  User Message                                          │
│       │                                                │
│       ▼                                                │
│  ┌─────────┐    ┌─────────┐    ┌─────────────────┐   │
│  │  LLM    │───▶│  Tool   │───▶│  Tool Executor  │   │
│  │ (Mika)  │    │  Calls  │    │  (Redis/QStash) │   │
│  └─────────┘    └─────────┘    └─────────────────┘   │
│       ▲              │                   │            │
│       │              │                   │            │
│       └──────────────┴───────────────────┘            │
│                  (Loop until text response)           │
│                                                        │
│  Final Response ──▶ Telegram                          │
└────────────────────────────────────────────────────────┘
```

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `OPENAI_API_KEY` | For Whisper transcription |
| `OPENROUTER_API_KEY` | For LLM access |
| `UPSTASH_REDIS_REST_URL` | Redis connection URL |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth token |
| `QSTASH_TOKEN` | QStash API token |
| `QSTASH_CURRENT_SIGNING_KEY` | Webhook verification |
| `QSTASH_NEXT_SIGNING_KEY` | Webhook verification |
| `BASE_URL` | Production URL for QStash callbacks |

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_MODEL_CHAT` | `x-ai/grok-3-fast` | Model for chat responses |
| `OPENROUTER_MODEL_INTENT` | (uses chat model) | Model for intent parsing |
| `OPENROUTER_CHAT_PARAMS` | `{}` | JSON object with extra API params for chat |
| `OPENROUTER_INTENT_PARAMS` | `{}` | JSON object with extra API params for intent |
| `ALLOWED_USERS` | (none) | Comma-separated usernames/IDs for access control |
| `USER_TIMEZONE` | `America/Los_Angeles` | User's timezone |
| `BRAINTRUST_API_KEY` | (none) | For LLM call tracing |

### Example: Configuring Model Parameters
```bash
# Use different models for intent parsing vs chat
OPENROUTER_MODEL_CHAT=anthropic/claude-3.5-sonnet
OPENROUTER_MODEL_INTENT=openai/gpt-4o-mini

# Disable reasoning for intent parsing (useful for reasoning models)
OPENROUTER_INTENT_PARAMS={"reasoning":false}

# Set temperature for chat responses  
OPENROUTER_CHAT_PARAMS={"temperature":0.7}

# Nested parameters (e.g., OpenAI reasoning effort)
OPENROUTER_INTENT_PARAMS={"reasoning":{"effort":"low"}}
```

## License

MIT

