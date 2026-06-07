import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL

const DEFAULT_STARTER = {
  python: '# Write your solution here\n',
  cpp:    '#include<bits/stdc++.h>\nusing namespace std;\nint main(){\n    \n    return 0;\n}',
  java:   'import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        \n    }\n}',
}

const MATCH_DURATION = {
  Easy:   900,
  Medium: 1500,
  Hard:   2400,
}

const useMatchStore = create(
  persist(
    (set, get) => ({

      currentUser:     null,
      isAuthenticated: false,
      authLoading:     false,
      authError:       null,

      isSearching: false,
      matchFound:  false,

      matchId:     null,
      matchStatus: null,
      winner:      null,
      timeLeft:    900,

      problem: null,

      myLanguage: 'python',
      codeByLanguage: {
        python: DEFAULT_STARTER.python,
        cpp:    DEFAULT_STARTER.cpp,
        java:   DEFAULT_STARTER.java,
      },

      myTCResults:     [],
      myVerdict:       null,
      myTestsPassed:   0,
      isSubmitting:    false,
      submissionCount: 0,
      aiUsageCount:    0,
      aiUsageLeft:     5,
      matchStartTime:  null,

      opponent:       null,
      oppSilhouette:  '',
      oppTestsPassed: 0,
      oppTotalTests:  0,
      oppVerdict:     null,
      oppLanguage:    null,
      oppTyping:      false,
      /* Structured presence — replaces the boolean-only oppTyping.
         state:    'coding' | 'reading' | 'thinking' | 'offline' | 'unknown'
         section:  'description' | 'examples' | 'constraints' | 'io' | null
         lastEvent: ms timestamp of the last update (drives the "10s ago" decay)
         online:   tracked separately from state, so we can distinguish
                   "online + thinking" from "offline" cleanly. */
      oppPresence: {
        state:     'unknown',
        section:   null,
        lastEvent: 0,
        online:    false,
      },

      /* Local socket connection state — drives MY "reconnecting" badge */
      myConnection: 'connected',     // 'connected' | 'reconnecting' | 'offline'

      activeHints:   [],
      firstBlood:    false,
      firstBloodBy:  null,
      incomingEmote: null,

      aiReview: null,
      // state
      darkMode: true,

      // actions
      setDarkMode: (value) => set({ darkMode: value }),
      toggleDarkMode: () =>
        set((state) => ({ darkMode: !state.darkMode })),

      login: async (userCred) => {
        try {
          set({ authLoading: true, authError: null })
          const res = await axios.post(`${BASE_URL}/api/auth/login`, userCred, { withCredentials: true })
          set({ authLoading: false, isAuthenticated: true, currentUser: res.data.payload, authError: null })
          return res.data
        } catch (err) {
          set({ authLoading: false, isAuthenticated: false, currentUser: null, authError: err.response?.data?.message || "Login Failed" })
          throw err
        }
      },

      logout: () => set({ currentUser: null, isAuthenticated: false, authLoading: false, authError: null }),

      checkAuth: async () => {
        try {
          set({ authLoading: true })
          const res = await axios.get(`${BASE_URL}/api/auth/me`, { withCredentials: true })
          set({ authLoading: false, isAuthenticated: true, currentUser: res.data.payload, authError: null })
          return res.data
        } catch (err) {
          set({ authLoading: false, isAuthenticated: false, currentUser: null })
          return null
        }
      },

      /* Ask the server: am I in an ongoing match (with > 60s left)?
         Resolves to { active: true, matchId, match } or { active: false }. */
      fetchActiveMatch: async () => {
        try {
          const res = await axios.get(`${BASE_URL}/api/match/active/me`, { withCredentials: true })
          return res.data
        } catch {
          return { active: false }
        }
      },

      setSearching:  (val) => set({ isSearching: val }),
      setMatchFound: (val) => set({ matchFound: val }),

      initMatch: ({ matchId, opponent, problem }) => {
        const timeLeft = MATCH_DURATION[problem?.difficulty] || 900
        set(() => ({
          matchId,
          matchStatus:     'ongoing',
          opponent,
          problem,
          timeLeft,
          winner:          null,
          myLanguage:      'python',
          codeByLanguage: {
            python: problem?.starterCode?.python || DEFAULT_STARTER.python,
            cpp:    problem?.starterCode?.cpp    || DEFAULT_STARTER.cpp,
            java:   problem?.starterCode?.java   || DEFAULT_STARTER.java,
          },
          myTCResults:     [],
          myVerdict:       null,
          myTestsPassed:   0,
          isSubmitting:    false,
          submissionCount: 0,
          aiUsageCount:    0,
          aiUsageLeft:     5,
          matchStartTime:  Date.now(),
          oppSilhouette:   '',
          oppTestsPassed:  0,
          oppTotalTests:   problem?.hiddenTestCases?.length || 0,
          oppVerdict:      null,
          oppTyping:       false,
          oppPresence:     { state: 'unknown', section: null, lastEvent: 0, online: false },
          firstBlood:      false,
          firstBloodBy:    null,
          incomingEmote:   null,
          activeHints:     [],
          matchFound:      true,
          isSearching:     false,
          aiReview:        null,
        }))
      },

      setTimeLeftFromServer: (timeLeft) => set({ timeLeft }),

      setMatchStatus: (status) => set({ matchStatus: status }),

      setWinner: (userId) => set({ winner: userId, matchStatus: 'finished' }),

      tickTimer: () => set((state) => ({ timeLeft: Math.max(0, state.timeLeft - 1) })),

      setMyCode: (code) => {
        const lang = get().myLanguage
        set((state) => ({ codeByLanguage: { ...state.codeByLanguage, [lang]: code } }))
      },

      setMyLanguage: (lang) => set({ myLanguage: lang }),

      setSubmitting: (val) => set({ isSubmitting: val }),

      incrementSubmission: () => set((state) => ({ submissionCount: state.submissionCount + 1 })),

      incrementAIUsage: () => {
        const { aiUsageLeft } = get()
        if (aiUsageLeft <= 0) return false
        set((state) => ({
          aiUsageCount: state.aiUsageCount + 1,
          aiUsageLeft:  state.aiUsageLeft - 1,
        }))
        return true
      },

      setMyVerdict: ({ verdict, results, testsPassed }) => {
        const { firstBlood } = get()
        if (!firstBlood && testsPassed > 0) set({ firstBlood: true, firstBloodBy: 'me' })
        set({ myVerdict: verdict, myTCResults: results, myTestsPassed: testsPassed, isSubmitting: false })
      },

      /* Silhouette no longer claims the opponent is "typing" — presence is
         the source of truth and arrives via its own event. */
      setOppSilhouette: (silhouette) => set({ oppSilhouette: silhouette }),

      setOppTyping: (val) => set({ oppTyping: val }),

      /* Merge a presence update from the opponent. */
      setOppPresence: ({ state, section }) => set((s) => ({
        oppPresence: {
          state:     state || s.oppPresence.state,
          section:   section ?? null,
          lastEvent: Date.now(),
          online:    true,
        }
      })),

      /* Backend told us the opponent's socket dropped. */
      setOppOffline: () => set((s) => ({
        oppPresence: { ...s.oppPresence, state: 'offline', online: false, lastEvent: Date.now() }
      })),

      /* Backend told us the opponent re-joined the match room. */
      setOppOnline: () => set((s) => ({
        oppPresence: { ...s.oppPresence, online: true, state: s.oppPresence.state === 'offline' ? 'thinking' : s.oppPresence.state, lastEvent: Date.now() }
      })),

      setMyConnection: (status) => set({ myConnection: status }),

      setOppProgress: ({ testsPassed, totalTests }) => {
        const { firstBlood } = get()
        if (!firstBlood && testsPassed > 0) set({ firstBlood: true, firstBloodBy: 'opponent' })
        set({ oppTestsPassed: testsPassed, oppTotalTests: totalTests })
      },

      setOppVerdict: ({ verdict, testsPassed }) => set({ oppVerdict: verdict, oppTestsPassed: testsPassed }),

      setAIReview: (review) => set({ aiReview: review }),

      revealHint: (index) => set((state) => ({ activeHints: [...state.activeHints, index] })),

      setIncomingEmote: (emote) => {
        set({ incomingEmote: emote })
        setTimeout(() => set({ incomingEmote: null }), 2500)
      },

      resetMatch: () => {
        // 1. Reset every match‑related field (same as before)
        set({
          matchId:         null,
          matchStatus:     null,
          winner:          null,
          timeLeft:        900,
          problem:         null,
          myLanguage:      'python',
          codeByLanguage: {
            python: DEFAULT_STARTER.python,
            cpp:    DEFAULT_STARTER.cpp,
            java:   DEFAULT_STARTER.java,
          },
          myTCResults:     [],
          myVerdict:       null,
          myTestsPassed:   0,
          isSubmitting:    false,
          submissionCount: 0,
          aiUsageCount:    0,
          aiUsageLeft:     5,
          matchStartTime:  null,
          opponent:        null,
          oppSilhouette:   '',
          oppTestsPassed:  0,
          oppTotalTests:   0,
          oppVerdict:      null,
          oppTyping:       false,
          firstBlood:      false,
          firstBloodBy:    null,
          incomingEmote:   null,
          activeHints:     [],
          matchFound:      false,
          isSearching:     false,
          aiReview:        null,
        });

        // 2. Grab the auth info BEFORE wiping storage
        const { currentUser, isAuthenticated } = get();

        // 3. Wipe everything from localStorage
        useMatchStore.persist.clearStorage();

        // 4. Re‑save only the auth fields (triggers a new persist write)
        set({ currentUser, isAuthenticated });
      },

    }),

    {
      name: 'codejudge-storage',
      partialize: (state) => ({
        currentUser:     state.currentUser,
        isAuthenticated: state.isAuthenticated,
        matchId:         state.matchId,
        matchStatus:     state.matchStatus,
        timeLeft:        state.timeLeft,
        winner:          state.winner,
        problem:         state.problem,
        myLanguage:      state.myLanguage,
        codeByLanguage:  state.codeByLanguage,
        opponent:        state.opponent,
        myVerdict:       state.myVerdict,
        myTestsPassed:   state.myTestsPassed,
        myTCResults:     state.myTCResults,
        oppVerdict:      state.oppVerdict,
        oppTestsPassed:  state.oppTestsPassed,
        oppTotalTests:   state.oppTotalTests,
        aiUsageLeft:     state.aiUsageLeft,
        matchStartTime:  state.matchStartTime,
      }),
    }
  )
)

export default useMatchStore