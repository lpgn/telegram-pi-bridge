import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

export class PiSessionPool {
  constructor({ workspaceDir, agentDir, thinkingLevel, model, sessionsDir, authStorage, modelRegistry }) {
    this.workspaceDir = workspaceDir;
    this.agentDir = agentDir;
    this.thinkingLevel = thinkingLevel;
    this.model = model;
    this.sessionsDir = sessionsDir;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.sessions = new Map();
  }

  getSessionDir(chatId) {
    return path.join(this.sessionsDir, String(chatId));
  }

  async create(chatId, sessionManager) {
    const sessionDir = this.getSessionDir(chatId);
    await mkdir(sessionDir, { recursive: true });

    return createAgentSession({
      cwd: this.workspaceDir,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      sessionManager,
    }).then(({ session, modelFallbackMessage }) => {
      if (modelFallbackMessage) {
        console.warn(`[chat ${chatId}] ${modelFallbackMessage}`);
      }
      return session;
    });
  }

  // Drop a failed creation from the cache so the next message retries instead
  // of awaiting the same rejected promise forever.
  #track(key, entry) {
    entry.catch(() => {
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    });
    this.sessions.set(key, entry);
    return entry;
  }

  async get(chatId) {
    const key = String(chatId);
    if (this.sessions.has(key)) return this.sessions.get(key);
    const entry = this.create(chatId, SessionManager.continueRecent(this.workspaceDir, this.getSessionDir(chatId)));
    return this.#track(key, entry);
  }

  async replace(chatId, sessionManager) {
    const key = String(chatId);
    await this.dispose(chatId);
    const entry = this.create(chatId, sessionManager);
    return this.#track(key, entry);
  }

  async newSession(chatId) {
    return this.replace(chatId, SessionManager.create(this.workspaceDir, this.getSessionDir(chatId)));
  }

  async list(chatId) {
    const sessionDir = this.getSessionDir(chatId);
    await mkdir(sessionDir, { recursive: true });
    return SessionManager.list(this.workspaceDir, sessionDir);
  }

  async resume(chatId, sessionPath) {
    return this.replace(chatId, SessionManager.open(sessionPath, this.getSessionDir(chatId)));
  }

  async dispose(chatId) {
    const key = String(chatId);
    const existing = this.sessions.get(key);
    if (existing) {
      try {
        const session = await existing;
        session.dispose();
      } catch {
        // Ignore broken session during dispose.
      }
      this.sessions.delete(key);
    }
  }

  async clear(chatId) {
    await this.dispose(chatId);
    await rm(this.getSessionDir(chatId), { recursive: true, force: true });
  }

  async disposeAll() {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) {
      try {
        (await entry).dispose();
      } catch {
        // Ignore dispose failures.
      }
    }
  }
}
