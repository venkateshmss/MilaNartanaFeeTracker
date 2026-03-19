import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_SHEETS_WEB_APP_URL || "";

  return {
    server: {
      proxy: target
        ? {
            "/apps-script": {
              target,
              changeOrigin: true,
              secure: true,
              rewrite: () => "",
            },
          }
        : undefined,
    },
  };
});

