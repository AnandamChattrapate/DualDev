// import matchmakingRedis from "../config/matchmakingRedis.js";

// export const joinMatchmakingQueue = async ({
//   userId,
//   rating
// }) => {

//   await matchmakingRedis.zadd(
//     "matchmakingQueue",
//     rating,
//     userId
//   );

//   return true;
// };

// export const findNearbyPlayers = async (
//   rating
// ) => {

//   return await matchmakingRedis.zrangebyscore(
//     "matchmakingQueue",
//     rating - 100,
//     rating + 100
//   );
// };

// export const leaveMatchmakingQueue = async (
//   userId
// ) => {

//   await matchmakingRedis.zrem(
//     "matchmakingQueue",
//     userId
//   );

//   return true;
// };

// export const getQueueCount = async () => {

//   return await matchmakingRedis.zcard(
//     "matchmakingQueue"
//   );
// };
import matchmakingRedis from "../config/matchmakingRedis.js";

// JOIN — store full player object so worker has username, socketId, rating
export const joinMatchmakingQueue = async ({ userId, username, rating, socketId, topic, difficulty }) => {
  // Remove any existing queue entry for this userId (prevents duplicates)
  const members = await matchmakingRedis.zrange("matchmakingQueue", 0, -1);
  for (const member of members) {
    try {
      const parsed = JSON.parse(member);
      if (parsed.userId === userId) {
        await matchmakingRedis.zrem("matchmakingQueue", member);
        break;   // assume only one entry per user
      }
    } catch {
      // ignore malformed entries
    }
  }

  // Add the fresh entry
  const playerData = JSON.stringify({
    userId,
    username,
    rating,
    socketId,
    topic:      topic      || "Array",
    difficulty: difficulty || "Easy",
  });

  await matchmakingRedis.zadd("matchmakingQueue", rating, playerData);
  return true;
};

// FIND NEARBY — returns parsed player objects within rating range
export const findNearbyPlayers = async (rating) => {

  const players = await matchmakingRedis.zrangebyscore(
    "matchmakingQueue",
    rating - 100,
    rating + 100
  )

  // Parse each JSON string back to object
  return players.map((p) => {
    try { return JSON.parse(p) }
    catch { return { userId: p } }  // fallback if plain string
  })
}

// LEAVE — scan and remove by userId since member is now JSON string
export const leaveMatchmakingQueue = async (userId) => {

  const allPlayers = await matchmakingRedis.zrange("matchmakingQueue", 0, -1)

  for (const player of allPlayers) {
    try {
      const parsed = JSON.parse(player)
      if (parsed.userId === userId) {
        await matchmakingRedis.zrem("matchmakingQueue", player)
        break
      }
    } catch { continue }
  }

  return true
}

// COUNT
export const getQueueCount = async () => {
  return await matchmakingRedis.zcard("matchmakingQueue")
}