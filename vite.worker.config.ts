import { defineConfig } from 'vite';

// The worker is built with forge's `main` target: CommonJS output with Node
// built-ins and dependencies left external, which is what utilityProcess.fork
// loads. https://vitejs.dev/config
export default defineConfig({});
