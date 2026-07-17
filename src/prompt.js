import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmOrders(message = "Press ENTER to confirm, or type cancel: ") {
  if (!input.isTTY) throw new Error("preview=true requires an interactive terminal");
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase() !== "cancel";
  } finally {
    rl.close();
  }
}
