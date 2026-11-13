/**
 * 자동 백업 (기존 하수 설계 프로그램의 .BAK 아이디어): 관망을 고칠 때마다 몇 초 뒤 브라우저 저장소(IndexedDB)에 남긴다.
 * 창을 닫거나 브라우저가 멈춰도 다음에 열 때 시작 화면에서 '지난 작업 복원'을 누르면 된다.
 * 자료는 이 컴퓨터의 이 브라우저에만 저장되고 어디로도 보내지 않는다.
 */
import type { NetworkModel } from '../core/model/types';
import type { SewerProject } from '../core/sewer/types';
import { useNetworkStore } from '../store/useNetworkStore';
import { useSewerStore } from '../store/useSewerStore';

export interface Backup {
  model: NetworkModel;
  fileName: string | null;
  savedAt: number;
  nodes: number;
  links: number;
}

const DB = 'mulgil';
const STORE = 'backup';
const KEY = 'network';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function readBackup(): Promise<Backup | null> {
  try {
    return ((await tx('readonly', (s) => s.get(KEY))) as Backup | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeBackup(b: Backup): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(b, KEY));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)은 조용히 건너뛴다.
  }
}

let started = false;

/** 관망이 바뀔 때마다 3초 뒤(연속 편집은 묶어서) 백업한다. 빈 관망은 백업하지 않는다(기존 백업 보존). */
export function startAutoBackup(): void {
  if (started || typeof indexedDB === 'undefined') return;
  started = true;
  let timer = 0;
  let lastRevision = useNetworkStore.getState().revision;
  useNetworkStore.subscribe((state) => {
    if (state.revision === lastRevision) return;
    lastRevision = state.revision;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const { model, fileName } = useNetworkStore.getState();
      const nodes = Object.keys(model.nodes).length;
      if (nodes === 0) return;
      void writeBackup({ model, fileName, savedAt: Date.now(), nodes, links: Object.keys(model.links).length });
    }, 3000);
  });
}

/* ------------------------------------------------------------------ 하수 관망 백업 */

const SEWER_KEY = 'sewer';
let sewerStarted = false;

interface SewerBackup {
  project: SewerProject;
  savedAt: number;
}

/**
 * 하수 관망(useSewerStore.project)도 바뀔 때마다 3초 뒤 저장하고, 앱을 처음 열 때 지난 하수 관망을 불러온다
 * (하수 저장소는 기본으로 예제를 들고 시작하므로, 백업이 있으면 그것으로 바꾼다).
 */
export function startSewerBackup(): void {
  if (sewerStarted || typeof indexedDB === 'undefined') return;
  sewerStarted = true;
  void (async () => {
    try {
      const b = (await tx('readonly', (s) => s.get(SEWER_KEY))) as SewerBackup | undefined;
      if (b?.project?.nodes?.length) {
        const store = useSewerStore.getState();
        store.setProject(b.project);
        useSewerStore.setState({ past: [], future: [] });
      }
    } catch {
      // 저장소를 못 쓰면 예제로 시작한다
    }
    let timer = 0;
    let last = useSewerStore.getState().project;
    useSewerStore.subscribe((state) => {
      if (state.project === last) return;
      last = state.project;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const project = useSewerStore.getState().project;
        if (project.nodes.length === 0) return;
        void tx('readwrite', (s) => s.put({ project, savedAt: Date.now() } satisfies SewerBackup, SEWER_KEY)).catch(() => undefined);
      }, 3000);
    });
  })();
}
