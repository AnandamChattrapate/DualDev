import express from "express"
import {
  createMatch,
  fetchMatchState,
  fetchMatchWithTimer,
  updateSubmission,
  updateAIUsage,
  endMatch,
  getMyActiveMatch,
  debugActiveMatch,
} from "../controllers/MatchStateController.js"
import { authMiddleware } from "../middlewares/authMiddleware.js"

const router = express.Router()

router.post("/create",                            createMatch)
router.get("/active/me",    authMiddleware,       getMyActiveMatch)
router.get("/debug/active", authMiddleware,       debugActiveMatch)   // TEMP
router.get("/:matchId",                           fetchMatchState)
router.get("/:matchId/timer", authMiddleware,     fetchMatchWithTimer)
router.post("/submission",                        updateSubmission)
router.post("/ai-usage",    authMiddleware,       updateAIUsage)
router.post("/end",         authMiddleware,       endMatch)

export const MatchStateRouter = router