// Task-tree utilities mirroring collab/tree.py: any depth, rooted at the episode goal.
import type { Task } from "../types";

export type Interval = [number, number]; // [start, end]; open ends are closed at the episode end upstream

export class TaskTree {
  readonly tasks: Map<string, Task>;
  readonly rootId: string;
  private kids = new Map<string, string[]>();

  constructor(tasks: Task[], rootId: string) {
    this.tasks = new Map(tasks.map((t) => [t.id, t]));
    if (!this.tasks.has(rootId)) throw new Error(`root task ${rootId} not found`);
    this.rootId = rootId;
    for (const t of tasks) {
      if (t.merged_into || t.id === rootId || !t.parent_id || !this.tasks.has(t.parent_id)) continue;
      const list = this.kids.get(t.parent_id) ?? [];
      list.push(t.id);
      this.kids.set(t.parent_id, list);
    }
    for (const list of this.kids.values()) {
      list.sort((a, b) => (this.tasks.get(a)!.start ?? Infinity) - (this.tasks.get(b)!.start ?? Infinity) || a.localeCompare(b));
    }
  }

  resolve(id: string): string {
    const seen = new Set<string>();
    let cur = id;
    while (this.tasks.get(cur)?.merged_into && !seen.has(cur)) {
      seen.add(cur);
      cur = this.tasks.get(cur)!.merged_into!;
    }
    return cur;
  }

  children(id: string): string[] {
    return this.kids.get(id) ?? [];
  }

  parent(id: string): string | null {
    return id === this.rootId ? null : this.tasks.get(id)?.parent_id ?? null;
  }

  depth(id: string): number {
    let d = 0;
    for (let p = this.parent(id); p !== null; p = this.parent(p)) d++;
    return d;
  }

  path(id: string): string[] {
    const out = [id];
    for (let p = this.parent(id); p !== null; p = this.parent(p)) out.unshift(p);
    return out;
  }

  preorder(id: string = this.rootId): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const node = stack.pop()!;
      out.push(node);
      const kids = this.children(node);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  subtree(id: string): Set<string> {
    return new Set(this.preorder(id));
  }

  isLeaf(id: string): boolean {
    return this.children(id).length === 0;
  }

  maxDepth(): number {
    return Math.max(...this.preorder().map((id) => this.depth(id)));
  }
}

export function mergeIntervals(ivs: Interval[]): Interval[] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export interface Item {
  id: string;
  actor: string;
  start: number;
  end: number;
}

/** Per node: the work items on that node or any descendant (for collapsed/rolled-up rows). */
export function rollupItems(tree: TaskTree, direct: Map<string, Item[]>): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  const order = tree.preorder();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    const items = [...(direct.get(node) ?? [])];
    for (const child of tree.children(node)) items.push(...(out.get(child) ?? []));
    out.set(node, items);
  }
  return out;
}

/** Step function of distinct active actors: [t, count] at each change. */
export function activeProfile(items: Item[]): [number, number][] {
  const perActor = new Map<string, Interval[]>();
  for (const it of items) perActor.set(it.actor, [...(perActor.get(it.actor) ?? []), [it.start, it.end]]);
  const edges: [number, number][] = [];
  for (const ivs of perActor.values()) for (const [s, e] of mergeIntervals(ivs)) edges.push([s, 1], [e, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  let count = 0;
  for (const [t, d] of edges) {
    count += d;
    if (out.length && out[out.length - 1][0] === t) out[out.length - 1][1] = count;
    else out.push([t, count]);
  }
  return out;
}

export interface Placed extends Item {
  lane: number;
}

/**
 * Pack items into lanes so that at any instant each active actor occupies one lane: the row's
 * height is the peak number of simultaneously active actors. An actor's overlapping items are
 * merged first, and an actor keeps its previous lane when that lane is free.
 */
export function packLanes(items: Item[]): { placed: Placed[]; lanes: number } {
  const perActor = new Map<string, Item[]>();
  for (const it of items) perActor.set(it.actor, [...(perActor.get(it.actor) ?? []), it]);
  // merge each actor's overlapping items into blocks, remembering the member items
  const blocks: { actor: string; start: number; end: number; members: Item[] }[] = [];
  for (const [actor, list] of perActor) {
    list.sort((a, b) => a.start - b.start);
    let cur: (typeof blocks)[number] | null = null;
    for (const it of list) {
      if (cur && it.start <= cur.end) {
        cur.end = Math.max(cur.end, it.end);
        cur.members.push(it);
      } else {
        cur = { actor, start: it.start, end: it.end, members: [it] };
        blocks.push(cur);
      }
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.actor.localeCompare(b.actor));
  const laneEnd: number[] = [];
  const lastLane = new Map<string, number>();
  const placed: Placed[] = [];
  for (const b of blocks) {
    const prefer = lastLane.get(b.actor);
    let lane = prefer !== undefined && laneEnd[prefer] <= b.start ? prefer : laneEnd.findIndex((end) => end <= b.start);
    if (lane === -1) {
      lane = laneEnd.length;
      laneEnd.push(b.end);
    } else laneEnd[lane] = b.end;
    lastLane.set(b.actor, lane);
    for (const m of b.members) placed.push({ ...m, lane });
  }
  return { placed, lanes: laneEnd.length };
}
