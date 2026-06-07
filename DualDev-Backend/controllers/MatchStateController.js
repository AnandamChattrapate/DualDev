import {
  createMatchState,
  getMatchState,
  getMatchWithTimer,
  updatePlayerSubmission,
  incrementAIUsage,
  finishMatch,
  getActiveMatchForUser,
} from "../services/matchStateService.js"
import matchmakingRedis from "../config/matchmakingRedis.js"

export const createMatch = async (req, res) => {
  try {
    const { matchId, playerA, playerB, problem } = req.body

    const match = await createMatchState({
      matchId,
      playerA,
      playerB,
      problem,
    })

    res.json({ success: true, match })

  } catch (err) {
    console.log("error in createMatch:", err.message)
    res.status(500).json({ success: false, message: err.message })
  }
}

export const fetchMatchState = async (req, res, next) => {
  try {
    const { matchId } = req.params

    const match = await getMatchState(matchId)

    if (!match) return res.status(404).json({ success: false, message: "Match not found" })

    res.json({ success: true, match })

  } catch (err) {
    next(err)
  }
}

export const fetchMatchWithTimer = async (req, res, next) => {
  try {
    const { matchId } = req.params

    const match = await getMatchWithTimer(matchId)

    if (!match) return res.status(404).json({ success: false, message: "Match not found" })

    res.json({ success: true, match })

  } catch (err) {
    next(err)
  }
}

export const updateSubmission = async (req, res, next) => {
  try {
    const { matchId, userId, testsPassed, totalTests } = req.body

    const updatedMatch = await updatePlayerSubmission({
      matchId,
      userId,
      testsPassed,
      totalTests,
    })

    res.json({ success: true, match: updatedMatch })

  } catch (err) {
    next(err)
  }
}

export const updateAIUsage = async (req, res, next) => {
  try {
    const { matchId } = req.body
    const userId = req.user._id.toString()

    const match = await incrementAIUsage({ matchId, userId })

    res.json({ success: true, match })

  } catch (err) {
    next(err)
  }
}

export const endMatch = async (req, res, next) => {
  try {
    const { matchId, winner } = req.body

    const match = await finishMatch({ matchId, winner })

    res.json({ success: true, match })

  } catch (err) {
    next(err)
  }
}

/* GET /api/match/active/me — "Am I in an ongoing match right now?"
   Returns { active: true, match, matchId } if user is mid-match AND
   timeLeft > 60s buffer; otherwise { active: false }.                 */
export const getMyActiveMatch = async (req, res, next) => {
  try {
    const userId = req.user?.userId
    console.log(`[active-match] GET /active/me from user=${userId}`)

    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authenticated" })
    }

    const match = await getActiveMatchForUser(userId)
    if (!match) {
      return res.json({ success: true, active: false, reason: "no_match" })
    }

    const BUFFER = 60
    if (match.timeLeft == null || match.timeLeft <= BUFFER) {
      console.log(`[active-match] near_end: timeLeft=${match.timeLeft}s — not redirecting`)
      return res.json({ success: true, active: false, reason: "near_end", timeLeft: match.timeLeft })
    }

    console.log(`[active-match] → redirecting user ${userId} to match ${match.matchId}`)
    return res.json({
      success: true,
      active:  true,
      matchId: match.matchId,
      match,
    })
  } catch (err) {
    console.log("[active-match] error:", err.message)
    next(err)
  }
}

/* TEMP DEBUG: GET /api/match/debug/active — dumps Redis state for current user.
   Remove this once auto-rejoin is verified working. */
export const debugActiveMatch = async (req, res, next) => {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ success: false, message: "Not authenticated" })

    const userMatchKey   = `user:${userId}:match`
    const matchIdFromKey = await matchmakingRedis.get(userMatchKey)

    let matchSnapshot = null
    let timerInfo     = null
    if (matchIdFromKey) {
      const raw = await matchmakingRedis.get(`match:${matchIdFromKey}`)
      matchSnapshot = raw ? JSON.parse(raw) : null
      timerInfo = await getMatchWithTimer(matchIdFromKey)
    }

    /* List ALL user:*:match keys so we can see if it was set under
       a different userId format (very common gotcha). */
    let allUserMatchKeys = []
    try {
      const scan = await matchmakingRedis.keys("user:*:match")
      allUserMatchKeys = scan || []
    } catch (e) {}

    return res.json({
      success:           true,
      yourUserId:        userId,
      lookupKey:         userMatchKey,
      matchIdFromKey:    matchIdFromKey || null,
      matchSnapshotExists: !!matchSnapshot,
      matchStatus:       matchSnapshot?.status,
      timeLeft:          timerInfo?.timeLeft,
      bufferSeconds:     60,
      willRedirect:      !!(timerInfo && timerInfo.status === "ongoing" && timerInfo.timeLeft > 60),
      allUserMatchKeysInRedis: allUserMatchKeys,
    })
  } catch (err) {
    next(err)
  }
}