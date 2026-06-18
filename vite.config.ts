import { defineConfig } from "vite";

export default defineConfig({
  server: {
    watch: {
      ignored: ["**/tools/basic_pitch_bench/.venv/**", "**/tmp/**"],
    },
  },
});
