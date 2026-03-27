import { afterEach } from "vitest";
import { applyBaseEnv } from "./test-env.js";

applyBaseEnv();

afterEach(() => {
  applyBaseEnv();
});
