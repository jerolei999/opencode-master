/** opencode-master entrypoint. */

import { loadConfig } from "./config"
import { Master } from "./http/server"

const config = loadConfig()
const master = new Master({ config })

master.start()

const shutdown = () => {
  console.log("[opencode-master] shutting down")
  master.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
