// Mirrors collab/server.py snapshot(): core records (neutral trace format) plus annotations.

export type Provenance = "source" | "llm" | "heuristic" | "human";
export type TaskStatus = "done" | "abandoned" | "blocked" | "ongoing";

export interface Manifest {
  id: string;
  name: string | null;
  time_unit: "s" | "step";
  display_tz: string | null;
  capabilities: Partial<Record<"spans" | "action_spans" | "reasoning" | "channels" | "recipients" | "reply_to" | "task_tree", boolean>> | null;
  attrs: Record<string, unknown> | null;
}

export interface Actor {
  id: string;
  name: string;
  kind: "agent" | "human" | "system";
  role: string | null;
  attrs: { model?: string; family?: string; icon?: string } | null;
}

export interface Channel {
  id: string;
  name: string;
}

export interface Task {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  scope: "shared" | "individual" | null;
  assignees: string[] | null;
  start: number | null;
  end: number | null;
  status: TaskStatus | null;
  attrs: { anchors?: string[]; decision?: string; reason?: string; n_spans?: number } | null;
  provenance: Provenance;
  confidence: number | null;
  merged_into: string | null;
}

export interface EpisodeSummary {
  id: string;
  name: string | null;
  dataset_id: string | null;
  root_task_id: string;
  start: number;
  end: number | null;
  actors: string[];
  channels: string[] | null;
  attrs: Record<string, unknown> | null;
  root_name: string | null;
  scope: "shared" | "individual" | null;
  status: TaskStatus | null;
  time_unit?: "s" | "step" | null;
  display_tz?: string | null;
}

export interface Message {
  id: string;
  t: number;
  sender: string;
  channel_id: string | null;
  recipients: string[] | null;
  reply_to: string[] | null;
  text: string;
  has_reasoning: boolean;
  episode_id: string | null;
}

export interface Span {
  id: string;
  actor: string;
  start: number;
  end: number | null;
  kind: "work" | "wait" | "action" | "other";
  label: string;
  parent_id: string | null;
  task_id: string | null;
  attrs: { waiting_on?: { actor?: string; task?: string; external?: string }; source?: string } | null;
}

export interface EventRecord {
  id: string;
  t: number;
  actor: string | null;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface Sentence {
  id: string;
  message_id: string;
  idx: number;
  start_char: number;
  end_char: number;
}

export interface SpanTask { episode_id: string; span_id: string; task_id: string; provenance: Provenance; confidence: number | null }
export interface SentenceTask { episode_id: string; sentence_id: string; task_id: string; provenance: Provenance; confidence: number | null }
export interface Addressee { message_id: string; actor_id: string; provenance: Provenance; confidence: number | null }
export interface Wait { span_id: string; target_kind: "task" | "actor" | "external"; target_id: string | null; target_text: string | null; provenance: Provenance }
export interface Loop { episode_id: string; id: string; actor: string; kind: "retry" | "polling"; task_id: string | null; span_ids: string[]; count: number; confidence: number | null }
export interface Overlap { episode_id: string; id: string; task_id: string; actors: string[]; start: number; end: number; coordinated: number }
export type Act = "inform" | "narrate" | "wait" | "question" | "answer" | "request" | "propose" | "commit" | "accept" | "reject"
  | "thank" | "correct" | "social";
export type Relation = "answers" | "accepts" | "rejects" | "commits_to" | "fulfills" | "updates" | "acknowledges" | "corrects" | "elaborates";
export interface ActRow { sentence_id: string; act: Act; provenance: Provenance; confidence: number | null }
export interface ActLink { src_id: string; dst_id: string; relation: Relation; provenance: Provenance; confidence: number | null }
export type How = "asked" | "proposed" | "joined" | "self" | "none";
export interface Trigger {
  episode_id: string; task_id: string; worker: string; triggered_by: string | null; how: How;
  evidence: string[] | null; provenance: Provenance; confidence: number | null; note: string | null;
}
export interface InfluenceRow { episode_id: string; src: string; dst: string; how: How; effort: number; n_tasks: number; tasks: string[] }

export interface Snapshot {
  seq: number;
  manifest: Manifest | null;
  episode: EpisodeSummary;
  actors: Actor[];
  channels: Channel[];
  tasks: Task[];
  messages: Message[];
  spans: Span[];
  events: EventRecord[];
  sentences: Sentence[];
  span_task: SpanTask[];
  sentence_task: SentenceTask[];
  acts: ActRow[];
  act_links: ActLink[];
  addressees: Addressee[];
  waits: Wait[];
  loops: Loop[];
  overlaps: Overlap[];
  triggers: Trigger[];
  influence: InfluenceRow[];
  metrics: unknown[];
}
