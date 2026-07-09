// Minimal zero-dependency web app used by the e2e. Binds the port injected by
// the deploy recipe (PORT) — deploy sets it to the app's declared port, which
// overrides the sandbox runtime's injected PORT=80. Serves /health for readiness.
const http = require('node:http');

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>sapiom e2e</title><h1>deployed via applications-core</h1>');
});

server.listen(port, () => {
  console.log(`listening on ${port}`);
});
