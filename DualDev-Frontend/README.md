src/
├── pages/
│   ├── Home.jsx
│   ├── Match.jsx         ← main game screen
│   ├── Result.jsx
│   └── Leaderboard.jsx
│
├── components/
│   ├── editor/
│   │   ├── CodeEditor.jsx       ← Monaco wrapper
│   │   └── LanguageSelect.jsx
│   ├── match/
│   │   ├── OpponentPanel.jsx    ← silhouette + progress
│   │   ├── Silhouette.jsx       ← tokenizer + render
│   │   ├── TCBar.jsx            ← TC1✅ TC2❌ dots
│   │   ├── Timer.jsx            ← countdown
│   │   └── EmoteBar.jsx
│   ├── verdict/
│   │   ├── VerdictPanel.jsx     ← AC/WA/TLE display
│   │   └── VerdictBadge.jsx
│   └── ui/
│       ├── Button.jsx
│       └── Badge.jsx
│
├── hooks/
│   ├── useSocket.js       ← Socket.io connection
│   ├── useMatch.js        ← match state logic
│   ├── useTimer.js        ← countdown logic
│   └── useSilhouette.js   ← tokenizer logic
│
├── socket/
│   └── socket.js          ← single socket instance
│
├── utils/
│   └── tokenizer.js       ← silhouette generator
│
├── store/
│   └── matchStore.js      ← Zustand global state
│
└── api/
    └── submit.js          ← axios calls to backend
    

### need to add 
- result route and its UI 
- leaderboard ,routes and UI
- Wrong verdict need to change in aws lambda

┌─────────────────────────────────────────────┐
│  codeJUDGE                                  │
├─────────────────────────────────────────────┤
│                                             │
│              🏆  YOU WON                    │  ← big win/lose
│           (or 💀 YOU LOST)                  │
│                                             │
│   YOU              vs        OPPONENT       │
│   5/5 ✅                     3/5 ✅        │
│   1m 42s                     2m 18s         │
│   Python                     C++            │
│                                             │
│   Rating Change                             │
│   1420 → 1448    +28 ↑                      │  ← ELO change
│                                             │
│   [ 🔄 Rematch ]    [ 🏠 Home ]            │
│                                             │
├─────────────────────────────────────────────┤
│  YOUR SOLUTION          THEIR SOLUTION      │
│  def two_sum(...):      ▓▓▓ ▓▓▓▓▓▓(...):    │  ← post match
│  ...                    ...                 │    silhouette reveal
└─────────────────────────────────────────────┘

### leader board 
┌─────────────────────────────────────────────┐
│  codeJUDGE                    Leaderboard   │
├─────────────────────────────────────────────┤
│  GLOBAL RANKINGS              [ This Week ▼]│
│                                             │
│  #    Player         Rating   W    L   Win% │
│  ─────────────────────────────────────────  │
│  🥇1  player123      1840     82   12  87%  │
│  🥈2  coder456       1792     71   18  80%  │
│  🥉3  devguru        1750     65   21  75%  │
│     4  you ←         1448     24   8   75%  │  ← highlighted
│     5  ninja99       1430     55   28  66%  │
│     6  algopro       1398     48   30  61%  │
│     ...                                     │
└─────────────────────────────────────────────┘
-> start battle to how it works 
click to navigate for that section 
-> submissions should nt trust verdict is should use check testsPassed: 0 to totalTests: 6
-> force users from home to match page if they are in match
-> no mobile view
