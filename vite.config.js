import { defineConfig } from 'vite';

// En GitHub Pages la web vive en https://jbbadia.github.io/surtidor/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/surtidor/' : '/',
}));
