import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { useNetworkStore } from './store/useNetworkStore';
import { useSewerStore } from './store/useSewerStore';
import { useSimulationStore } from './store/useSimulationStore';
import { useSwmmStore } from './store/useSwmmStore';
import { useUIStore } from './store/useUIStore';

// 개발 서버에서만: 브라우저 콘솔·E2E 테스트에서 상태를 들여다볼 수 있게 스토어를 노출한다.
if (import.meta.env.DEV) {
  Object.assign(window, { __ogp: { network: useNetworkStore, ui: useUIStore, sim: useSimulationStore, swmm: useSwmmStore, sewer: useSewerStore } });
}

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾을 수 없습니다.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
