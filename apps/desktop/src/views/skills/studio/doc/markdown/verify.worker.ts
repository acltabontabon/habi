import { verifyText } from "./verify";

self.onmessage = (e: MessageEvent<{ id: number; output: string; canon: string }>) => {
  const { id, output, canon } = e.data;
  self.postMessage({ id, verdict: verifyText(output, canon) });
};
