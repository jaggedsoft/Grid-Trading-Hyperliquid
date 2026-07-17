#!/usr/bin/env node
import { helpText, loadConfig, validateLiveEnvironment } from "./configuration.js";
import { createLiveClients, createPublicClients } from "./hyperliquid-client.js";
import { TradingBot } from "./resilient-trading-bot.js";

async function main() {
  const config = loadConfig();
  if (config.help) {
    console.log(helpText());
    return;
  }
  if (config.dryRun) {
    const { info } = createPublicClients(config.network);
    const bot = new TradingBot({ config, info });
    await bot.runDryRun();
    return;
  }
  const credentials = validateLiveEnvironment();
  const clients = createLiveClients(config.network, credentials);
  const bot = new TradingBot({ config, credentials, ...clients });
  await bot.runLive();
}

main().catch((error) => {
  console.error(`Fatal: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
