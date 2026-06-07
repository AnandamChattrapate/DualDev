import mongoose from "mongoose"
import matchmakingRedis from "../config/matchmakingRedis.js"
import { config } from 'dotenv'
config()

const MATCH_RANGE = 200
const DB_URL = process.env.DB_URL

const MATCH_DURATION_SECONDS = {
  Easy:   15 * 60 + 25,   // 925
  Medium: 25 * 60 + 15,   // 1515
  Hard:   40 * 60 + 25,   // 2425
}

// ──────────────── DB / Models / Problem selection (unchanged) ────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(DB_URL)
    console.log("Matchmaking Worker DB Connected")
  } catch (err) {
    console.log("Matchmaking Worker DB Error:", err.message)
    process.exit(1)
  }
}

const ProblemModel = mongoose.models.ProblemModel ||
  mongoose.model("ProblemModel", new mongoose.Schema({
    title:        String,
    slug:         String,
    topic:        String,
    difficulty:   String,
    description:  String,
    inputFormat:  String,
    outputFormat: String,
    constraints:  [String],
    timeLimit:    Number,
    memoryLimit:  Number,
    judgeType:    String,
    sampleTestCases: [{
      id:          String,
      input:       String,
      output:      String,
      explanation: String,
    }],
    hiddenTestCases: [{
      id:       String,
      input:    String,
      output:   String,
      weight:   Number,
      isHidden: Boolean,
    }],
  }))

const UserModel = mongoose.models.UserModel ||
  mongoose.model("UserModel", new mongoose.Schema({
    solvedProblems: [{ type: mongoose.Schema.Types.ObjectId }],
  }))

const selectProblem = async (topic, difficulty, player1Id, player2Id) => {
  console.log("selectProblem called with:", { topic, difficulty, player1Id, player2Id })

  const [user1, user2] = await Promise.all([
    UserModel.findById(player1Id).select("solvedProblems"),
    UserModel.findById(player2Id).select("solvedProblems"),
  ])

  const solvedByEither = new Set([
    ...(user1?.solvedProblems || []).filter(id => id != null).map(id => id.toString()),
    ...(user2?.solvedProblems || []).filter(id => id != null).map(id => id.toString()),
  ])

  let problems = await ProblemModel.find({
    topic,
    difficulty,
    _id: { $nin: [...solvedByEither] }
  })
  console.log("problems found step 1:", problems.length)

  if (!problems.length) {
    console.log(`No unsolved ${topic} ${difficulty} — falling back to any ${difficulty}`)
    problems = await ProblemModel.find({
      difficulty,
      _id: { $nin: [...solvedByEither] }
    })
    console.log("problems found step 2:", problems.length)
  }

  if (!problems.length) {
    console.log(`No unsolved ${difficulty} problems — picking any`)
    problems = await ProblemModel.find({ difficulty })
    console.log("problems found step 3:", problems.length)
  }

  if (!problems.length) return null
  const chosen = problems[Math.floor(Math.random() * problems.length)]
  console.log("final problem selected:", chosen.title)
  return chosen
}

// ──────────────── MATCHMAKING LOGIC ────────────────

/**
 * Tries to find the best opponent from `candidates` for `player1`
 * according to the priority cascade.
 * Returns { opponent, topic, difficulty, reason } or null.
 */
const tryMatch = (player1, candidates, withinRange) => {
  // Priority 1: same topic AND same difficulty
  let match = candidates.find(
    p => p.topic === player1.topic && p.difficulty === player1.difficulty
  );
  if (match) {
    return {
      opponent: match,
      topic: player1.topic,
      difficulty: player1.difficulty,
      reason: `${withinRange ? 'Within rating range' : 'Expanded rating'} – same topic & difficulty`,
    };
  }

  // Priority 2: same topic, different difficulty (random difficulty from the two)
  match = candidates.find(p => p.topic === player1.topic);
  if (match) {
    const chosenDifficulty = Math.random() < 0.5 ? player1.difficulty : match.difficulty;
    return {
      opponent: match,
      topic: player1.topic,
      difficulty: chosenDifficulty,
      reason: `${withinRange ? 'Within rating range' : 'Expanded rating'} – same topic, random difficulty`,
    };
  }

  // Priority 3: any candidate (random preferences from either player)
  if (candidates.length > 0) {
    const opponent = candidates[0]; // first available (closest rating)
    const usePlayer1 = Math.random() < 0.5;
    return {
      opponent,
      topic: usePlayer1 ? (player1.topic || 'Array') : (opponent.topic || 'Array'),
      difficulty: usePlayer1 ? (player1.difficulty || 'Easy') : (opponent.difficulty || 'Easy'),
      reason: `${withinRange ? 'Within rating range' : 'Expanded rating'} – random preferences`,
    };
  }

  return null;
};

