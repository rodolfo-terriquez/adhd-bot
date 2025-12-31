# Mika Bot v2 Architecture

## Vision Summary

Transform from a reminder bot into an **ADHD executive function assistant** that:
- Accepts messy, unstructured input and organizes it automatically
- Schedules tasks into energy-appropriate time blocks
- Learns patterns and builds structure gradually
- Reduces decision fatigue at every step

**Key decisions:**
- Automation: Confirm important decisions (scheduling, breakdowns), auto-handle small stuff
- Blocks: Hybrid model - default fixed blocks that flex when needed
- Reminders: Keep existing timed reminders + add block-based scheduling

---

## 1. How Mika Learns From You

Mika learns in three ways, building an increasingly accurate picture of your energy patterns and preferences:

### 1.1 Explicit Energy Logging
When you tell Mika your energy level directly:
- "energy 3" or "feeling like a 4"
- "exhausted" (infers level 1) or "pretty energized" (infers level 4)

These explicit logs are recorded with:
- The hour of day
- The day of week
- Which activity block you're in (if any)
- Any context you provide ("just woke up", "after lunch")

### 1.2 Conversational Energy Observations
Mika picks up on energy patterns mentioned casually in conversation:
- "I usually feel energized in the evenings" → Records: evening = high energy (pattern)
- "Mornings are rough for me" → Records: morning = low energy (pattern)
- "I'm more productive on Tuesdays" → Records: Tuesday = high energy (pattern)
- "Feeling pretty drained this afternoon" → Records: afternoon = low energy (one-time)

**How it works:**
- The intent parser recognizes energy-related language with time/day context
- Patterns (words like "usually", "always", "tend to") get stronger weight (alpha=0.3)
- One-time observations get moderate weight (alpha=0.2)
- User-stated preferences are weighted higher than inferred data since they're more reliable

### 1.3 Implicit Learning from Behavior
Over time, Mika tracks:
- Which tasks get completed vs snoozed/dropped
- Success rates at different times of day
- Completion patterns by energy level
- Task duration estimates vs actual time

---

## 2. Energy Pattern Storage

All learning data is stored in the `EnergyPattern` structure:

```typescript
interface EnergyPattern {
  chatId: number;
  hourlyAverages: Record<number, number>;      // hour (0-23) -> avg energy (1-5)
  dayOfWeekAverages: Record<DayOfWeek, number>; // day -> avg energy
  blockAverages: Record<string, number>;        // blockId -> avg energy
  taskTypeSuccessRates: Record<string, Record<string, number>>; // task type -> energy -> completion rate
  lastUpdated: number;
  dataPoints: number;
}
```

### Learning Algorithm

All updates use exponential moving average (EMA) to favor recent data:

```typescript
newAverage = alpha * newValue + (1 - alpha) * oldAverage
```

**Alpha values:**
- Explicit energy logs: 0.1 (gradual learning)
- User-stated patterns: 0.3 (strong weight - user knows themselves)
- User-stated one-time observations: 0.2 (moderate weight)
- Block averages: 0.15 (slightly faster adaptation)

**Why EMA?**
- Adapts to life changes quickly
- Doesn't require storing historical data
- Recent data matters more than old data
- Smooth updates prevent wild swings

---

## 3. How Auto-Scheduling Works

### 3.1 Task-to-Block Matching

When a task needs scheduling, Mika scores each block:

| Factor | Weight | Description |
|--------|--------|-------------|
| Energy match | 30% | Does block energy profile match task energy requirement? |
| Category match | 25% | Do block categories align with task type? |
| Historical success | 25% | Have similar tasks been completed in this block? |
| Duration fit | 20% | Does remaining block time fit the estimated task duration? |

### 3.2 Information Used for Scheduling

**From Energy Patterns:**
- Best hours for high-energy tasks
- Days where user tends to have more energy
- Block-specific energy averages

**From Task Properties:**
- Energy requirement (high/medium/low)
- Context tags (@home, @phone, @computer, @errands)
- Estimated duration
- Deadline/time constraints

**From User Preferences:**
- Preferred task batch size
- Whether they want scheduling confirmations
- Low energy mode status

### 3.3 Scheduling Flow

1. **New task enters system** (via reminder, inbox, or extraction)
2. **Check for explicit time** - if user said "at 3pm", use that
3. **Check for day constraint** - if user said "on Tuesday", scope to that day
4. **If no constraints**, find best block:
   - Score all active blocks for current/upcoming days
   - Pick highest scoring block with available capacity
   - If `confirmScheduling` preference is true, ask user
   - Otherwise, auto-assign

---

## 4. Activity Blocks

### Default Blocks (created for new users)

| Block | Time | Days | Energy Profile |
|-------|------|------|----------------|
| Morning Routine | 7-9am | M-F | low |
| Focus Time | 9am-12pm | M-F | high |
| Midday | 12-2pm | M-F | medium |
| Afternoon | 2-5pm | M-F | medium |
| Evening | 5-9pm | all | low |
| Weekend | 9am-6pm | S-S | variable |

### Block Notifications

- **Block start**: Lists tasks assigned to this block
- **Block end**: Asks how it went, moves incomplete tasks
- **Energy check**: Mid-block check-in (configurable frequency)

---

## 5. Data Models

### ActivityBlock
```typescript
interface ActivityBlock {
  id: string;
  chatId: number;
  name: string;
  startTime: string;               // "HH:MM"
  endTime: string;
  days: DayOfWeek[];
  energyProfile: "high" | "medium" | "low" | "variable";
  taskCategories: string[];
  flexLevel: "fixed" | "flexible" | "soft";
  isDefault: boolean;
  status: "active" | "paused";
}
```

