import * as redis from "../lib/redis.js";

async function debugHabits() {
  const chatId = parseInt(process.argv[2]);

  if (!chatId) {
    console.error("Usage: tsx scripts/debug-habits.ts <chatId>");
    process.exit(1);
  }

  console.log(`\n=== Debugging Habits for Chat ID: ${chatId} ===\n`);

  try {
    // Get all habits
    const habits = await redis.getAllHabits(chatId);
    console.log(`Found ${habits.length} habits:\n`);

    if (habits.length > 0) {
      habits.forEach((habit, index) => {
        console.log(`${index + 1}. ${habit.name}`);
        console.log(`   ID: ${habit.id}`);
        console.log(`   Days: ${habit.days.join(", ")}`);
        console.log(`   Status: ${habit.status}`);
        console.log(`   Created: ${new Date(habit.createdAt).toISOString()}`);
        console.log();
      });
    } else {
      console.log("No habits found!");
      console.log("\nLet's check the Redis keys directly...\n");

      // Check if the habits set exists
      const redis_client = (redis as any).getClient();
      const habitsSetKey = `habits:${chatId}`;
      const habitIds = await redis_client.smembers(habitsSetKey);
      console.log(`Raw Redis check for key "${habitsSetKey}":`, habitIds);

      if (habitIds.length > 0) {
        console.log("\nFound habit IDs in set, checking individual habits:");
        for (const id of habitIds) {
          const habitKey = `habit:${chatId}:${id}`;
          const habitData = await redis_client.get(habitKey);
          console.log(`\nKey: ${habitKey}`);
          console.log(`Data:`, habitData);
        }
      }
    }

    // Get today's habits
    const todaysHabits = await redis.getHabitsForToday(chatId);
    console.log(`\nToday's habits: ${todaysHabits.length}`);
    todaysHabits.forEach((h) => console.log(`  - ${h.name}`));

  } catch (error) {
    console.error("Error:", error);
  }

  process.exit(0);
}

debugHabits();