// ──────────────── MAIN WORKER ────────────────
const startMatchmakingWorker = async () => {
  console.log("Matchmaking Worker Running")
  await connectDB()

  setInterval(async () => {
    try {
      const players = await matchmakingRedis.zrange(
        "matchmakingQueue", 0, -1, "WITHSCORES"
      )
      if (players.length < 4) return  // need at least 2 players

      // Format players into objects
      const formattedPlayers = []
      for (let i = 0; i < players.length; i += 2) {
        try {
          const playerData = JSON.parse(players[i])
          formattedPlayers.push({
            ...playerData,
            rating:    Number(players[i + 1]),
            rawMember: players[i],
          })
        } catch {
          continue
        }
      }

      // ── DEDUPLICATE: keep only the latest entry per userId ──
      const uniqueMap = new Map()
      for (const p of formattedPlayers) {
        uniqueMap.set(p.userId, p)   // later entries overwrite earlier ones
      }
      const dedupedPlayers = Array.from(uniqueMap.values())

      // Remove duplicate entries from Redis
      for (const p of formattedPlayers) {
        if (!uniqueMap.has(p.userId)) {
          await matchmakingRedis.zrem("matchmakingQueue", p.rawMember).catch(() => {})
        }
      }

      const usedPlayers = new Set()

      for (let i = 0; i < dedupedPlayers.length; i++) {
        const player1 = dedupedPlayers[i]
        if (usedPlayers.has(player1.userId)) continue

        // All unused players after player1, excluding self
        const others = dedupedPlayers.slice(i + 1).filter(
          p => !usedPlayers.has(p.userId) && p.userId !== player1.userId
        )

        // Split by rating range
        const inRange = others.filter(p => Math.abs(p.rating - player1.rating) <= MATCH_RANGE)
        const outOfRange = others.filter(p => Math.abs(p.rating - player1.rating) > MATCH_RANGE)

        // Try in-range first, then out-of-range
        let matchResult = tryMatch(player1, inRange, true)
        if (!matchResult) {
          matchResult = tryMatch(player1, outOfRange, false)
        }
        if (!matchResult) continue

        const { opponent: player2, topic, difficulty, reason } = matchResult

        console.log(`Match Found: ${player1.username} vs ${player2.username} | Reason: ${reason}`)

        const problem = await selectProblem(topic, difficulty, player1.userId, player2.userId)
        if (!problem) {
          console.log("No problem found — skipping match")
          continue
        }

        const duration = MATCH_DURATION_SECONDS[problem.difficulty] || 925
        const endsAt = Date.now() + duration * 1000
        const matchId = `match-${Date.now()}`

        const matchState = {
          matchId,
          playerA: {
            userId:          player1.userId,
            username:        player1.username,
            rating:          player1.rating,
            testsPassed:     0,
            totalTests:      problem.hiddenTestCases?.length || 0,
            submitted:       false,
            submissionCount: 0,
            aiUsageCount:    0,
            timeTaken:       null,
          },
          playerB: {
            userId:          player2.userId,
            username:        player2.username,
            rating:          player2.rating,
            testsPassed:     0,
            totalTests:      problem.hiddenTestCases?.length || 0,
            submitted:       false,
            submissionCount: 0,
            aiUsageCount:    0,
            timeTaken:       null,
          },
          problem: {
            id:         problem._id,
            title:      problem.title,
            difficulty: problem.difficulty,
          },
          status:    "ongoing",
          winner:    null,
          startedAt: Date.now(),
          endsAt,
        }

        // Store match with TTL + add to live matches
        await matchmakingRedis.set(`match:${matchId}`, JSON.stringify(matchState), "EX", duration + 60)
        await matchmakingRedis.zadd('active_matches', endsAt, matchId)

        // userId → matchId index for "is this user mid-match?" lookup
        const userMatchTtl = duration + 60
        await matchmakingRedis.set(`user:${player1.userId}:match`, matchId, "EX", userMatchTtl)
        await matchmakingRedis.set(`user:${player2.userId}:match`, matchId, "EX", userMatchTtl)

        // Remove matched players from queue
        await matchmakingRedis.zrem("matchmakingQueue", player1.rawMember)
        await matchmakingRedis.zrem("matchmakingQueue", player2.rawMember)

        usedPlayers.add(player1.userId)
        usedPlayers.add(player2.userId)

        // Publish match:created with reason
        await matchmakingRedis.publish("match:created", JSON.stringify({
          matchId,
          playerA: {
            userId:   player1.userId,
            username: player1.username,
            rating:   player1.rating,
          },
          playerB: {
            userId:   player2.userId,
            username: player2.username,
            rating:   player2.rating,
          },
          problem: {
            id:              problem._id,
            title:           problem.title,
            slug:            problem.slug,
            topic:           problem.topic,
            difficulty:      problem.difficulty,
            description:     problem.description,
            inputFormat:     problem.inputFormat,
            outputFormat:    problem.outputFormat,
            constraints:     problem.constraints,
            timeLimit:       problem.timeLimit,
            memoryLimit:     problem.memoryLimit,
            sampleTestCases: problem.sampleTestCases,
            hiddenTestCases: problem.hiddenTestCases,
          },
          reason,         // <-- NEW
        }))

        console.log(`Published match:created — ${matchId} | Problem: ${problem.title}`)
      }

    } catch (err) {
      console.log("Matchmaking Worker Error:", err)
    }
  }, 3000)
}

export default startMatchmakingWorker
