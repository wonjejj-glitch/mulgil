import { produce } from 'immer';
import { create } from 'zustand';
import { MAX_UNDO_STEPS } from '../config';
import {
  addLink,
  addNode,
  computeLinkLength,
  deleteLink,
  deleteNodes,
  moveNode,
  renameLink,
  renameNode,
  reverseLink,
  splitPipe,
} from '../core/model/networkEdit';
import {
  createEmptyModel,
  type LinkType,
  type LngLat,
  type NetworkLink,
  type NetworkModel,
  type NetworkNode,
  type NodeType,
} from '../core/model/types';

type Recipe = (draft: NetworkModel) => void;

interface NetworkState {
  model: NetworkModel;
  fileName: string | null;
  past: NetworkModel[];
  future: NetworkModel[];
  /** 모델이 바뀔 때마다 1 씩 증가 — 해석 결과가 최신인지 판단하는 데 쓴다. */
  revision: number;
  /** 같은 키의 연속 변경(드래그 등)은 Undo 한 단계로 묶는다. */
  mergeKey: string | null;

  newProject: () => void;
  loadModel: (model: NetworkModel, fileName: string | null) => void;
  commit: (recipe: Recipe, mergeKey?: string) => void;
  sealHistory: () => void;
  undo: () => void;
  redo: () => void;

  addNode: (type: NodeType, position: LngLat) => string;
  addLink: (type: LinkType, startNodeId: string, endNodeId: string, vertices?: LngLat[]) => string | null;
  moveNode: (id: string, position: LngLat, mergeKey?: string) => void;
  updateNode: (id: string, patch: Partial<NetworkNode>) => void;
  updateLink: (id: string, patch: Partial<NetworkLink>) => void;
  setPipeAutoLength: (id: string, auto: boolean) => void;
  renameNode: (oldId: string, newId: string) => boolean;
  renameLink: (oldId: string, newId: string) => boolean;
  reverseLink: (id: string) => void;
  deleteNode: (id: string) => void;
  deleteLink: (id: string) => void;
  splitPipeAt: (pipeId: string, point: LngLat) => string | null;
}

export const useNetworkStore = create<NetworkState>()((set, get) => ({
  model: createEmptyModel(),
  fileName: null,
  past: [],
  future: [],
  revision: 0,
  mergeKey: null,

  newProject: () =>
    set((s) => ({ model: createEmptyModel(), fileName: null, past: [], future: [], revision: s.revision + 1, mergeKey: null })),

  loadModel: (model, fileName) =>
    set((s) => ({ model, fileName, past: [], future: [], revision: s.revision + 1, mergeKey: null })),

  commit: (recipe, mergeKey) => {
    const state = get();
    const next = produce(state.model, recipe);
    if (next === state.model) return;
    const merge = mergeKey !== undefined && mergeKey === state.mergeKey;
    set({
      model: next,
      past: merge ? state.past : [...state.past, state.model].slice(-MAX_UNDO_STEPS),
      future: [],
      revision: state.revision + 1,
      mergeKey: mergeKey ?? null,
    });
  },

  sealHistory: () => set({ mergeKey: null }),

  undo: () => {
    const { past, future, model, revision } = get();
    if (past.length === 0) return;
    set({
      model: past[past.length - 1],
      past: past.slice(0, -1),
      future: [model, ...future],
      revision: revision + 1,
      mergeKey: null,
    });
  },

  redo: () => {
    const { past, future, model, revision } = get();
    if (future.length === 0) return;
    set({
      model: future[0],
      past: [...past, model],
      future: future.slice(1),
      revision: revision + 1,
      mergeKey: null,
    });
  },

  addNode: (type, position) => {
    let id = '';
    get().commit((draft) => {
      id = addNode(draft, type, position).id;
    });
    return id;
  },

  addLink: (type, startNodeId, endNodeId, vertices = []) => {
    let id: string | null = null;
    get().commit((draft) => {
      id = addLink(draft, type, startNodeId, endNodeId, vertices)?.id ?? null;
    });
    return id;
  },

  moveNode: (id, position, mergeKey) => get().commit((draft) => moveNode(draft, id, position), mergeKey),

  updateNode: (id, patch) =>
    get().commit((draft) => {
      const node = draft.nodes[id];
      if (node) Object.assign(node, patch);
    }),

  updateLink: (id, patch) =>
    get().commit((draft) => {
      const link = draft.links[id];
      if (!link) return;
      Object.assign(link, patch);
      // 연장을 직접 입력하면 수동 고정으로 전환한다.
      if (link.type === 'pipe' && 'length' in patch) link.isCustomLength = true;
    }),

  setPipeAutoLength: (id, auto) =>
    get().commit((draft) => {
      const link = draft.links[id];
      if (!link || link.type !== 'pipe') return;
      link.isCustomLength = !auto;
      if (auto) link.length = computeLinkLength(draft, link);
    }),

  renameNode: (oldId, newId) => {
    let ok = false;
    get().commit((draft) => {
      ok = renameNode(draft, oldId, newId);
    });
    return ok || oldId === newId;
  },

  renameLink: (oldId, newId) => {
    let ok = false;
    get().commit((draft) => {
      ok = renameLink(draft, oldId, newId);
    });
    return ok || oldId === newId;
  },

  reverseLink: (id) => get().commit((draft) => reverseLink(draft, id)),
  deleteNode: (id) => get().commit((draft) => deleteNodes(draft, [id])),
  deleteLink: (id) => get().commit((draft) => deleteLink(draft, id)),

  splitPipeAt: (pipeId, point) => {
    let nodeId: string | null = null;
    get().commit((draft) => {
      nodeId = splitPipe(draft, pipeId, point)?.nodeId ?? null;
    });
    return nodeId;
  },
}));
