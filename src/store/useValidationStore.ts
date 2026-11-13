import { create } from 'zustand';
import { DEFAULT_VALIDATION_OPTIONS, type ValidationIssue, type ValidationOptions } from '../core/validation';

export type ValidationStatus = 'idle' | 'running' | 'done' | 'error';

interface ValidationState {
  status: ValidationStatus;
  issues: ValidationIssue[];
  /** 검증을 수행한 시점의 관망 revision. */
  checkedRevision: number;
  activeIssueId: string | null;
  options: ValidationOptions;

  setRunning: () => void;
  setIssues: (issues: ValidationIssue[], revision: number) => void;
  setFailed: () => void;
  setActiveIssue: (id: string | null) => void;
  setOptions: (options: Partial<ValidationOptions>) => void;
  clear: () => void;
}

export const useValidationStore = create<ValidationState>()((set) => ({
  status: 'idle',
  issues: [],
  checkedRevision: -1,
  activeIssueId: null,
  options: DEFAULT_VALIDATION_OPTIONS,

  setRunning: () => set({ status: 'running' }),
  setIssues: (issues, revision) => set({ status: 'done', issues, checkedRevision: revision, activeIssueId: null }),
  setFailed: () => set({ status: 'error' }),
  setActiveIssue: (activeIssueId) => set({ activeIssueId }),
  setOptions: (options) => set((s) => ({ options: { ...s.options, ...options } })),
  clear: () => set({ status: 'idle', issues: [], checkedRevision: -1, activeIssueId: null }),
}));
