// Daemon entry point (bundled to dist/agent.mjs; what the LaunchAgent runs).
import { failStartup, runDaemon } from "./daemon";

runDaemon().catch(failStartup);
