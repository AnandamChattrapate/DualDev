import { getMatchState, finishMatch } from '../services/matchStateService.js'
import { MatchModel } from '../models/MatchModel.js'
import UserModel from '../models/UserModel.js'
import { updatePlayerRating } from '../services/leaderboardService.js'
import { invalidateUserCache } from '../services/userCache.js'

export const endedMatches = new Set()

export const handleMatchEnded = async ({ matchId, playerData, io }) => {
  if (endedMatches.has(matchId)) return
  endedMatches.add(matchId)

  console.log(`Match ended: ${matchId}`)

  try {
    const matchState = await getMatchState(matchId)
    if (!matchState) {
      console.log(`Match ${matchId} not found in Redis`)
      return
    }

    if (playerData) {
      const player = matchState.playerA.userId === playerData.userId
        ? matchState.playerA
        : matchState.playerB
      player.code            = playerData.code
      player.language        = playerData.language
      player.testsPassed     = playerData.testsPassed     ?? player.testsPassed
      player.submissionCount = playerData.submissionCount ?? player.submissionCount
      player.aiUsageCount    = playerData.aiUsageCount    ?? player.aiUsageCount
    }

    const { judgeMatch } = await import('../utils/aiJudge.js')
    const aiResult = await judgeMatch({
      playerA: matchState.playerA,
      playerB: matchState.playerB,
      problem: matchState.problem,
    })

    console.log(`AI judge result: winner=${aiResult.winner}`)

    await finishMatch({ matchId, winner: aiResult.winner })

    await MatchModel.create({
        matchId,
        players: [
            {
            user:   matchState.playerA.userId,
            result: aiResult.winner === matchState.playerA.userId ? "won"
                    : aiResult.winner === "draw" ? "draw" : "lost",
            },
            {
            user:   matchState.playerB.userId,
            result: aiResult.winner === matchState.playerB.userId ? "won"
                    : aiResult.winner === "draw" ? "draw" : "lost",
            },
        ],
        problem:    matchState.problem?.id || null,
        winner:     aiResult.winner,
        status:     "finished",
        aiReview:   aiResult,
        startedAt:  new Date(matchState.startedAt),
        finishedAt: new Date(),
        })

    const elapsed = (Date.now() - matchState.startedAt) / 1000

    await Promise.all([
      updateUserStats(matchState.playerA, aiResult.winner, elapsed),
      updateUserStats(matchState.playerB, aiResult.winner, elapsed),
    ])

    io.to(matchId).emit("match_result", {
      winnerId: aiResult.winner,
      aiReview: aiResult,
    })

    console.log(`match_result emitted to room ${matchId}`)

  } catch (err) {
    console.log("handleMatchEnded error:", err.message)
    io.to(matchId).emit("match_result", { winnerId: null, aiReview: null })
  }
}

const updateUserStats = async (player, winnerId, elapsed) => {
  try {
    const user = await UserModel.findById(player.userId)
    if (!user) return

    const won       = winnerId === player.userId
    const draw      = winnerId === "draw"
    const prevTotal = user.totalMatches || 0
    const newTotal  = prevTotal + 1

    const newAccuracy = Math.round(
      ((user.accuracy * prevTotal) + (player.testsPassed > 0 ? 100 : 0)) / newTotal
    )

    const newAvgSolveTime = Math.round(
      ((user.avgSolveTime * prevTotal) + elapsed) / newTotal
    )

    const eloChange = won ? 25 : draw ? 0 : -15

    if (won)       user.wins   = (user.wins   || 0) + 1
    else if (!draw) user.losses = (user.losses || 0) + 1

    user.rating        = Math.max(0, (user.rating || 1000) + eloChange)
    user.totalMatches  = newTotal
    user.accuracy      = newAccuracy
    user.avgSolveTime  = newAvgSolveTime
    user.totalAIUsage  = (user.totalAIUsage || 0) + (player.aiUsageCount || 0)

    if (player.submissionCount === 1 && player.testsPassed === player.totalTests) {
      user.perfectSolves = (user.perfectSolves || 0) + 1
    }

    if (
      player.testsPassed === player.totalTests &&
      player.totalTests > 0 &&
      !user.solvedProblems?.map(id => id.toString()).includes(player.problemId?.toString())
    ) {
      user.solvedProblems.push(player.problemId)
    }

    await user.save()
    console.log(`Stats updated for ${player.userId} — ELO: ${user.rating}`)

    /* Sync the new rating into the Redis leaderboard so rankings stay live */
    try {
      await updatePlayerRating({ userId: player.userId, rating: user.rating })
    } catch (lbErr) {
      console.log("leaderboard sync error:", lbErr.message)
    }

    /* Bust the user cache so the next authed request (and the next /me call)
       pulls the fresh rating / wins / losses from Mongo and re-warms Redis. */
    await invalidateUserCache(player.userId)

  } catch (err) {
    console.log("updateUserStats error:", err.message)
  }
}