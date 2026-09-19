import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { TaskboardHttp } from "../src/adapters/taskboard-http.mjs";

function serverOnce(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

test("Taskboard adapter sends versioned move with native five-field binding", async () => {
  const requests = [];
  const { server, url } = await serverOnce(async (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ task: { id: "T1", version: 4, status: "in_review" } }));
    });
  });

  try {
    const client = new TaskboardHttp({ baseUrl: url });
    await client.moveTask("T1", "in_review", 3, {
      threadId: "exec-thread",
      codexProjectId: "project-1",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "D:/poc/project",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/api/tasks/T1/move");
    assert.equal(requests[0].headers["x-taskboard-user-id"], "fusion-poc");
    assert.deepEqual(requests[0].body, {
      version: 3,
      status: "in_review",
      threadId: "exec-thread",
      threadBinding: {
        threadId: "exec-thread",
        codexProjectId: "project-1",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "D:/poc/project",
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
