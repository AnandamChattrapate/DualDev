import "./workers/submissionWorker.js";

// MATCHMAKING WORKER
import startMatchmakingWorker from "./workers/matchmakingWorker.js";

console.log("Worker Server Running");
startMatchmakingWorker();

