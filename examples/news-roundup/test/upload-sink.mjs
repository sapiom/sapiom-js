// Local sink for presigned-PUT calls during sapiom_dev_agents_run_local.
// Accepts any method/path with 200 so uploadPublicFile's fetch succeeds.
import { createServer } from "node:http";
const port = Number(process.env.PORT ?? 4599);
createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}).listen(port, () => console.log(`upload sink on ${port}`));
