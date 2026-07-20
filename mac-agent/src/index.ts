import { MacAgentClient } from "./client";
import { loadMacAgentConfig } from "./config";

const config = await loadMacAgentConfig();
const client = new MacAgentClient(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    client.stop();
    process.exit(0);
  });
}

client.start();
