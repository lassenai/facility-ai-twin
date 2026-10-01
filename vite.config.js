import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, host: '0.0.0.0', strictPort: true, proxy: { '/agent': 'http://127.0.0.1:5181' } },
  preview: { port: 5180, host: '0.0.0.0', strictPort: true, proxy: { '/agent': 'http://127.0.0.1:5181' } },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('onnxruntime-web')) return 'robot-inference';
          if (id.includes('@mujoco')) return 'robot-physics';
          if (id.includes('node_modules/three/')) return 'scene';
        },
      },
    },
  },
});
