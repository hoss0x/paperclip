import config from "./playwright.config";

// Reuse the separately built UI; run against the standard throwaway instance.
export default {
  ...config,
  testMatch: "company-os.spec.ts",
  projects: config.projects?.map(project => ({
    ...project,
    use: {
      ...project.use,
      ...(process.env.PAPERCLIP_E2E_LOW_PROCESS === "1" ? {
        launchOptions: { args: ["--single-process", "--no-zygote", "--disable-gpu", "--disable-software-rasterizer", "--num-raster-threads=1", "--disable-threaded-animation", "--disable-threaded-scrolling", "--js-flags=--single-threaded"] },
      } : {}),
    },
  })),
  webServer: {
    ...config.webServer,
    command: "node --single-threaded --import ./cli/node_modules/tsx/dist/loader.mjs cli/src/index.ts onboard --yes --run",
  },
};
