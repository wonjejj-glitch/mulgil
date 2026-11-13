import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // GitHub Pages 는 https://<사용자>.github.io/<저장소>/ 아래에서 열리므로 배포 빌드에서 경로를 넘겨받는다.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        // 큰 라이브러리를 따로 묶어 앱 코드만 바뀌었을 때 브라우저 캐시를 재사용한다.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@deck.gl') || id.includes('@luma.gl') || id.includes('@loaders.gl') || id.includes('@math.gl')) return 'vendor-deck';
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-vendor')) return 'vendor-charts';
          if (id.includes('@turf') || id.includes('proj4')) return 'vendor-geo';
          if (id.includes('react')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