### EnergyLog
```typescript
interface EnergyLog {
  id: string;
  chatId: number;
  timestamp: number;
  level: 1 | 2 | 3 | 4 | 5;
  context?: string;
  blockId?: string;
  createdAt: number;
}
```

### CapturedItem (for task extraction)
```typescript
interface CapturedItem {
  id: string;
  chatId: number;
  rawContent: string;
  source: "text" | "voice";
  extractedTasks?: ExtractedTask[];
  processingStatus: "pending" | "processed" | "confirmed" | "rejected";
  createdAt: number;
}

interface ExtractedTask {
  content: string;
  suggestedEnergyLevel?: "high" | "medium" | "low";
  suggestedContextTags?: string[];
  suggestedDecomposition?: string[];
  confidence: number;
}
```

---

## 6. Intent Types

### Energy Intents
```typescript
// Explicit logging
{ type: "energy_log"; level: 1-5; context?: string }

// Conversational observation (picked up from chat)
{ type: "energy_observation";
  timeOfDay?: "morning" | "midday" | "afternoon" | "evening" | "night";
  dayOfWeek?: DayOfWeek;
  energyLevel: "high" | "medium" | "low";
  isPattern: boolean;  // true if user says "usually", "always", etc.
  originalMessage: string;
}

// Mode toggles
{ type: "low_energy_mode"; enabled: boolean }
{ type: "show_energy_patterns" }
```

### Block Intents
```typescript
{ type: "show_blocks" }
{ type: "show_block"; blockName?: string }
{ type: "modify_block"; blockName: string; action: "create"|"edit"|"delete"|"pause"|"resume" }
{ type: "vacation_mode"; action: "start"|"end"; until?: string }
```

### Capture Intents
```typescript
{ type: "capture"; rawContent: string }
{ type: "confirm_extraction"; acceptedIndices: number[]; modifications?: {...} }
```

---

## 7. User Flows

### Daily Flow
```
=== MORNING REVIEW ===
"Morning

**Morning Routine** (now-9am):
- Check prescription (@phone) - low energy

**Focus Time** (9am-12pm):
- Call vet about Luna
- Draft email to landlord

3 things in Inbox need a home. Want to look?"

=== BLOCK TRANSITIONS ===
"Focus Time wrapping up. How'd it go?"
→ Track completions, carry forward remaining

=== ENERGY CHECK ===
"Quick energy check? (1-5)"
→ If low: "Want to switch to low-energy mode?"
```

### Capture Flow
```
User: "so much stuff ugh. vet call, mom birthday, sink dripping"

Mika: "Caught that

Found a few things:
1. Call vet about Luna (@phone)
2. Birthday card for mom - this week (@errands)
3. Sink dripping - DIY or call someone?

These look right?"

User: "yeah call someone for sink"

Mika: "Got it. Want me to suggest when to tackle these?"
```

---

## 8. Redis Schema

```
# Activity Blocks
{prefix}block:{chatId}:{blockId} → ActivityBlock JSON
{prefix}blocks:{chatId} → Set of block IDs

# Energy Tracking
{prefix}energy_log:{chatId}:{logId} → EnergyLog JSON (TTL: 90 days)
{prefix}energy_logs:{chatId}:{date} → Set of log IDs for that day
{prefix}energy_pattern:{chatId} → EnergyPattern JSON

# Capture Processing
{prefix}captured:{chatId}:{capturedId} → CapturedItem JSON (TTL: 24h)
{prefix}captured_pending:{chatId} → Set of pending captured IDs

# Block-Task Assignment
{prefix}block_tasks:{chatId}:{blockId}:{date} → Set of task IDs
{prefix}current_block:{chatId} → Current active block ID
```

Note: `{prefix}` is set via `REDIS_KEY_PREFIX` env var to support multiple bot instances sharing the same Redis database.

---

## 9. Environment Variables

| Variable | Description |
|----------|-------------|
| `REDIS_KEY_PREFIX` | Prefix for all Redis keys (e.g., "v2:") |
| `BRAINTRUST_PROJECT_ID` | Braintrust project for LLM tracing |
| `BRAINTRUST_PROJECT_NAME` | Fallback if no project ID |
| `OPENROUTER_MODEL_CHAT` | Model for conversations |
| `OPENROUTER_MODEL_INTENT` | Model for intent parsing |
| `USER_TIMEZONE` | User's timezone for scheduling |

---

## 10. ADHD Design Principles

1. **Minimize friction**: Voice dumps always accepted, messy input encouraged
2. **Reduce decisions**: Max 3 options shown, suggest don't demand
3. **Build structure gradually**: Start minimal, introduce as user engages
4. **Support variable energy**: Always offer low-energy alternatives
5. **No shame**: Track patterns not failures, dropping tasks is valid
6. **Learn passively**: Pick up preferences from conversation, don't require explicit configuration

---

## 11. Implementation Status

### Completed
- Data models and types
- Redis CRUD operations with key prefix support
- Energy logging (explicit and conversational)
- Energy pattern learning with EMA
- Task extraction from unstructured input
- Activity blocks with default templates
- Block notifications (start/end/energy check)
- Vacation mode

### In Progress
- Task-to-block assignment
- Block modifications
- Weekly planning flow

### Planned
- Routine detection
- Task decomposition
- Context filtering
- Duration tracking and learning
