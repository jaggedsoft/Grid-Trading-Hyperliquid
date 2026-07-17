import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmOrdersWithTimeout(timeoutMs, message = "Press ENTER to confirm, or type cancel: ") {
  if (!input.isTTY) throw new Error("preview=true requires an interactive terminal");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(message, { signal: controller.signal });
    return answer.trim().toLowerCase() !== "cancel";
  } catch (error) {
    if (error.name === "AbortError") {
      output.write("\nPreview expired; no orders were submitted.\n");
      return false;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}
