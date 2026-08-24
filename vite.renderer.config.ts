import { defineConfig } from 'vite';
import { contentSecurityPolicyMetaTag } from './src/adapters/electron/contentSecurityPolicy';

// https://vitejs.dev/config
export default defineConfig(({ command }) => {
  const isDev = command === 'serve';

  return {
    plugins: [
      {
        // The CSP is injected here rather than sent as a response header: the
        // packaged app loads the renderer over file://, where a webRequest
        // header is not dependably applied, while a meta tag is part of the
        // document in both modes. One mechanism, one policy.
        name: 'zarya-csp-meta',
        transformIndexHtml: {
          order: 'post' as const,
          handler: (html: string) =>
            html.replace(
              '<head>',
              `<head>\n    ${contentSecurityPolicyMetaTag({
                isDev,
                // Vite's default dev port; overriding `server.port` means
                // updating this too.
                devServerOrigin: 'http://localhost:5173',
              })}`,
            ),
        },
      },
    ],
  };
});
