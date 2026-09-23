import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Local development and local builds always use `/`. GitHub Pages opts into
  // the repository subpath explicitly in its deployment workflow.
  base: process.env.FINPUB_DEPLOY_TARGET === 'github-pages' ? '/finpub-financial-tavern/' : '/',
  plugins: [react()],
});
