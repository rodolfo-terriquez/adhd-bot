# Tama Bot v2 Architecture

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

## 1. New Data Models

### ActivityBlock
Time blocks that structure the day:
```typescript
interface ActivityBlock {
  id: string;
  chatId: number;
  name: string;                    // "Morning routine", "Focus time"
  startTime: string;               // "HH:MM"
  endTime: string;
  days: DayOfWeek[];               // Which days this applies
  energyProfile: "high" | "medium" | "low" | "variable";
  taskCategories: string[];        // ["admin", "creative", "errands"]
  flexLevel: "fixed" | "flexible" | "soft";
  isDefault: boolean;
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
}

type DayOfWeek = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
```

### EnergyLog
Track energy throughout the day:
```typescript
interface EnergyLog {
  id: string;
  chatId: number;
  timestamp: number;
  level: 1 | 2 | 3 | 4 | 5;        // 1 = exhausted, 5 = energized
  context?: string;                 // "just woke up", "after lunch"
  blockId?: string;                 // Which block they were in
  createdAt: number;
}
```

### EnergyPattern
Learned patterns about user's energy:
```typescript
interface EnergyPattern {
  chatId: number;
  hourlyAverages: Record<number, number>;      // hour (0-23) -> avg energy
  dayOfWeekAverages: Record<DayOfWeek, number>;
  blockAverages: Record<string, number>;       // blockId -> avg
  taskTypeSuccessRates: Record<string, Record<string, number>>; // task type -> energy -> completion rate
  lastUpdated: number;
  dataPoints: number;
}
```

### CapturedItem
Raw unprocessed input before task extraction:
```typescript
interface CapturedItem {
  id: string;
  chatId: number;
  rawContent: string;
  source: "text" | "voice";
  extractedTasks?: ExtractedTask[];
  processingStatus: "pending" | "processed" | "confirmed" | "rejected";
  createdAt: number;
  processedAt?: number;
}

interface ExtractedTask {
  content: string;
  suggestedEnergyLevel?: "high" | "medium" | "low";
  suggestedContextTags?: string[];     // @home, @computer, @errands
  suggestedDecomposition?: string[];   // Subtasks for complex items
  confidence: number;                   // 0-1
}
```

### TaskV2 (extends existing Task)
```typescript
interface TaskV2 extends Task {
  // Existing fields from Task...

  // New v2 fields
  energyRequired: "high" | "medium" | "low";
  contextTags: string[];               // @home, @computer, @errands, @phone
  parentTaskId?: string;               // For decomposition
  childTaskIds?: string[];
  blockAssignment?: string;            // Assigned block ID
  estimatedMinutes?: number;
  actualMinutes?: number;              // Tracked after completion
  source: "manual" | "extracted" | "recurring";
  decompositionLevel: number;          // 0 = top-level
  snoozeCount: number;
}
```

### UserPreferencesV2 (extends existing)
```typescript
interface UserPreferencesV2 extends UserPreferences {
  // Existing fields...

  // New v2 fields
  defaultBlocks: string[];             // IDs of default activity blocks
  autoExtractTasks: boolean;           // default: true
  confirmBreakdowns: boolean;          // default: true
  confirmScheduling: boolean;          // default: true
  energyCheckFrequency: "per_block" | "morning_evening" | "manual";
  transitionNudges: boolean;
  weeklyPlanningDay: DayOfWeek;        // default: sunday
  weeklyPlanningTime: string;
  preferredTaskBatchSize: number;      // default: 3
  lowEnergyMode: boolean;
  learningEnabled: boolean;

  // Vacation mode
  vacationMode: boolean;               // Pauses all block notifications
  vacationUntil?: number;              // Auto-resume date (optional)
}
```

---

## 2. Redis Schema Additions

```
# Activity Blocks
block:{chatId}:{blockId} → ActivityBlock JSON
blocks:{chatId} → Set of block IDs

# Energy Tracking
energy_log:{chatId}:{logId} → EnergyLog JSON (TTL: 90 days)
energy_logs:{chatId}:{date} → Set of log IDs for that day
energy_pattern:{chatId} → EnergyPattern JSON

# Capture Processing
captured:{chatId}:{capturedId} → CapturedItem JSON (TTL: 24h)
captured_pending:{chatId} → Set of pending captured IDs

# Block-Task Assignment
block_tasks:{chatId}:{blockId}:{date} → Sorted set of task IDs
current_block:{chatId} → Current active block ID

# Patterns & Learning
task_patterns:{chatId} → JSON of learned task patterns
routine_candidates:{chatId} → Set of potential routine patterns

# State
weekly_planning_pending:{chatId} → "1" if weekly planning session pending
```

