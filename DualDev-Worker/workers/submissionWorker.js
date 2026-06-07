import { Worker } from "bullmq"
import IORedis from "ioredis"
import { config } from "dotenv"
import redisConfig from "../config/redis.js"

config()

const LAMBDA_URL = process.env.LAMBDA_URL

// ─────────────────────────────────────────
// SEPARATE PUBLISHER CLIENT
// BullMQ uses redisConfig — publisher is separate
// ioredis rule: never reuse BullMQ connection for pub/sub
// ─────────────────────────────────────────
const publisher = new IORedis({
  host:                 process.env.REDIS_HOST,
  port:                 Number(process.env.REDIS_PORT),
  username:             "default",
  password:             process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  connectTimeout:       10000,
})

publisher.on("connect", () => console.log("Publisher Redis Connected"))
publisher.on("error",  (err) => console.log("Publisher Redis Error:", err.message))

const submissionWorker = new Worker(
  "submission-queue",

  async (job) => {
    try {
      console.log("\n========================")
      console.log(`Processing Job ${job.id}`)
      console.log("========================\n")

      const {
        language,
        code,
        input     = "",
        testCases = [],
        jobId,
        matchId,
        userId
      } = job.data

      console.log("Language:", language)
      console.log("MatchId :", matchId)
      console.log("UserId  :", userId)

      // ── Execute on Lambda ──────────────────
      const response = await fetch(LAMBDA_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ language, code, input, testCases, jobId }),
        signal:  AbortSignal.timeout(30000),
      })

      const result = await response.json()

      console.log("\nExecution Result")
      console.log(result)

      // ── Publish result to Redis ────────────
      // Main server is subscribed to "result:ready"
      // This replaces the HTTP POST to /api/results
      await publisher.publish("result:ready", JSON.stringify({
        jobId,
        matchId,
        userId,
        verdict:            result.verdict,
        testsPassed:        result.testsPassed,
        totalTests:         result.totalTests,
        results:            result.results,
        totalExecutionTime: result.totalExecutionTime,
      }))

      console.log("\nResult published to Redis ✓")
      console.log("Job Completed Successfully")

      return result

    } catch (err) {
      console.log("\nWorker Processing Error:", err.message)
      throw err
    }
  },

  {
    connection: redisConfig,
    concurrency: 5,
    removeOnComplete: { age: 3600,       count: 1000 },
    removeOnFail:     { age: 24 * 3600               },
  }
)

submissionWorker.on("completed", (job) => {
  console.log(`\nJob ${job.id} completed`)
})

submissionWorker.on("failed", (job, err) => {
  console.log(`\nJob ${job?.id} failed — ${err.message}`)
})

submissionWorker.on("error", (err) => {
  console.log("\nWorker Internal Error:", err.message)
})

console.log("Submission Worker Started")

export default submissionWorker