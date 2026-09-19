export class TaskboardHttp {
  constructor({ baseUrl = "http://127.0.0.1:47823", actorId = "fusion-poc", actorName = "Fusion POC" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.actorId = actorId;
    this.actorName = actorName;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if ((init.method ?? "GET") !== "GET") {
      headers.set("X-Taskboard-User-Id", this.actorId);
      headers.set("X-Taskboard-User-Name", encodeURIComponent(this.actorName));
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? `Taskboard HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async getTask(taskId) {
    const body = await this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
    return body.task;
  }

  async moveTask(taskId, status, version, binding) {
    const payload = { version, status };
    if (binding) Object.assign(payload, this.#bindingPayload(binding));
    const body = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return body.task;
  }

  async addComment(taskId, { body, binding }) {
    const payload = { body };
    if (binding) Object.assign(payload, this.#bindingPayload(binding));
    const result = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result.comment;
  }

  async acceptTask(taskId, version, { reason }) {
    // Dashi currently models acceptance as an explicit move to done; this adapter
    // deliberately does not bypass its versioned task mutation contract.
    await this.addComment(taskId, { body: `Accepted by Review Gate: ${reason}` });
    return this.moveTask(taskId, "done", version);
  }

  #bindingPayload(binding) {
    return {
      threadId: binding.threadId,
      threadBinding: {
        threadId: binding.threadId,
        codexProjectId: binding.codexProjectId,
        codexProjectKind: binding.codexProjectKind,
        codexHostId: binding.codexHostId,
        workspacePath: binding.workspacePath,
      },
    };
  }
}
