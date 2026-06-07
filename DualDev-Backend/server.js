import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { connect } from 'mongoose'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import { config } from 'dotenv'
import Redis from 'ioredis'
import jwt from 'jsonwebtoken'
import { AIRouter } from './routes/AIRouter.js'
import  statsRoutes from './routes/statsRoutes.js'
import { initializeStats } from './controllers/statsController.js';


import { UserRouter } from './routes/UserRouter.js'
import { MatchStateRouter } from "./routes/MatchStateRouter.js"
import { ProblemRouter } from './routes/ProblemRouter.js'
import { SubmissionRouter } from './routes/SubmissionRouter.js'
import { MatchmakingRouter } from "./routes/MatchmakingRouter.js"
import { OnlineUsersRouter } from "./routes/OnlineUsersRouter.js"
import { LeaderboardRouter } from "./routes/LeaderboardRouter.js"
import matchmakingRedis from './config/matchmakingRedis.js'
import { registerSocketHandlers } from './socket/registerSocketHandlers.js'

config()

const app        = express()
const httpServer = createServer(app)
const PORT       = process.env.PORT || 5000

export const redis = matchmakingRedis
const HEARTBEAT_KEY = 'online_heartbeats'
const HEARTBEAT_TIMEOUT = 10_000 // 30 seconds
setInterval(async () => {
  const cutoff = Date.now() - HEARTBEAT_TIMEOUT
  try {
    await redis.zremrangebyscore(HEARTBEAT_KEY, '-inf', cutoff)
  } catch (err) {
    console.error('Heartbeat cleanup error:', err.message)
  }
}, 15_000)

// Clean up expired matches from the active set every 60 seconds
setInterval(async () => {
  const now = Date.now();
  try {
    // Remove match IDs with score less than current time
    await redis.zremrangebyscore('active_matches', '-inf', now);
    // (Optionally, also log how many were cleaned up)
  } catch (err) {
    console.error('Match cleanup error:', err.message);
  }
}, 60_000);


const subscriber = new Redis({
  host:     process.env.REDIS2_HOST,
  port:     Number(process.env.REDIS2_PORT),
  username: "default",
  password: process.env.REDIS2_PASSWORD,
})

subscriber.on("connect", () => console.log("Subscriber Redis Connected"))
subscriber.on("error",  (err) => console.log("Subscriber Redis Error:", err.message))

const resultSubscriber = new Redis({
  host:                 process.env.REDIS_HOST,
  port:                 Number(process.env.REDIS_PORT),
  username:             "default",
  password:             process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
})

resultSubscriber.on("connect", () => console.log("Result Subscriber Connected"))
resultSubscriber.on("error",  (err) => console.log("Result Subscriber Error:", err.message))

export const io = new Server(httpServer, {
  cors: {
    origin:      process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true
  }
})

const connectDB = async () => {
  try {
    await connect(process.env.DB_URL)
    console.log("====== CONNECTED TO DATABASE SUCCESSFULLY =====")
  } catch (err) {
    console.log("DB ERROR:", err.message)
  }
}
connectDB()

app.use(cors({
  origin:      process.env.CLIENT_URL || "http://localhost:5173",
  credentials: true
}))
app.use(express.json())
app.use(cookieParser())

app.get('/', (req, res) => res.send("backend is running"))
app.use('/api/auth',         UserRouter)
app.use('/api/problems',     ProblemRouter)
app.use('/api/submit',       SubmissionRouter)
app.use("/api/match",        MatchStateRouter)
app.use("/api/matchmaking",  MatchmakingRouter)
app.use("/api/online-users", OnlineUsersRouter)
app.use("/api/leaderboard",  LeaderboardRouter)
app.use('/api/ai', AIRouter)
app.use('/api/stats', statsRoutes);



io.use((socket, next) => {
  try {
    const cookie = socket.handshake.headers.cookie
    if (!cookie) return next(new Error("No cookie"))
    const token = cookie.split("token=")[1]?.split(";")[0]
    if (!token) return next(new Error("No token"))
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    socket.user = { userId: decoded.userId, email: decoded.email }
    next()
  } catch (err) {
    next(new Error("Socket auth failed"))
  }
})


io.on("connection", (socket) => {
  // ----- existing handler (keep this) -----
  registerSocketHandlers(socket, io, redis)

  const userId = socket.user?.userId
  if (!userId) return

  // 1) Mark user online immediately
  redis.zadd(HEARTBEAT_KEY, Date.now(), userId)

  // 2) Listen for custom heartbeat from client
  socket.on('heartbeat', () => {
    redis.zadd(HEARTBEAT_KEY, Date.now(), userId)
  })

  // 3) Clean disconnect – remove instantly
  socket.on('disconnect', () => {
    redis.zrem(HEARTBEAT_KEY, userId)
  })
})

subscriber.subscribe('match:created', (err) => {
  if (err) console.log('Redis subscribe error:', err.message)
  else     console.log('Subscribed to match:created channel ✓')
})

