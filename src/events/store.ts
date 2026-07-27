/**
 * Event log v0: interface + in-memory implementation.
 * Roadmap: SQLite persistence via node:sqlite (see schema.sql), then connectors
 * (GitHub PRs, CI, deploys) writing through this interface. Ingestion is plain ETL —
 * no LLM calls in this layer (see CLAUDE.md design principles).
 */

export type EventKind =
  | "commit"
  | "pr"
  | "review_comment"
  | "decision"
  | "ci_run"
  | "deploy"
  | "incident"
  | "simulation";

export interface KeelEvent {
  kind: EventKind;
  externalId?: string;
  occurredAt: string; // ISO 8601
  actor?: string;
  title?: string;
  payload: Record<string, unknown>;
  files?: string[];
}

export interface EventStore {
  append(event: KeelEvent): Promise<void>;
  byFile(path: string, limit?: number): Promise<KeelEvent[]>;
  byKind(kind: EventKind, limit?: number): Promise<KeelEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  private events: KeelEvent[] = [];

  async append(event: KeelEvent): Promise<void> {
    this.events.push(event);
  }

  async byFile(path: string, limit = 50): Promise<KeelEvent[]> {
    return this.events
      .filter((e) => e.files?.includes(path))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async byKind(kind: EventKind, limit = 50): Promise<KeelEvent[]> {
    return this.events
      .filter((e) => e.kind === kind)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }
}