---

## 3. New Intent Types

### Capture
```typescript
{ type: "capture"; rawContent: string }
{ type: "confirm_extraction"; acceptedIndices: number[]; modifications?: {...} }
{ type: "decompose_task"; taskDescription?: string }
```

### Blocks
```typescript
{ type: "show_blocks" }
{ type: "show_block"; blockName?: string }
{ type: "assign_block"; taskDescription: string; blockName: string }
{ type: "modify_block"; blockName: string; action: "create"|"edit"|"delete"|"pause"|"resume" }
{ type: "block_transition"; action: "start"|"end"|"skip"|"extend" }
```

### Energy
```typescript
{ type: "energy_log"; level: 1-5; context?: string }
{ type: "energy_match"; currentEnergy?: "high"|"medium"|"low" }
{ type: "low_energy_mode"; enabled: boolean }
{ type: "show_energy_patterns" }
```

### Vacation Mode
```typescript
{ type: "vacation_mode"; action: "start"|"end"; until?: string }
```
- Pauses all block notifications and energy checks
- Timed reminders still work (appointments don't stop for vacation)
- Optional auto-resume date
- Learning paused during vacation (don't skew patterns)

### Planning
```typescript
{ type: "weekly_planning"; action: "start"|"continue"|"complete"|"skip" }
{ type: "day_planning"; action: "start"|"review"|"adjust" }
{ type: "batch_tasks"; taskDescriptions?: string[] }
```

### Context
```typescript
{ type: "context_tag"; taskDescription: string; tags: string[] }
{ type: "filter_by_context"; tags: string[] }
```

---

## 4. Core Algorithms

### Task Extraction from Unstructured Input

```
User: "ugh need to call the vet about Luna, also mom's birthday
       next week, and the sink is still dripping"

Bot extracts:
1. "Call vet about Luna" (medium energy, @phone)
2. "Get birthday card for mom" (low energy, @errands, deadline ~1wk)
3. "Fix/call about sink" (asks: DIY or call someone?)

Bot confirms before creating tasks.
```

**Extraction process:**
1. Identify task-like segments (action verbs, obligations, commitments)
2. For each segment: determine content, temporal hints, energy estimate, context tags
3. Score confidence (clear action verbs = high, vague = lower)
4. Confirm with user before creating

### Energy Pattern Learning

```typescript
// Exponential moving average for learning
function updateEnergyPatterns(chatId, newLog) {
  const pattern = await getEnergyPattern(chatId);
  const hour = new Date(newLog.timestamp).getHours();
  const dayOfWeek = getDayOfWeek(newLog.timestamp);

  // Update hourly average (learning rate: 0.1)
  pattern.hourlyAverages[hour] = exponentialMovingAverage(
    pattern.hourlyAverages[hour], newLog.level, 0.1
  );

  // Update day-of-week average
  pattern.dayOfWeekAverages[dayOfWeek] = exponentialMovingAverage(
    pattern.dayOfWeekAverages[dayOfWeek], newLog.level, 0.1
  );

  // Update block average if applicable
  if (newLog.blockId) {
    pattern.blockAverages[newLog.blockId] = exponentialMovingAverage(
      pattern.blockAverages[newLog.blockId] || 3, newLog.level, 0.15
    );
  }
}
```

### Task-to-Block Matching

Score each block for a task based on:
- **Energy match** (task requirement vs block profile): 30%
- **Category match** (task tags vs block categories): 25%
- **Historical success rate**: 25%
- **Duration fit**: 20%

### Routine Detection

After 7 days of usage, identify:
- Tasks that recur 3+ times
- With consistent timing (within 2-hour window)
- On consistent days
- Suggest making them official routines
- Refine weekly

---

## 5. User Flows

### Daily Flow

```
=== MORNING REVIEW (enhanced) ===
"Morning 🐾

**Morning Routine** (now-9am):
- Check prescription (@phone) - low energy

**Focus Time** (9am-12pm):
- Call vet about Luna
- Draft email to landlord

3 things in Inbox need a home. Want to look?"

=== BLOCK TRANSITIONS ===
"Focus Time wrapping up. How'd it go?"
→ Track completions, carry forward remaining

=== ENERGY CHECK (mid-block or configured) ===
"Quick energy check? (1-5)"
→ If low: "Want to switch to low-energy mode?"

=== EVENING CHECK-IN ===
"How'd today feel? (1-5)"
→ Summarize completions, no shame for what's left
```

### Weekly Planning Flow

```
"Sunday wind-down 🐾

**Carrying over:**
- Email draft (started)
- Research laptop

**This week:**
- Mom's birthday card - mail by Thursday
- Dentist Tuesday 2pm

**Patterns noticed:**
- Tuesdays: good focus energy
- Thursday afternoons: lower energy

Want to rough-slot these into the week?"
```

### Capture Flow

```
User dumps: "so much stuff ugh. vet call, mom birthday, sink dripping"

Bot: "Caught that 🐾

Found a few things:
1. Call vet about Luna (@phone)
2. Birthday card for mom - this week (@errands)
3. Sink dripping - DIY or call someone?

These look right?"

User: "yeah call someone for sink"

Bot: "Got it. Want me to suggest when to tackle these?"
```

---

## 6. Default Activity Blocks

| Block | Time | Days | Energy | Categories |
|-------|------|------|--------|------------|
| Morning Routine | 7-9am | M-F | low | personal, routine |
| Focus Time | 9am-12pm | M-F | high | work, creative |
| Midday | 12-2pm | M-F | medium | errands, calls, admin |
| Afternoon | 2-5pm | M-F | medium | work, admin |
| Evening | 5-9pm | all | low | personal, relaxation |
| Weekend | 9am-6pm | S-S | variable | personal, projects |

Blocks are:
- Customizable per user
- Can be paused/skipped individually
- Flex based on actual wake time (hybrid model)

### Vacation Mode
- "I'm on vacation" → pauses all block notifications
- Timed reminders (appointments) still fire
- Optional: "back on Monday" → auto-resume
- Learning paused during vacation (prevents skewed patterns)
- Simple toggle: "vacation mode on/off"

---

## 7. Notification Changes

### Hybrid Reminder System

Keep both systems - some tasks need specific times, others fit into blocks:

**Timed Reminders (existing v1 behavior)**
- Tasks with specific times still get individual notifications
- "Dentist at 2pm" → reminder at 2pm (unchanged)
- Escalating nags for important timed tasks (unchanged)

**Block-Based Notifications (new)**
- **Block start**: "Focus Time starting. Here's what's slotted..."
- **Mid-block energy check**: "Quick energy check? (1-5)"
- **Block transition**: "Focus Time ending. Any wins? Afternoon block next."
- Tasks without specific times live in blocks

**Task Assignment**
- `blockAssignment` field = task lives in a block (no specific time)
- `nextReminder` field = task has specific time (existing behavior)
- Task can have both (timed reminder + block context)

### Energy-Aware Suggestions
- Low energy detected → suggest low-energy tasks only
- High energy → offer challenging tasks
- Variable → ask what they feel like

---

## 8. Migration Strategy

1. **Create default blocks** for existing users
2. **Migrate existing tasks** → infer energy level from content
3. **Extend preferences** with new v2 fields (conservative defaults)
4. **Initialize empty patterns** (learn over time)
5. **Feature gates** unlock progressively:
   - Task extraction: after 5 messages
   - Energy tracking: after first log
   - Pattern learning: after 7 days (weekly adjustment cycle)
   - Weekly planning: after 1 week
   - Routine detection: after 7 days (refine weekly)

### Learning Cycle
- **Week 1**: Collect baseline data, start making initial suggestions
- **Weekly adjustment**: Every Sunday, recalculate patterns based on past week
- **Continuous learning**: Exponential moving average favors recent data
- Faster adaptation - responds to life changes quickly

---

## 9. ADHD Design Principles

1. **Minimize friction**: Voice dumps always accepted, messy input encouraged
2. **Reduce decisions**: Max 3 options shown, suggest don't demand
3. **Build structure gradually**: Start minimal, introduce as user engages
4. **Support variable energy**: Always offer low-energy alternatives
5. **No shame**: Track patterns not failures, dropping tasks is valid

---

## 10. Files to Modify

| File | Changes |
|------|---------|
| `lib/types.ts` | Add ActivityBlock, EnergyLog, EnergyPattern, CapturedItem, TaskV2, UserPreferencesV2 |
| `lib/redis.ts` | Add CRUD for blocks, energy logs, patterns, captured items |
| `lib/llm.ts` | Add task extraction prompts, energy-aware generation, block suggestions |
| `api/telegram.ts` | Add new intent handlers, update morning review, capture flow |
| `api/notify.ts` | Add block-based notifications, energy checks, transitions |

---

## 11. Implementation Order

1. **Foundation**: Data models, Redis schema, block CRUD
2. **Energy Tracking**: EnergyLog, logging intent, pattern storage
3. **Zero-Friction Capture**: CapturedItem, extraction, confirmation flow
4. **Block-Based Planning**: Task assignment, block notifications, transitions
5. **Pattern Learning**: Energy learning, success tracking, routine detection
6. **Weekly Planning**: Planning flow, week view, batching
