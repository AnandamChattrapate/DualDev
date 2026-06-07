import { handleMatchEnded } from '../handlers/matchEndHandler.js'

export const registerSocketHandlers = (socket, io, redis) => {
  const userId = socket.user?.userId
  if (!userId) {
    socket.disconnect()
    return
  }

  redis.set(`socket:${userId}`, socket.id, "EX", 86400)
  console.log(`User ${userId} mapped to socket ${socket.id}`)

  socket.on("join_match", async ({ matchId }) => {
    socket.join(matchId)
    console.log(`User ${userId} joined room ${matchId}`)
    /* opponent_joined doubles as "opponent_reconnected" — if the user
       had previously disconnected mid-match, the opponent's panel can
       flip from OFFLINE back to whatever presence they next emit. */
    socket.to(matchId).emit("opponent_joined", { userId })
    /* Remember which match this socket belongs to, so on disconnect we
       can broadcast the offline notice without a Redis lookup. */
    socket.data.matchId = matchId
  })

  socket.on("code_change", ({ matchId, tokens }) => {
    socket.to(matchId).emit("opponent_tokens", { tokens })
  })

  /* Lightweight presence event — sent by client when their activity
     changes (typing, reading a section, idle). We just forward it to
     the opponent in the same match room. No persistence needed. */
  socket.on("presence", ({ matchId, state, section }) => {
    if (!matchId || !state) return
    socket.to(matchId).emit("opponent_presence", {
      userId,
      state,
      section: section || null,
      ts: Date.now(),
    })
  })

  socket.on("tc_update", ({ matchId, testsPassed, totalTests }) => {
    socket.to(matchId).emit("opponent_tc_update", { userId, testsPassed, totalTests })
  })

  socket.on("emote", ({ matchId, emote }) => {
    socket.to(matchId).emit("opponent_emote", { emote })
  })

  socket.on("match_ended", async ({ matchId, userId: senderId, code, language, testsPassed, submissionCount, aiUsageCount }) => {
    await handleMatchEnded({
      matchId,
      playerData: { userId: senderId, code, language, testsPassed, submissionCount, aiUsageCount },
      io,
    })
  })

  socket.on("accept_match", async ({ matchId }) => {
    try {
      const pendingRaw = await redis.get(`pending:${matchId}`)
      if (!pendingRaw) {
        socket.emit("match_cancelled", { reason: "Match expired" })
        return
      }

      const pending = JSON.parse(pendingRaw)
      if (!pending.acceptedBy.includes(userId)) pending.acceptedBy.push(userId)

      console.log(`${userId} accepted match ${matchId} — ${pending.acceptedBy.length}/2`)

      if (pending.acceptedBy.length === 2) {
        await redis.del(`pending:${matchId}`)
        console.log(`Both accepted — starting match ${matchId}`)

        io.to(pending.playerA.socketId).emit("match_accepted", {
          matchId,
          opponent: { userId: pending.playerB.userId, username: pending.playerB.username, rating: pending.playerB.rating },
          problem:  pending.problem,
        })
        io.to(pending.playerB.socketId).emit("match_accepted", {
          matchId,
          opponent: { userId: pending.playerA.userId, username: pending.playerA.username, rating: pending.playerA.rating },
          problem:  pending.problem,
        })

      } else {
        await redis.set(`pending:${matchId}`, JSON.stringify(pending), "EX", 30)
        socket.emit("match_acceptance_waiting", { message: "Waiting for opponent to accept" })
      }

    } catch (err) {
      console.log("accept_match error:", err.message)
    }
  })

  socket.on("decline_match", async ({ matchId }) => {
    try {
      const pendingRaw = await redis.get(`pending:${matchId}`)
      if (!pendingRaw) return

      const pending = JSON.parse(pendingRaw)
      await redis.del(`pending:${matchId}`)

      console.log(`${userId} declined match ${matchId}`)

      io.to(pending.playerA.socketId).emit("match_cancelled", { reason: "Opponent declined the match" })
      io.to(pending.playerB.socketId).emit("match_cancelled", { reason: "Opponent declined the match" })

      /* Clean up match state + user-match index so auto-rejoin doesn't redirect
         either player into a ghost match. */
      await redis.del(`match:${matchId}`)
      await redis.zrem('active_matches', matchId)
      await redis.del(`user:${pending.playerA.userId}:match`)
      await redis.del(`user:${pending.playerB.userId}:match`)
      console.log(`[cleanup] cleared declined state for ${matchId}`)

    } catch (err) {
      console.log("decline_match error:", err.message)
    }
  })

  socket.on("disconnect", async () => {
    console.log("Socket disconnected:", socket.id)

    /* If this socket was in a match room, give the opponent a 3s grace period
       (covers brief network blips and reload reconnects) before announcing
       offline. The grace is only meaningful while the per-user socket map
       still points at THIS socket id — if the user reconnects within 3s,
       their new socket will overwrite the map and we skip the broadcast. */
    const matchId = socket.data?.matchId
    if (matchId) {
      setTimeout(async () => {
        try {
          const currentSocketId = await redis.get(`socket:${userId}`)
          if (currentSocketId !== socket.id) return   // they reconnected, no broadcast
          io.to(matchId).emit("opponent_offline", { userId })
          console.log(`[presence] notified room ${matchId} that ${userId} went offline`)
        } catch {}
      }, 3000)
    }

    try {
      const { leaveMatchmakingQueue } = await import('../services/matchmakingService.js')
      await leaveMatchmakingQueue(userId)
      console.log(`Removed ${userId} from matchmaking queue on disconnect`)
    } catch (err) {
      console.log("Error removing from queue:", err.message)
    }

    setTimeout(async () => {
      const currentSocketId = await redis.get(`socket:${userId}`)
      if (currentSocketId === socket.id) {
        await redis.del(`socket:${userId}`)
        console.log(`Removed socket mapping for user ${userId}`)
      } else {
        console.log(`User ${userId} reconnected — keeping new socket mapping`)
      }
    }, 5000)
  })
}