import { a } from "./a.js";

export const b = (): number => (typeof a === "function" ? 1 : 0);