subscriber.on('message', async (channel, message) => {
  if (channel !== 'match:created') return
  try {
    const { matchId, playerA, playerB, problem, topic, difficulty, mode, reason } = JSON.parse(message)

    let selectedProblem = problem

    if (mode === "friend" && !selectedProblem) {
      const { selectProblem } = await import('./utils/selectProblem.js')
      selectedProblem = await selectProblem(topic, difficulty, playerA.userId, playerB.userId)
      console.log(`Friend match problem selected: ${selectedProblem?.title}`)
    }

    const socketIdA = await redis.get(`socket:${playerA.userId}`)
    const socketIdB = await redis.get(`socket:${playerB.userId}`)

    console.log(`match:created — matchId: ${matchId}`)
    console.log(`Player A: ${playerA.username} socket: ${socketIdA}`)
    console.log(`Player B: ${playerB.username} socket: ${socketIdB}`)

    const isPlayerAOnline = socketIdA && io.sockets.sockets.get(socketIdA)
    const isPlayerBOnline = socketIdB && io.sockets.sockets.get(socketIdB)

    if (!isPlayerAOnline || !isPlayerBOnline) {
      console.log(`Match ${matchId} cancelled — player offline`)
      if (isPlayerAOnline) io.to(socketIdA).emit("match_cancelled", { reason: "Opponent disconnected before match started" })
      if (isPlayerBOnline) io.to(socketIdB).emit("match_cancelled", { reason: "Opponent disconnected before match started" })

      /* Clean up Redis so auto-rejoin doesn't drop users into a ghost match */
      await redis.del(`match:${matchId}`)
      await redis.zrem('active_matches', matchId)
      await redis.del(`user:${playerA.userId}:match`)
      await redis.del(`user:${playerB.userId}:match`)
      console.log(`[cleanup] cleared ghost state for ${matchId}`)
      return
    }
    await redis.hincrby('codejudge:stats', 'battlesPlayed', 1);


    const pendingMatch = {
      matchId,
      playerA: { ...playerA, socketId: socketIdA },
      playerB: { ...playerB, socketId: socketIdB },
      problem: selectedProblem,
      acceptedBy: [],
      createdAt: Date.now(),
    }

    await redis.set(`pending:${matchId}`, JSON.stringify(pendingMatch), "EX", 30)

    io.to(socketIdA).emit("match_found", {
      matchId,
      opponent: { userId: playerB.userId, username: playerB.username, rating: playerB.rating },
      problem:  selectedProblem,
      timeout:  30,
      reason,
    })
    io.to(socketIdB).emit("match_found", {
      matchId,
      opponent: { userId: playerA.userId, username: playerA.username, rating: playerA.rating },
      problem:  selectedProblem,
      timeout:  30,
      reason,
    })

    console.log(`match_found emitted — waiting for acceptance`)

    setTimeout(async () => {
      const pending = await redis.get(`pending:${matchId}`)
      if (!pending) return
      const data = JSON.parse(pending)
      if (data.acceptedBy.length < 2) {
        console.log(`Match ${matchId} timed out`)
        await redis.del(`pending:${matchId}`)
        io.to(socketIdA).emit("match_cancelled", { reason: "Match acceptance timed out" })
        io.to(socketIdB).emit("match_cancelled", { reason: "Match acceptance timed out" })

        /* Clean up — same reason as above */
        await redis.del(`match:${matchId}`)
        await redis.zrem('active_matches', matchId)
        await redis.del(`user:${playerA.userId}:match`)
        await redis.del(`user:${playerB.userId}:match`)
        console.log(`[cleanup] cleared timed-out state for ${matchId}`)
      }
    }, 30000)

  } catch (err) {
    console.log('Error handling match:created:', err.message)
  }
})

resultSubscriber.subscribe("result:ready", (err) => {
  if (err) console.log("Result subscribe error:", err.message)
  else     console.log("Subscribed to result:ready channel ✓")
})

resultSubscriber.on("message", async (channel, message) => {
  if (channel !== "result:ready") return
  try {
    const { jobId, matchId, userId, verdict, testsPassed, totalTests, results, totalExecutionTime } = JSON.parse(message)

    console.log(`result:ready — job: ${jobId} match: ${matchId} verdict: ${verdict}`)

    if (!matchId) {
      const socketId = await redis.get(`socket:${userId}`)
      if (socketId) {
        io.to(socketId).emit("run_result", { verdict, testsPassed, totalTests, results })
        console.log(`Run result emitted to user ${userId}`)
      }
      return
    }

    try {
      const { updatePlayerSubmission } = await import('./services/matchStateService.js')
      await updatePlayerSubmission({ matchId, userId, testsPassed, totalTests })
    } catch (err) {
      console.log("updatePlayerSubmission error:", err.message)
    }

    const computedVerdict = testsPassed === totalTests && totalTests > 0 ? "Accepted" : "Wrong Answer"
    io.to(matchId).emit("verdict", { userId, verdict: computedVerdict, testsPassed, totalTests, results, totalExecutionTime })
    io.to(matchId).emit("opponent_tc_update", { userId, testsPassed, totalTests })
    console.log(`Emitted verdict to match room: ${matchId}`)

  } catch (err) {
    console.log("Error handling result:ready:", err.message)
  }
})

app.use((req, res) => {
  res.json({ message: `${req.url} is Invalid Path` })
})

app.use((err, req, res, next) => {
  console.log("Error name:", err.name)
  if (err.name === "ValidationError") return res.status(400).json({ message: "error occurred", error: err.message })
  if (err.name === "CastError")       return res.status(400).json({ message: "error occurred", error: err.message })

  const errCode  = err.code ?? err.cause?.code ?? err.errorResponse?.code
  const keyValue = err.keyValue ?? err.cause?.keyValue ?? err.errorResponse?.keyValue

  if (errCode === 11000) {
    const field = Object.keys(keyValue)[0]
    const value = keyValue[field]
    return res.status(409).json({ message: "error occurred", error: `${field} "${value}" already exists` })
  }

  if (err.status) return res.status(err.status).json({ message: "error occurred", error: err.message })
  res.status(500).json({ message: "error occurred", error: "Server side error" })
})

httpServer.listen(PORT, () => {
  console.log(`SERVER STARTED ON PORT: ${PORT}`)
})