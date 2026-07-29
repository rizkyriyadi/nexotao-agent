import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { "@typescript-eslint/no-explicit-any": "off", "react-hooks/set-state-in-effect": "off", "react-hooks/refs": "off", "react/no-unescaped-entities": "off" } },
  // `brag-output/` is generated marketing output, vendored minified libraries
  // included. Linting a bundle nobody wrote reports style faults nobody can fix,
  // and the publish gate runs `lint` — so it blocks a release on a stranger's code.
  globalIgnores([".next/**", "node_modules/**", "brag-output/**"]),
]);
