import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let serial = Promise.resolve();

async function handle(line) {
  const request = JSON.parse(line);
  if (Number(request.params?.delayMs || 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(request.params?.delayMs || 0)));
  }
  if (request.method === "invalid_json") {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.method === "progress") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, progress: true, event: { phase: "one" } })}\n`
    );
    process.stdout.write(
      `${JSON.stringify({ id: request.id, progress: true, event: { phase: "two" } })}\n`
    );
  }
  if (request.method === "fail") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: false, error: { message: "fake failure" } })}\n`
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      id: request.id,
      ok: true,
      result: { method: request.method, pid: process.pid }
    })}\n`
  );
}

lines.on("line", (line) => {
  serial = serial.then(() => handle(line));
});
